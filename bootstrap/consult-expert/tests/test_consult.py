"""Behavior checks through real subprocesses and durable supervisor state."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, AsyncMock
from consult_expert.contracts import INPUT
from consult_expert.runner import validate, local_path, workspace_path, relative_path, validate_result, process_error, QUOTA_CODE
from consult_expert.settings import Settings, ExpertError, require_chatgpt, codex_environment
from consult_expert.jobs import JobManager
from consult_expert.client import exchange
from consult_expert.appserver import AppServer


def packet(workspace, ident='test-assignment', mode='full'):
    return {'assignment_id': ident, 'workspace_path': str(workspace), 'permission_mode': mode,
        'user_objective': 'Improve an existing application.', 'subgoal': 'Fix one diagnosed defect.',
        'acceptance_criteria': ['Verify the saved result.'], 'research_summary': 'The code uses a blocking call.',
        'attempted_approaches': [], 'uncertainty': 'The correct fix needs expert investigation.', 'reasoning_effort': 'xhigh'}


class Fixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration = 2
        self.temp = tempfile.TemporaryDirectory(prefix='expert-tests-')
        self.base = Path(self.temp.name)
        self.workspace = self.base / 'repo'
        self.workspace.mkdir()
        (self.workspace / 'existing.txt').write_text('user dirty work\n')
        auth = self.base / 'config/codex'
        auth.mkdir(parents=True)
        (auth / 'auth.json').write_text(json.dumps({'auth_mode': 'chatgpt', 'tokens': {'access_token': 'fixture', 'refresh_token': 'fixture'}}))
        codex = self.base / 'codex'
        shutil.copyfile(Path(__file__).with_name('fake_codex.py'), codex)
        codex.chmod(0o700)
        self.settings = Settings(auth_home=auth, codex=codex, state=self.base / 'state', workspace_roots=(self.base,), timeout=30)
        self.manager = JobManager(self.settings)

    async def asyncTearDown(self):
        await self.manager.close()
        self.temp.cleanup()

    def scenario(self, value):
        (self.workspace / '.scenario').write_text(value)

    async def wait(self, manager, ident, states):
        for _ in range(80):
            value = await manager.dispatch('expert_status', {'job_id': ident, 'wait_seconds': 1})
            if value['state'] in states:
                return value
            await asyncio.sleep(0.05)
        self.fail('Job did not reach ' + str(states))

    async def test_edits_same_dirty_workspace_and_returns_short_report(self):
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        self.assertEqual(start['state'], 'running')
        result = await self.wait(self.manager, start['job_id'], {'completed', 'failed'})
        self.assertEqual(result['state'], 'completed', result)
        self.assertEqual((self.workspace / 'existing.txt').read_text(), 'user dirty work\n')
        self.assertEqual((self.workspace / 'expert.txt').read_text(), 'completed after actual work\n')
        self.assertEqual(result['report']['changed_files'], ['expert.txt'])
        self.assertEqual(result['web_search_calls'], 1)
        self.assertFalse(result['workspace_reserved'])

    async def test_omitted_mode_uses_private_persistent_sandbox_and_handover(self):
        request = packet(self.workspace)
        request.pop('permission_mode')
        request['context_files'] = ['existing.txt']
        requests = []
        original = AppServer.request

        async def record(runtime, method, params):
            requests.append((method, params))
            return await original(runtime, method, params)

        with patch.object(AppServer, 'request', record):
            start = await self.manager.dispatch('consult_expert', request)
            result = await self.wait(self.manager, start['job_id'], {'completed', 'failed'})
        self.assertEqual(result['state'], 'completed', result)
        self.assertEqual(result['permission_mode'], 'default')
        self.assertFalse(start['workspace_reserved'])
        sandbox = Path(result['sandbox_path'])
        self.assertEqual(sandbox, self.settings.state / 'sandboxes' / start['job_id'])
        self.assertEqual(sandbox.stat().st_mode & 0o777, 0o700)
        self.assertFalse((sandbox / 'existing.txt').exists())
        self.assertFalse((self.workspace / 'expert.txt').exists())
        self.assertEqual((sandbox / 'expert.txt').read_text(), 'completed after actual work\n')
        for method, params in requests:
            if method == 'thread/start':
                self.assertEqual(params['cwd'], str(sandbox))
                self.assertEqual(params['config']['default_permissions'], 'consult-expert-default')
                self.assertNotIn('sandbox', params)
                self.assertIn('user must explicitly request full mode', params['developerInstructions'])
            if method == 'turn/start':
                self.assertEqual(params['cwd'], str(sandbox))
                self.assertNotIn('sandboxPolicy', params)
        await self.manager.close()
        self.manager = JobManager(self.settings)
        self.assertEqual(self.manager.view(self.manager.get(start['job_id']))['sandbox_path'], str(sandbox))
        self.assertTrue((sandbox / 'expert.txt').exists())

    async def test_default_resume_preserves_profile_sandbox_and_mode(self):
        start = await self.manager.dispatch('consult_expert', packet(self.workspace, mode='default'))
        await self.wait(self.manager, start['job_id'], {'completed'})
        # Use a second fixture job to exercise a structured clarification/resume.
        original = AppServer.request
        requests = []

        async def record(runtime, method, params):
            requests.append((method, params))
            if method == 'thread/start':
                (Path(params['cwd']) / '.scenario').write_text('question')
            return await original(runtime, method, params)

        with patch.object(AppServer, 'request', record):
            start = await self.manager.dispatch('consult_expert', packet(self.workspace, 'default-resume', mode='default'))
            question = await self.wait(self.manager, start['job_id'], {'waiting_for_user'})
            sandbox = question['sandbox_path']
            await self.manager.close()
            self.manager = JobManager(self.settings)
            await self.manager.dispatch('expert_reply', {'job_id': start['job_id'],
                'request_id': question['request']['request_id'], 'answer': 'Text'})
            result = await self.wait(self.manager, start['job_id'], {'completed', 'failed'})
        self.assertEqual(result['state'], 'completed', result)
        self.assertEqual(result['sandbox_path'], sandbox)
        for method, params in requests:
            if method in ('thread/start', 'thread/resume'):
                self.assertEqual(params['config']['default_permissions'], 'consult-expert-default')
                self.assertNotIn('sandbox', params)
            if method == 'turn/start':
                self.assertNotIn('sandboxPolicy', params)

    async def test_default_profile_confirmation_required_before_turn(self):
        original = AppServer.request
        turns = []

        async def record(runtime, method, params):
            response = await original(runtime, method, params)
            if method == 'thread/start':
                response.pop('activePermissionProfile', None)
            if method == 'turn/start':
                turns.append(params)
            return response

        with patch.object(AppServer, 'request', record):
            start = await self.manager.dispatch('consult_expert', packet(self.workspace, mode='default'))
            result = await self.wait(self.manager, start['job_id'], {'failed'})
        self.assertEqual(result['error']['code'], 'SANDBOX_UNAVAILABLE')
        self.assertEqual(turns, [])

    async def test_modes_do_not_change_on_retry_and_default_does_not_reserve_repo(self):
        self.scenario('hold')
        full = await self.manager.dispatch('consult_expert', packet(self.workspace))
        default = await self.manager.dispatch('consult_expert', packet(self.workspace, 'research', mode='default'))
        self.assertFalse(default['workspace_reserved'])
        self.assertTrue(full['workspace_reserved'])
        self.assertNotIn('sandbox_path', full)
        with self.assertRaises(ExpertError) as error:
            await self.manager.dispatch('consult_expert', packet(self.workspace, 'research', mode='full'))
        self.assertEqual(error.exception.code, 'ASSIGNMENT_CONFLICT')
        await self.manager.dispatch('expert_cancel', {'job_id': full['job_id']})

    async def test_legacy_pending_full_access_cannot_silently_resume(self):
        self.scenario('question')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        await self.wait(self.manager, start['job_id'], {'waiting_for_user'})
        await self.manager.close()
        record = self.settings.state / 'jobs' / (start['job_id'] + '.json')
        old = json.loads(record.read_text())
        old.pop('permission_mode')
        old.pop('execution_path')
        record.write_text(json.dumps(old))
        self.manager = JobManager(self.settings)
        job = self.manager.get(start['job_id'])
        self.assertEqual(job['state'], 'failed')
        self.assertEqual(job['error']['code'], 'PERMISSION_MODE_REQUIRED')
        self.assertFalse(self.manager.view(job)['workspace_reserved'])

    async def test_idempotent_start_and_assignment_conflict(self):
        first = await self.manager.dispatch('consult_expert', packet(self.workspace))
        second = await self.manager.dispatch('consult_expert', packet(self.workspace))
        self.assertEqual(first['job_id'], second['job_id'])
        changed = packet(self.workspace)
        changed['subgoal'] = 'Another outcome'
        with self.assertRaises(ExpertError) as error:
            await self.manager.dispatch('consult_expert', changed)
        self.assertEqual(error.exception.code, 'ASSIGNMENT_CONFLICT')

    async def test_repository_reservation(self):
        self.scenario('hold')
        subprocess.run(['git', 'init', '-q', str(self.workspace)], check=True)
        child = self.workspace / 'subfolder'
        child.mkdir()
        start = await self.manager.dispatch('consult_expert', packet(child))
        self.assertEqual(start['workspace_path'], str(self.workspace))
        with self.assertRaises(ExpertError) as error:
            await self.manager.dispatch('consult_expert', packet(self.workspace, 'another'))
        self.assertEqual(error.exception.code, 'WORKSPACE_BUSY')
        await self.manager.dispatch('expert_cancel', {'job_id': start['job_id']})

    async def test_question_reply_same_session_and_duplicate_safe(self):
        self.scenario('question')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        question = await self.wait(self.manager, start['job_id'], {'waiting_for_user', 'failed'})
        self.assertEqual(question['state'], 'waiting_for_user', question)
        thread = self.manager.get(start['job_id'])['thread_id']
        reply = {'job_id': start['job_id'], 'request_id': question['request']['request_id'], 'answer': 'Text please.'}
        await self.manager.dispatch('expert_reply', reply)
        await self.manager.dispatch('expert_reply', reply)
        final = await self.wait(self.manager, start['job_id'], {'completed', 'failed'})
        self.assertEqual(final['state'], 'completed', final)
        self.assertEqual(thread, self.manager.get(start['job_id'])['thread_id'])
        with self.assertRaises(ExpertError) as error:
            await self.manager.dispatch('expert_reply', {**reply, 'answer': 'Different answer'})
        self.assertEqual(error.exception.code, 'REPLY_CONFLICT')

    async def test_stale_reply_cannot_resume(self):
        self.scenario('question')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        await self.wait(self.manager, start['job_id'], {'waiting_for_user'})
        with self.assertRaises(ExpertError) as error:
            await self.manager.dispatch('expert_reply', {'job_id': start['job_id'], 'request_id': 'stale', 'answer': 'Text'})
        self.assertEqual(error.exception.code, 'STALE_REQUEST')
        self.assertEqual(self.manager.get(start['job_id'])['state'], 'waiting_for_user')

    async def test_waiting_question_survives_supervisor_restart_and_resumes(self):
        self.scenario('question')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        question = await self.wait(self.manager, start['job_id'], {'waiting_for_user'})
        await self.manager.close()
        self.manager = JobManager(self.settings)
        restored = self.manager.get(start['job_id'])
        self.assertEqual(restored['request']['request_id'], question['request']['request_id'])
        await self.manager.dispatch('expert_reply', {'job_id': start['job_id'], 'request_id': question['request']['request_id'], 'answer': 'Text'})
        result = await self.wait(self.manager, start['job_id'], {'completed', 'failed'})
        self.assertEqual(result['state'], 'completed', result)

    async def test_network_access_survives_resume_without_expanding_workspace_permissions(self):
        self.scenario('question')
        requests = []
        original = AppServer.request

        async def record(runtime, method, params):
            if method in ('thread/start', 'thread/resume', 'turn/start'):
                requests.append((method, params))
            return await original(runtime, method, params)

        with patch.object(AppServer, 'request', record):
            start = await self.manager.dispatch('consult_expert', packet(self.workspace))
            question = await self.wait(self.manager, start['job_id'], {'waiting_for_user'})
            await self.manager.close()
            self.manager = JobManager(self.settings)
            await self.manager.dispatch('expert_reply', {'job_id': start['job_id'],
                'request_id': question['request']['request_id'], 'answer': 'Text'})
            result = await self.wait(self.manager, start['job_id'], {'completed', 'failed'})
        self.assertEqual(result['state'], 'completed', result)
        self.assertEqual([method for method, _ in requests],
                         ['thread/start', 'turn/start', 'thread/resume', 'turn/start'])
        for method, params in requests:
            self.assertEqual(params['approvalPolicy'], 'never')
            if method == 'turn/start':
                self.assertEqual(params['sandboxPolicy']['type'], 'workspaceWrite')
                self.assertEqual(params['sandboxPolicy']['writableRoots'], [str(self.workspace)])
                self.assertTrue(params['sandboxPolicy']['networkAccess'])
            else:
                self.assertEqual(params['sandbox'], 'workspace-write')
                self.assertTrue(params['config']['sandbox_workspace_write.network_access'])

    async def test_native_question_forwarded_without_auto_choice(self):
        self.scenario('native')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        question = await self.wait(self.manager, start['job_id'], {'waiting_for_user', 'failed'})
        self.assertEqual(question['state'], 'waiting_for_user', question)
        await asyncio.sleep(0.3)
        self.assertEqual(self.manager.get(start['job_id'])['state'], 'waiting_for_user')
        await self.manager.dispatch('expert_reply', {'job_id': start['job_id'], 'request_id': question['request']['request_id'], 'answer': 'Text'})
        result = await self.wait(self.manager, start['job_id'], {'completed', 'failed'})
        self.assertEqual(result['state'], 'completed', result)

    async def test_cancel_interrupts_and_keeps_partial_edits(self):
        self.scenario('hold')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        for _ in range(100):
            if (self.workspace / 'expert.txt').exists():
                break
            await asyncio.sleep(0.03)
        result = await self.manager.dispatch('expert_cancel', {'job_id': start['job_id']})
        self.assertEqual(result['state'], 'cancelled', result)
        self.assertFalse(result['workspace_reserved'])
        self.assertEqual((self.workspace / 'expert.txt').read_text(), 'partial saved edit\n')
        repeated = await self.manager.dispatch('expert_cancel', {'job_id': start['job_id']})
        self.assertEqual(repeated['state'], 'cancelled')

    async def test_cancel_during_start(self):
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.manager.dispatch('expert_cancel', {'job_id': start['job_id']})
        self.assertEqual(result['state'], 'cancelled')

    async def test_runtime_crash_preserves_work_and_fails(self):
        self.scenario('crash')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.wait(self.manager, start['job_id'], {'failed'})
        self.assertEqual(result['error']['code'], 'RUNTIME_DISCONNECTED')
        self.assertTrue((self.workspace / 'expert.txt').exists())

    async def test_invalid_final_report_fails_without_discarding_work(self):
        self.scenario('bad')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.wait(self.manager, start['job_id'], {'failed'})
        self.assertEqual(result['error']['code'], 'INVALID_EXPERT_OUTPUT')
        self.assertTrue((self.workspace / 'expert.txt').exists())

    async def test_background_command_stopped_before_completion(self):
        self.scenario('background')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.wait(self.manager, start['job_id'], {'completed', 'failed'})
        self.assertEqual(result['state'], 'completed', result)
        self.assertTrue(self.manager.get(start['job_id'])['commands_stopped'])
        await asyncio.sleep(1.1)
        self.assertFalse((self.workspace / 'late.txt').exists())

    async def test_cleanup_failure_kills_runtime_before_workspace_release(self):
        self.scenario('cleanup_failure')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.wait(self.manager, start['job_id'], {'completed', 'failed'})
        self.assertEqual(result['state'], 'failed', result)
        self.assertEqual(result['error']['code'], 'COMMAND_CLEANUP_FAILED')
        self.assertIsNone(self.manager.runtime)
        await asyncio.sleep(1.1)
        self.assertFalse((self.workspace / 'late.txt').exists())

    async def test_technical_blocker_is_failed_with_report_and_no_question(self):
        self.scenario('blocked')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.wait(self.manager, start['job_id'], {'completed', 'failed'})
        self.assertEqual(result['state'], 'failed', result)
        self.assertEqual(result['error']['code'], 'EXPERT_BLOCKED')
        self.assertEqual(result['report']['disposition'], 'blocked')
        self.assertIsNone(result['request'])

    async def test_duplicate_turn_notification_does_not_replace_pending_question(self):
        self.scenario('question')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        question = await self.wait(self.manager, start['job_id'], {'waiting_for_user'})
        job = self.manager.get(start['job_id'])
        await self.manager.notification({'method': 'turn/completed', 'params': {'threadId': job['thread_id'],
            'turn': {'id': job['last_finished_turn'], 'status': 'completed', 'items': []}}})
        self.assertEqual(question['request']['request_id'], job['request']['request_id'])

    def assert_unavailable(self, result):
        self.assertEqual(result['state'], 'unavailable', result)
        self.assertFalse(result['expert_available'])
        self.assertFalse(result['workspace_reserved'])
        self.assertIsNone(result['error'])
        self.assertIsNone(result.get('request'))
        self.assertEqual(result['unavailability']['code'], QUOTA_CODE)
        self.assertIn('continue the parent task with local Qwen', result['next_action'])
        self.assertIn('Do not automatically retry', result['next_action'])
        self.assertNotIn('private fixture quota canary', json.dumps(result))

    async def test_usage_limit_before_thread_starts_is_normal_unavailable(self):
        self.scenario('quota_start')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.wait(self.manager, start['job_id'], {'unavailable', 'failed'})
        self.assert_unavailable(result)
        self.assertFalse((self.workspace / 'expert.txt').exists())

    async def test_rate_limit_turn_rpc_is_unavailable_after_runtime_stops(self):
        self.scenario('quota_rpc')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.wait(self.manager, start['job_id'], {'unavailable', 'failed'})
        self.assert_unavailable(result)
        self.assertIsNone(self.manager.runtime)

    async def test_usage_limit_during_work_cleans_commands_and_preserves_partial_edits(self):
        self.scenario('quota_during')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.wait(self.manager, start['job_id'], {'unavailable', 'failed'})
        self.assert_unavailable(result)
        self.assertTrue(self.manager.get(start['job_id'])['commands_stopped'])
        self.assertEqual((self.workspace / 'expert.txt').read_text(), 'partial saved edit\n')
        self.assertEqual((self.workspace / 'existing.txt').read_text(), 'user dirty work\n')
        await asyncio.sleep(1.1)
        self.assertFalse((self.workspace / 'late.txt').exists())

    async def test_usage_limit_in_separate_error_event_is_recognized(self):
        self.scenario('quota_event')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.wait(self.manager, start['job_id'], {'unavailable', 'failed'})
        self.assert_unavailable(result)

    async def test_usage_limit_after_human_reply_releases_reservation(self):
        self.scenario('quota_reply')
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        question = await self.wait(self.manager, start['job_id'], {'waiting_for_user', 'failed'})
        self.assertEqual(question['state'], 'waiting_for_user', question)
        await self.manager.dispatch('expert_reply', {'job_id': start['job_id'],
            'request_id': question['request']['request_id'], 'answer': 'Text please.'})
        result = await self.wait(self.manager, start['job_id'], {'unavailable', 'failed'})
        self.assert_unavailable(result)
        await asyncio.sleep(1.1)
        self.assertFalse((self.workspace / 'late.txt').exists())

    async def test_unavailable_persists_and_identical_start_does_not_retry(self):
        self.scenario('quota_start')
        request = packet(self.workspace)
        start = await self.manager.dispatch('consult_expert', request)
        await self.wait(self.manager, start['job_id'], {'unavailable'})
        await self.manager.close()
        self.manager = JobManager(self.settings)
        result = await self.manager.dispatch('consult_expert', request)
        self.assert_unavailable(result)
        self.assertEqual(result['job_id'], start['job_id'])
        self.assertIsNone(self.manager.runtime)

    async def test_quota_is_not_mcp_error_but_authentication_failure_is(self):
        from consult_expert import server
        with patch.object(server.Settings, 'load', return_value=self.settings):
            with patch.object(server, 'call', AsyncMock(side_effect=ExpertError(QUOTA_CODE, 'private fixture quota canary'))):
                result = await server.call_tool('expert_status', {'job_id': 'fixture'})
                self.assertFalse(result.isError)
                self.assert_unavailable(json.loads(result.content[0].text))
            with patch.object(server, 'call', AsyncMock(side_effect=ExpertError('AUTH_EXPIRED', 'Sign in outside Cline.'))):
                result = await server.call_tool('expert_status', {'job_id': 'fixture'})
                self.assertTrue(result.isError)
                self.assertEqual(json.loads(result.content[0].text)['code'], 'AUTH_EXPIRED')

    async def test_quota_code_variants_and_other_errors_classified_separately(self):
        for value in ('UsageLimitExceeded', 'usageLimitExceeded', 'usage_limit_exceeded',
                      'RateLimitExceeded', 'rate_limit_exceeded', 'Usage limit reached',
                      {'codexErrorInfo': {'httpConnectionFailed': {'httpStatusCode': 429}}}):
            self.assertEqual(process_error(value).code, QUOTA_CODE, value)
        self.assertEqual(process_error({'codexErrorInfo': 'unauthorized'}).code, 'AUTH_EXPIRED')
        self.assertEqual(process_error({'codexErrorInfo': 'sandboxError'}).code, 'EXPERT_FAILED')

    async def test_long_poll_returns_latest_revision(self):
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.manager.dispatch('expert_status', {'job_id': start['job_id'], 'after_revision': start['revision'], 'wait_seconds': 1})
        self.assertGreater(result['revision'], start['revision'])

    def status_fixture(self, state='running'):
        job = {'job_id': 'poll-fixture', 'state': state, 'revision': 1}
        self.manager.jobs[job['job_id']] = job
        self.manager.events[job['job_id']] = asyncio.Condition()
        return job

    async def test_status_collects_progress_without_shortening_interval(self):
        job = self.status_fixture()
        async def progress():
            for _ in range(8):
                await asyncio.sleep(0.08)
                job['progress'] = 'Ran a workspace command.'
                self.manager.changed(job)
        updates = asyncio.create_task(progress())
        clock = asyncio.get_running_loop().time()
        # An already stale cursor must not bypass the requested wait either.
        result = await self.manager.dispatch('expert_status',
            {'job_id': job['job_id'], 'wait_seconds': 1, 'after_revision': 0})
        elapsed = asyncio.get_running_loop().time() - clock
        await updates
        self.assertGreaterEqual(elapsed, 0.85)
        self.assertLess(elapsed, 1.7)
        self.assertEqual(result['state'], 'running')
        self.assertEqual(result['revision'], 9)

    async def test_status_default_wait_wakes_promptly_for_each_actionable_state(self):
        for state in ('completed', 'failed', 'cancelled', 'unavailable', 'waiting_for_user'):
            job = self.status_fixture()
            async def transition():
                await asyncio.sleep(0.05)
                job['state'] = state
                self.manager.changed(job)
            change = asyncio.create_task(transition())
            clock = asyncio.get_running_loop().time()
            # Omitted wait defaults to 60; even a future cursor cannot hide a question.
            result = await self.manager.dispatch('expert_status',
                {'job_id': job['job_id'], 'after_revision': 999})
            await change
            self.assertLess(asyncio.get_running_loop().time() - clock, 1)
            self.assertEqual(result['state'], state)

    async def test_status_existing_question_returns_immediately(self):
        job = self.status_fixture('waiting_for_user')
        job['request'] = {'request_id': 'human-question', 'question': 'Choose a size.'}
        result = await asyncio.wait_for(self.manager.dispatch('expert_status',
            {'job_id': job['job_id'], 'wait_seconds': 30, 'after_revision': 1}), 0.5)
        self.assertEqual(result['request']['request_id'], 'human-question')

    async def test_status_explicit_zero_returns_running_snapshot(self):
        job = self.status_fixture()
        result = await asyncio.wait_for(self.manager.dispatch('expert_status',
            {'job_id': job['job_id'], 'wait_seconds': 0}), 0.5)
        self.assertEqual(result['state'], 'running')

    async def test_running_status_omits_repeated_job_context(self):
        job = self.status_fixture()
        job.update(workspace_path=str(self.workspace), model='irrelevant',
                   report={'summary': 'not ready'}, request=None,
                   progress='Ran a workspace command.', web_search_calls=100,
                   reasoning_effort='high')
        result = await self.manager.dispatch('expert_status',
            {'job_id': job['job_id'], 'wait_seconds': 0, 'after_revision': 1})
        self.assertEqual(set(result), {'job_id', 'state', 'revision', 'changed'})
        self.assertFalse(result['changed'])
        self.assertLess(len(json.dumps(result)), 180)
        job['revision'] = 2
        changed = await self.manager.dispatch('expert_status',
            {'job_id': job['job_id'], 'wait_seconds': 0, 'after_revision': 1})
        self.assertTrue(changed['changed'])
        self.assertEqual(changed['progress'], job['progress'])
        self.assertLess(len(json.dumps(changed)), 240)

    async def test_actionable_status_keeps_full_report_and_question(self):
        job = self.status_fixture('completed')
        job['report'] = {'summary': 'Finished.', 'changed_files': ['existing.txt']}
        done = await self.manager.dispatch('expert_status', {'job_id': job['job_id']})
        self.assertEqual(done['report'], job['report'])
        self.assertFalse(done['workspace_reserved'])
        job['state'] = 'waiting_for_user'
        job['request'] = {'request_id': 'question', 'question': 'Which size?',
                          'options': [{'id': 'small', 'label': 'Small'}]}
        question = await self.manager.dispatch('expert_status', {'job_id': job['job_id']})
        self.assertEqual(question['request'], job['request'])
        self.assertTrue(question['workspace_reserved'])

    async def test_status_schema_allows_one_minute_wait_and_rejects_longer(self):
        from consult_expert.contracts import STATUS_INPUT
        self.assertEqual(STATUS_INPUT['properties']['wait_seconds']['default'], 60)
        validate('expert_status', {'job_id': 'fixture', 'wait_seconds': 60})
        with self.assertRaises(ExpertError):
            validate('expert_status', {'job_id': 'fixture', 'wait_seconds': 61})

    async def test_timeout_interrupts_worker(self):
        self.scenario('hold')
        await self.manager.close()
        self.settings = Settings(auth_home=self.settings.auth_home, codex=self.settings.codex, state=self.settings.state,
                                 workspace_roots=self.settings.workspace_roots, timeout=0.3)
        self.manager = JobManager(self.settings)
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        result = await self.wait(self.manager, start['job_id'], {'failed'})
        self.assertEqual(result['error']['code'], 'EXPERT_TIMEOUT')
        self.assertTrue((self.workspace / 'expert.txt').exists())

    async def test_running_record_recovered_as_failed(self):
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        await self.manager.close()
        self.manager = JobManager(self.settings)
        self.assertEqual(self.manager.get(start['job_id'])['state'], 'failed')
        self.assertEqual(self.manager.get(start['job_id'])['error']['code'], 'SUPERVISOR_RESTARTED')

    async def test_private_records_do_not_contain_credentials(self):
        start = await self.manager.dispatch('consult_expert', packet(self.workspace))
        await self.wait(self.manager, start['job_id'], {'completed'})
        record = self.settings.state / 'jobs' / (start['job_id'] + '.json')
        self.assertEqual(record.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('access_token', record.read_text())

    async def test_scope_and_report_symlink_rejected(self):
        with self.assertRaises(ExpertError):
            workspace_path('/etc', self.settings)
        escape = self.workspace / 'escape'
        escape.symlink_to('/etc', target_is_directory=True)
        for value in ('../escape.md', '/tmp/report.md', 'escape/report.md', 'C:\\report.md'):
            with self.assertRaises(ExpertError):
                relative_path(value, self.workspace)

    async def test_auth_api_fallback_and_secret_environment_disabled(self):
        auth = self.settings.auth_home / 'auth.json'
        auth.write_text(json.dumps({'auth_mode': 'apikey', 'OPENAI_API_KEY': 'never-output'}))
        with self.assertRaises(ExpertError) as error:
            await self.manager.dispatch('consult_expert', packet(self.workspace))
        self.assertEqual(error.exception.code, 'CHATGPT_AUTH_REQUIRED')
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'secret', 'CODEX_API_KEY': 'secret'}):
            env = codex_environment(self.settings)
        self.assertNotIn('OPENAI_API_KEY', env)
        self.assertNotIn('CODEX_API_KEY', env)
        self.assertEqual(env['CODEX_HOME'], str(self.settings.auth_home))

    async def test_missing_auth(self):
        (self.settings.auth_home / 'auth.json').unlink()
        with self.assertRaises(ExpertError) as error:
            await self.manager.dispatch('consult_expert', packet(self.workspace))
        self.assertEqual(error.exception.code, 'AUTH_REQUIRED')

    async def test_contract_efforts_research_empty_attempts_and_bounds(self):
        self.assertEqual(INPUT['properties']['reasoning_effort']['enum'], ['xhigh'])
        self.assertEqual(INPUT['properties']['permission_mode']['default'], 'default')
        self.assertEqual(INPUT['properties']['permission_mode']['enum'], ['default', 'full'])
        self.assertNotIn('permission_mode', INPUT['required'])
        for mode in ('read-only', 'danger-full-access', '', None):
            with self.assertRaises(ExpertError):
                validate('consult_expert', {**packet(self.workspace), 'permission_mode': mode})
        validate('consult_expert', packet(self.workspace))
        for effort in ('low', 'medium', 'high', 'max'):
            with self.assertRaises(ExpertError):
                validate('consult_expert', {**packet(self.workspace), 'reasoning_effort': effort})
        with self.assertRaises(ExpertError):
            validate('expert_status', {'wait_seconds': 1})
        with self.assertRaises(ExpertError):
            validate('consult_expert', {**packet(self.workspace), 'sources': [{'url': 'https://name:password@example.com', 'finding': 'secret'}]})

    async def test_advertised_schemas_keep_structure_and_server_bounds(self):
        from consult_expert.contracts import TOOLS, tool_input_schema
        from consult_expert.server import list_tools
        import copy
        original = copy.deepcopy(TOOLS)
        listed = await list_tools()
        for tool in listed:
            schema = tool.inputSchema
            serialized = json.dumps(schema)
            self.assertNotIn('"maxLength"', serialized)
            self.assertNotIn('"minLength"', serialized)
            self.assertEqual(schema, tool_input_schema(TOOLS[tool.name]))
            self.assertEqual(schema['required'], TOOLS[tool.name]['required'])
            self.assertFalse(schema['additionalProperties'])
        self.assertEqual(TOOLS, original)
        advertised = next(t.inputSchema for t in listed if t.name == 'consult_expert')
        self.assertEqual(advertised['properties']['reasoning_effort']['enum'], ['xhigh'])
        self.assertEqual(advertised['properties']['acceptance_criteria']['maxItems'], 10)
        self.assertIn('1-10000 characters', advertised['properties']['research_summary']['description'])
        for field, value in [('research_summary', 'x' * 10001), ('subgoal', ''),
                             ('assignment_id', 'x' * 81)]:
            with self.assertRaises(ExpertError):
                validate('consult_expert', {**packet(self.workspace), field: value})
        for value in ['', 'x' * 81]:
            with self.assertRaises(ExpertError):
                validate('expert_cancel', {'job_id': value})

    async def test_windows_and_unc_conversion(self):
        self.assertEqual(str(local_path(r'C:\Users\example-user\Projects\demo')), '/mnt/c/Users/example-user/Projects/demo')
        self.assertEqual(str(local_path(r'\\wsl.localhost\Ubuntu\home\example-user\Projects\demo')), '/home/example-user/Projects/demo')

    async def test_detached_supervisor_survives_mcp_disconnect(self):
        # Bootstrap the isolated daemon with fixture-only settings, never actual login data.
        await self.manager.close()
        self.scenario('question')
        settings = self.settings
        literal = repr({k: str(getattr(settings, k)) for k in ('auth_home', 'codex', 'state')})
        code = ('import asyncio; from pathlib import Path; from consult_expert.settings import Settings; '
                'from consult_expert.daemon import serve; p=' + literal + '; '
                'asyncio.run(serve(Settings(**{k:Path(v) for k,v in p.items()},workspace_roots=(Path(' + repr(str(self.base)) + '),),timeout=30)))')
        daemon = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            for _ in range(100):
                if (settings.state / 'supervisor.sock').exists():
                    break
                await asyncio.sleep(0.05)
            start = await exchange(settings, 'consult_expert', packet(self.workspace))
            # A real MCP client connects and disconnects while the daemon owns the work.
            bootstrap = ('from pathlib import Path; from consult_expert.settings import Settings; '
                'from consult_expert import server; p=' + literal + '; '
                'server.Settings.load=lambda:Settings(**{k:Path(v) for k,v in p.items()},workspace_roots=(Path(' + repr(str(self.base)) + '),),timeout=30); server.main()')
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
            async with stdio_client(StdioServerParameters(command=sys.executable, args=['-c', bootstrap], env={'PYTHONPATH': str(Path(__import__('consult_expert').__file__).parent.parent)})) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listing = await session.list_tools()
                    self.assertEqual({t.name for t in listing.tools}, {'consult_expert', 'expert_status', 'expert_reply', 'expert_cancel'})
                    response = await session.call_tool('expert_status', {'job_id': start['job_id'], 'wait_seconds': 1})
                    self.assertFalse(response.isError)
            question = None
            for _ in range(20):
                question = await exchange(settings, 'expert_status', {'job_id': start['job_id'], 'wait_seconds': 1})
                if question['state'] == 'waiting_for_user':
                    break
            self.assertEqual(question['state'], 'waiting_for_user', question)
            await exchange(settings, 'expert_reply', {'job_id': start['job_id'], 'request_id': question['request']['request_id'], 'answer': 'Text'})
            for _ in range(20):
                final = await exchange(settings, 'expert_status', {'job_id': start['job_id'], 'wait_seconds': 1})
                if final['state'] in {'completed', 'failed'}:
                    break
            self.assertEqual(final['state'], 'completed', final)
            await exchange(settings, '_stop', {})
            await asyncio.to_thread(daemon.wait, 10)
        finally:
            if daemon.poll() is None:
                daemon.terminate()
                await asyncio.to_thread(daemon.wait, 10)


if __name__ == '__main__':
    unittest.main()
