"""Durable per-repository jobs, resumable turns, and explicit human replies."""
import asyncio
import hashlib
import json
import time
import uuid
from pathlib import Path
from .appserver import AppServer
from .contracts import ACTIVE, TERMINAL, MODEL, RESULT
from .runner import account_lock, instructions, validate, validate_result, workspace_path, relative_path, process_error, QUOTA_CODE, unavailable_result
from .permissions import DEFAULT_PROFILE
from .settings import ExpertError, private_directory, require_chatgpt


def save_json(path, value):
    pending = path.with_suffix('.next')
    pending.write_text(json.dumps(value, ensure_ascii=False))
    pending.chmod(0o600)
    pending.replace(path)


class JobManager:
    def __init__(self, settings):
        self.settings = settings
        private_directory(settings.state)
        self.records = settings.state / 'jobs'
        private_directory(self.records)
        self.jobs = {}
        self.events = {}
        self.tasks = {}
        self.runtime = None
        self.runtime_lock = asyncio.Lock()
        self.mutation = asyncio.Lock()
        self.auth_lock = None
        self.last_activity = time.monotonic()
        for path in self.records.glob('*.json'):
            if path.stat().st_size > 262144:
                continue
            try:
                job = json.loads(path.read_text())
                if path.stem != job['job_id'] or job['state'] not in ACTIVE | TERMINAL:
                    continue
                self.jobs[job['job_id']] = job
                self.events[job['job_id']] = asyncio.Condition()
                job['resume_needed'] = True
                if 'permission_mode' not in job:
                    # Historical jobs ran in the source folder. Never silently
                    # resume that access under the new default-mode contract.
                    job['permission_mode'] = 'full'
                    job['execution_path'] = job['workspace_path']
                    if job['state'] == 'waiting_for_user':
                        self.finish(job, 'failed', ExpertError('PERMISSION_MODE_REQUIRED', 'This legacy job cannot resume with implicit full access. Start a new default consultation, or use full mode only if the user explicitly requests it. Saved work remains.'))
                if job['state'] == 'running' or job.get('native_request'):
                    self.finish(job, 'failed', ExpertError('SUPERVISOR_RESTARTED', 'The supervisor restarted during an active turn. Saved edits remain; inspect them before assigning more work.'))
            except (ValueError, KeyError, TypeError):
                continue

    def get(self, ident):
        if ident not in self.jobs:
            raise ExpertError('JOB_NOT_FOUND', 'No expert job has this ID.')
        return self.jobs[ident]

    def changed(self, job):
        job['revision'] += 1
        job['updated_at'] = time.time()
        save_json(self.records / (job['job_id'] + '.json'), job)
        async def notify():
            async with self.events[job['job_id']]:
                self.events[job['job_id']].notify_all()
        try:
            asyncio.get_running_loop().create_task(notify())
        except RuntimeError:
            pass

    def finish(self, job, state, error=None):
        unavailable = state == 'failed' and error and error.code == QUOTA_CODE
        job['state'] = 'unavailable' if unavailable else state
        job['request'] = None
        job['native_request'] = None
        if unavailable:
            job['unavailability'] = unavailable_result()['unavailability']
            job['error'] = None
            job['progress'] = 'Expert is not available at the moment; continue locally.'
        elif error:
            job['error'] = {'code': error.code, 'message': str(error)}
        self.changed(job)

    def view(self, job):
        result = {k: job.get(k) for k in ('job_id', 'assignment_id', 'state', 'revision', 'workspace_path',
            'created_at', 'updated_at', 'reasoning_effort', 'web_search_calls', 'progress', 'request', 'report', 'error')}
        result['model'] = MODEL
        mode = job.get('permission_mode', 'full')
        result['permission_mode'] = mode
        result['workspace_reserved'] = mode == 'full' and job['state'] in ACTIVE
        if mode == 'default':
            result['sandbox_path'] = job['execution_path']
        result['next_action'] = (
            'Pause workspace activity; call expert_status with this job_id, wait_seconds=60 and after_revision. Keep the waiting loop quiet; do not repeat running status to the user.' if job['state'] == 'running' else
            'Present request.question/options using ask_followup_question and wait for the human. Forward only their answer using expert_reply with the current request_id; keep the repository paused.' if job['state'] == 'waiting_for_user' else
            'Codex has stopped. Inspect saved edits and the report, report only validation actually performed, then resume the parent task. Cancellation/failure preserves edits.')
        if job['state'] == 'unavailable':
            result.update(unavailable_result())
        if mode == 'default':
            result['next_action'] = (
                'Call expert_status with this job_id, wait_seconds=60 and after_revision. Keep the waiting loop quiet. The expert has only web access and its artifact sandbox; the Cline repository is not reserved.' if job['state'] == 'running' else
                'Present request.question/options using ask_followup_question and wait for the human. Forward only their answer using expert_reply with the current request_id. This job stays in default mode.' if job['state'] == 'waiting_for_user' else
                'Codex has stopped. Inspect the report and sandbox_path for handover; changed_files and report_path are relative to that sandbox. Cline may copy useful artifacts into the parent task. No repository files were accessible to the expert. Saved artifacts remain.')
            if job['state'] == 'unavailable':
                result['next_action'] = unavailable_result()['next_action'] + ' Any partial artifacts are under sandbox_path, not the Cline repository.'
        return result

    async def dispatch(self, method, arguments):
        self.last_activity = time.monotonic()
        validate(method, arguments)
        if method == 'expert_status':
            job = self.get(arguments['job_id'])
            condition = self.events[job['job_id']]
            previous_revision = arguments.get('after_revision', job['revision'])
            wait_seconds = arguments.get('wait_seconds', 60)
            # Collect routine progress for the whole interval. A revision can
            # advance on every command/search; waking for each one causes a
            # new local-model turn every few seconds. Questions and terminal
            # states still return immediately, even with an old/future cursor.
            if job['state'] == 'running' and wait_seconds:
                try:
                    async with condition:
                        await asyncio.wait_for(
                            condition.wait_for(lambda: job['state'] != 'running'),
                            wait_seconds,
                        )
                except asyncio.TimeoutError:
                    pass
            if job['state'] == 'running':
                # The request already supplies the job context. Keep routine
                # waits small; actionable states below retain the full report.
                result = {'job_id': job['job_id'], 'state': 'running',
                          'revision': job['revision'],
                          'changed': job['revision'] > previous_revision}
                if result['changed'] and job.get('progress'):
                    result['progress'] = job['progress']
                return result
            return self.view(job)
        async with self.mutation:
            if method == 'consult_expert':
                return await self.start(arguments)
            if method == 'expert_reply':
                return await self.reply(arguments)
            if method == 'expert_cancel':
                return await self.cancel(self.get(arguments['job_id']))
        raise ExpertError('UNKNOWN_TOOL', 'Unknown expert tool.')

    async def start(self, arguments):
        digest = hashlib.sha256(json.dumps(arguments, sort_keys=True).encode()).hexdigest()
        for job in self.jobs.values():
            if job['assignment_id'] == arguments['assignment_id']:
                if job['packet_hash'] != digest:
                    raise ExpertError('ASSIGNMENT_CONFLICT', 'This assignment_id already belongs to a different packet; use a new ID.')
                return self.view(job)
        require_chatgpt(self.settings)
        workspace = workspace_path(arguments['workspace_path'], self.settings)
        mode = arguments.get('permission_mode', 'default')
        # Only full jobs inspect and reserve the checkout. Default jobs never
        # copy source files into their sandbox, even if context_files lists them.
        if mode == 'full':
            process = await asyncio.create_subprocess_exec('git', '-C', str(workspace), 'rev-parse', '--show-toplevel',
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            stdout, _ = await asyncio.wait_for(process.communicate(), 5)
            if process.returncode == 0:
                workspace = workspace_path(stdout.decode().strip(), self.settings)
        for job in self.jobs.values():
            if mode == 'full' and job.get('permission_mode', 'full') == 'full' and job['state'] in ACTIVE and (Path(job['workspace_path']) == workspace or Path(job['workspace_path']) in workspace.parents or workspace in Path(job['workspace_path']).parents):
                raise ExpertError('WORKSPACE_BUSY', 'An expert assignment already owns this repository: ' + job['job_id'])
        ident = str(uuid.uuid4())
        execution = workspace
        if mode == 'default':
            sandboxes = self.settings.state / 'sandboxes'
            private_directory(sandboxes)
            execution = sandboxes / ident
            private_directory(execution)
        if arguments.get('report_path'):
            path = relative_path(arguments['report_path'], execution)
            if path.suffix.lower() != '.md':
                raise ExpertError('INVALID_REPORT_PATH', 'Optional report_path must be a relative .md path.')
        job = {'job_id': ident, 'assignment_id': arguments['assignment_id'], 'packet_hash': digest,
               'packet': arguments, 'workspace_path': str(workspace), 'state': 'running', 'revision': 0,
               'permission_mode': mode, 'execution_path': str(execution),
               'created_at': time.time(), 'reasoning_effort': arguments['reasoning_effort'],
               'web_search_calls': 0, 'thread_id': None, 'turn_id': None, 'turn_count': 0,
               'active_seconds': 0, 'progress': 'Starting the delegated assignment.',
               'request': None, 'native_request': None, 'report': None, 'error': None,
               'last_reply': None, 'cancel_requested': False}
        self.jobs[ident] = job
        self.events[ident] = asyncio.Condition()
        self.changed(job)
        self.tasks[ident] = asyncio.create_task(self.work(job, 'Delegated assignment packet:\n' + json.dumps(arguments)))
        return self.view(job)

    async def ensure_runtime(self):
        async with self.runtime_lock:
            if self.runtime and not self.runtime.closing and self.runtime.process.returncode is None:
                return self.runtime
            require_chatgpt(self.settings)
            if self.runtime:
                await self.runtime.close()
            if not self.auth_lock:
                self.auth_lock = account_lock(self.settings)
                try:
                    self.auth_lock.__enter__()
                except BaseException:
                    self.auth_lock = None
                    raise
            self.runtime = AppServer(self.settings, self.notification, self.runtime_lost)
            try:
                await self.runtime.start()
            except BaseException:
                await self.release_runtime()
                raise
            return self.runtime

    async def work(self, job, prompt):
        try:
            runtime = await self.ensure_runtime()
            if job['cancel_requested']:
                self.finish(job, 'cancelled')
                return
            mode = job['permission_mode']
            config = {'web_search': 'live', 'model_reasoning_effort': job['reasoning_effort']}
            thread_params = {'model': MODEL, 'cwd': job['execution_path'], 'approvalPolicy': 'never',
                             'developerInstructions': instructions(mode), 'config': config}
            if mode == 'default':
                config['default_permissions'] = DEFAULT_PROFILE
            else:
                thread_params['sandbox'] = 'workspace-write'
                config['sandbox_workspace_write.network_access'] = True
            response = None
            if not job['thread_id']:
                response = await runtime.request('thread/start', {**thread_params, 'modelProvider': 'openai', 'ephemeral': False})
                job['thread_id'] = response['thread']['id']
            elif job.pop('resume_needed', False):
                response = await runtime.request('thread/resume', {**thread_params, 'threadId': job['thread_id']})
            if mode == 'default' and response is not None and response.get('activePermissionProfile', {}).get('id') != DEFAULT_PROFILE:
                raise ExpertError('SANDBOX_UNAVAILABLE', 'The runtime did not confirm the restricted default permission profile; no expert turn was started.')
            self.changed(job)
            if job['cancel_requested']:
                self.finish(job, 'cancelled')
                return
            job['turn_count'] += 1
            if job['turn_count'] > 12:
                raise ExpertError('TURN_LIMIT', 'The assignment exceeded 12 clarification turns; inspect saved work and narrow the subgoal.')
            job['final_text'] = ''
            job['turn_error'] = None
            job['turn_starting'] = True
            self.changed(job)
            turn_params = {'threadId': job['thread_id'], 'model': MODEL,
                'cwd': job['execution_path'], 'effort': job['reasoning_effort'], 'approvalPolicy': 'never',
                'input': [{'type': 'text', 'text': prompt}], 'outputSchema': RESULT}
            if mode == 'full':
                turn_params['sandboxPolicy'] = {'type': 'workspaceWrite', 'writableRoots': [job['execution_path']],
                    'networkAccess': True, 'excludeSlashTmp': False, 'excludeTmpdirEnvVar': False}
            # Omitting the legacy sandboxPolicy in default mode preserves the
            # selected profile's read restrictions on every continuation turn.
            response = await runtime.request('turn/start', turn_params)
            job['turn_starting'] = False
            job['turn_id'] = response['turn']['id']
            self.changed(job)
            clock = time.monotonic()
            while job['state'] in ACTIVE and job.get('turn_id') and not job.get('turn_finished'):
                await asyncio.sleep(0.25)
                now = time.monotonic()
                if job['state'] == 'running':
                    job['active_seconds'] += now - clock
                clock = now
                if job['active_seconds'] >= self.settings.timeout:
                    await self.stop_turn(job)
                    await self.clean_commands(job)
                    self.finish(job, 'failed', ExpertError('EXPERT_TIMEOUT', 'The assignment exceeded its active-time limit; saved edits remain. Human waiting time is excluded.'))
                    return
                if job['cancel_requested']:
                    await self.stop_turn(job)
                    await self.clean_commands(job)
                    self.finish(job, 'cancelled')
                    return
            await self.clean_commands(job)
            if job['state'] in ACTIVE:
                if job['cancel_requested']:
                    self.finish(job, 'cancelled')
                else:
                    self.apply_outcome(job)
            job['turn_finished'] = False
            job['turn_id'] = None
            self.changed(job)
        except asyncio.CancelledError:
            raise
        except ExpertError as exc:
            if job['state'] not in TERMINAL:
                await self.abort_uncertain_turn(job)
                self.finish(job, 'failed', exc)
        except Exception:
            if job['state'] not in TERMINAL:
                await self.abort_uncertain_turn(job)
                self.finish(job, 'failed', ExpertError('EXPERT_FAILED', 'The expert session failed; saved edits remain. Private diagnostics are withheld.'))
        finally:
            # Running tasks are retained until termination, so cancel/status cannot release early.
            job.pop('final_text', None)
            if job['state'] in TERMINAL:
                self.changed(job)

    async def notification(self, message):
        params = message.get('params', {})
        method = message.get('method')
        job = next((j for j in self.jobs.values() if j.get('thread_id') == params.get('threadId') and j['state'] in ACTIVE), None)
        if 'id' in message:
            # Structured end-of-turn questions are the supported portable clarification path.
            # Fail closed if an unexpected approval request appears despite approvalPolicy=never.
            if method == 'item/tool/requestUserInput' and job:
                if len(params.get('questions', [])) == 1 and not params['questions'][0].get('isSecret'):
                    q = params['questions'][0]
                    request_id = str(uuid.uuid4())
                    asyncio.create_task(self.publish_native_question(job, message['id'], q, request_id))
                    return
            if method in ('item/commandExecution/requestApproval', 'item/fileChange/requestApproval'):
                await self.runtime.send({'id': message['id'], 'result': {'decision': 'decline'}})
            else:
                await self.runtime.send({'id': message['id'], 'error': {'code': -32601, 'message': 'This request is not enabled by the expert bridge.'}})
            return
        if not job:
            return
        if method == 'error':
            # Some runtime versions emit the reason separately from turn/completed.
            if not job.get('turn_id') or params.get('turnId', job['turn_id']) == job['turn_id']:
                error = process_error(params.get('error', {}))
                job['turn_error'] = {'code': error.code, 'message': str(error)}
        elif method == 'item/completed':
            item = params.get('item', {})
            if item.get('type') == 'webSearch':
                job['web_search_calls'] += 1
                job['progress'] = 'Consulted web sources.'
                self.changed(job)
            elif item.get('type') == 'agentMessage' and item.get('phase') != 'commentary':
                job['final_text'] = item.get('text', '')[:26000]
            elif item.get('type') in ('fileChange', 'commandExecution'):
                job['progress'] = 'Updated source files.' if item['type'] == 'fileChange' else 'Ran a workspace command.'
                self.changed(job)
        elif method == 'turn/completed':
            turn = params['turn']
            if turn['id'] == job.get('last_finished_turn'):
                return
            if job.get('turn_id') and turn['id'] != job['turn_id']:
                return
            job['last_finished_turn'] = turn['id']
            job['turn_finished'] = True
            items = [i for i in turn.get('items', []) if i.get('type') == 'agentMessage' and i.get('phase') != 'commentary']
            text = items[-1]['text'] if items else job.get('final_text', '')
            job['turn_outcome'] = {'status': turn['status'], 'error': turn.get('error') or job.get('turn_error'), 'text': text[:26000]}

    def apply_outcome(self, job):
        outcome = job.pop('turn_outcome', {})
        if outcome.get('status') != 'completed':
            self.finish(job, 'failed', process_error(outcome.get('error', {})))
            return
        try:
            result = json.loads(outcome['text'])
            validate_result(result, Path(job['execution_path']))
            job['report'] = result
            if result['disposition'] == 'needs_user_input':
                job['request'] = {'request_id': str(uuid.uuid4()), **result['user_question']}
                job['state'] = 'waiting_for_user'
                job['progress'] = 'Waiting for a human clarification; command sessions are stopped.'
                self.changed(job)
            elif result['disposition'] == 'blocked':
                self.finish(job, 'failed', ExpertError('EXPERT_BLOCKED', 'Codex could not finish the subgoal; see report.summary and remaining_issues. Saved edits remain.'))
            else:
                self.finish(job, 'completed')
        except (ValueError, KeyError, ExpertError) as exc:
            self.finish(job, 'failed', exc if isinstance(exc, ExpertError) else ExpertError('INVALID_EXPERT_OUTPUT', 'Codex returned an invalid final report; saved edits remain.'))

    async def clean_commands(self, job):
        if not self.runtime or not job.get('thread_id'):
            return
        runtime = self.runtime
        try:
            await runtime.request('thread/backgroundTerminals/clean', {'threadId': job['thread_id']})
            remaining = await runtime.request('thread/backgroundTerminals/list', {'threadId': job['thread_id']})
            if remaining.get('data') or remaining.get('nextCursor'):
                raise ExpertError('COMMAND_CLEANUP_FAILED', 'Background commands could not be stopped.')
            job['commands_stopped'] = True
        except ExpertError:
            await self.release_runtime()
            await self.runtime_lost(ExpertError('COMMAND_CLEANUP_FAILED', 'Codex had to stop because command cleanup could not be confirmed. Saved edits remain.'))

    async def publish_native_question(self, job, rpc_id, question, request_id):
        await self.clean_commands(job)
        if job['state'] not in ACTIVE or job['cancel_requested']:
            return
        job['native_request'] = {'rpc_id': rpc_id, 'question_id': question['id']}
        job['request'] = {'request_id': request_id, 'question': question['question'], 'options': question.get('options') or []}
        job['state'] = 'waiting_for_user'
        self.changed(job)

    async def reply(self, arguments):
        job = self.get(arguments['job_id'])
        last = job.get('last_reply')
        if last and last['request_id'] == arguments['request_id']:
            if last['answer'] != arguments['answer']:
                raise ExpertError('REPLY_CONFLICT', 'This clarification already received a different answer.')
            return self.view(job)
        if job['state'] != 'waiting_for_user' or not job['request'] or job['request']['request_id'] != arguments['request_id']:
            raise ExpertError('STALE_REQUEST', 'This request is no longer pending; get the current expert_status before replying.')
        require_chatgpt(self.settings)
        task = self.tasks.get(job['job_id'])
        if not job.get('native_request') and task and not task.done():
            # The terminal notification can arrive just before the worker finishes its bookkeeping.
            await task
        request = job['request']
        native = job['native_request']
        job['last_reply'] = {'request_id': arguments['request_id'], 'answer': arguments['answer']}
        job['request'] = None
        job['native_request'] = None
        job['state'] = 'running'
        job['progress'] = 'Continuing with the human answer.'
        self.changed(job)
        if native:
            await self.runtime.send({'id': native['rpc_id'], 'result': {'answers': {native['question_id']: {'answers': [arguments['answer']]}}}})
        else:
            if not self.runtime:
                job['resume_needed'] = True
            prompt = 'The user answered the pending clarification. Continue this SAME assignment and session.\n' + json.dumps({'question': request, 'human_answer': arguments['answer']})
            self.tasks[job['job_id']] = asyncio.create_task(self.work(job, prompt))
        return self.view(job)

    async def abort_uncertain_turn(self, job):
        if job.get('turn_starting'):
            await self.release_runtime()
            await self.runtime_lost(ExpertError('RUNTIME_STOPPED', 'An unacknowledged turn required stopping Codex; saved edits remain.'))
        elif job.get('turn_id') and not job.get('turn_finished'):
            await self.stop_turn(job)
            await self.clean_commands(job)

    async def stop_turn(self, job):
        if self.runtime and job.get('turn_id') and not job.get('turn_finished'):
            try:
                await self.runtime.request('turn/interrupt', {'threadId': job['thread_id'], 'turnId': job['turn_id']})
                for _ in range(40):
                    if job.get('turn_finished'):
                        return
                    await asyncio.sleep(0.25)
            except ExpertError:
                pass
            # No stopped state is reported while a disconnected runtime might still write.
            await self.release_runtime()
            await self.runtime_lost(ExpertError('RUNTIME_STOPPED', 'Codex had to stop to cancel a turn. Saved edits remain.'))

    async def cancel(self, job):
        if job['state'] in TERMINAL:
            return self.view(job)
        job['cancel_requested'] = True
        task = self.tasks.get(job['job_id'])
        if task and not task.done():
            # work() handles start/interrupt races; it owns the active command lifetime.
            await task
        if job['state'] not in TERMINAL:
            self.finish(job, 'cancelled')
        return self.view(job)

    async def runtime_lost(self, error):
        # Kill/reap before releasing a workspace, including malformed protocol/EOF.
        if self.runtime:
            await self.release_runtime()
        for job in self.jobs.values():
            if job['state'] == 'running' or job.get('native_request'):
                self.finish(job, 'cancelled' if job['cancel_requested'] else 'failed', None if job['cancel_requested'] else error)
            elif job['state'] == 'waiting_for_user':
                job['resume_needed'] = True
                self.changed(job)

    async def release_runtime(self):
        runtime = self.runtime
        if runtime:
            await runtime.close()
            if self.runtime is runtime:
                self.runtime = None

    async def close(self):
        for task in self.tasks.values():
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        await self.release_runtime()
        if self.auth_lock:
            self.auth_lock.__exit__(None, None, None)
            self.auth_lock = None
