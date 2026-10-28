"""Bounded JSON-line client for the pinned official Codex app-server."""
import asyncio
import json
import os
import signal
from . import __version__
from .settings import ExpertError, codex_environment
from .runner import process_error
from .permissions import default_profile_overrides


class AppServer:
    def __init__(self, settings, handler, lost):
        self.settings, self.handler, self.lost = settings, handler, lost
        self.process = None
        self.pending = {}
        self.serial = 0
        self.tasks = []
        self.closing = False
        self.close_task = None
        self.write_lock = asyncio.Lock()

    async def start(self):
        overrides = {'model_provider': 'openai', 'forced_login_method': 'chatgpt',
                     'cli_auth_credentials_store': 'file', 'web_search': 'live',
                     'approval_policy': 'never', 'sandbox_mode': 'workspace-write',
                     'sandbox_workspace_write.network_access': True,
                     'mcp_servers': {}, 'shell_environment_policy.inherit': 'core'}
        args = [str(self.settings.codex)]
        for key, value in overrides.items():
            args += ['-c', key + '=' + json.dumps(value)]
        for key, toml in default_profile_overrides(self.settings).items():
            args += ['-c', key + '=' + toml]
        for feature in ('apps', 'plugins', 'multi_agent', 'multi_agent_v2', 'browser_use',
                        'computer_use', 'in_app_browser', 'image_generation', 'hooks',
                        'skill_search', 'workspace_dependencies'):
            args += ['--disable', feature]
        # Sol's execution/web tools require the built-in code-mode tool host.
        args += ['--enable', 'code_mode_host', 'app-server', '--stdio']
        try:
            spawn = asyncio.create_task(asyncio.create_subprocess_exec(*args,
                cwd=self.settings.auth_home, env=codex_environment(self.settings),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, start_new_session=True, limit=8 * 1024 * 1024))
            try:
                self.process = await asyncio.shield(spawn)
            except asyncio.CancelledError:
                # A cancelled subprocess creation can leave an already-spawned child.
                self.process = await spawn
                await self.close()
                raise
        except OSError:
            raise ExpertError('CODEX_UNAVAILABLE', 'Cannot start Codex; check the installation steps in bootstrap/consult-expert/README.md.') from None
        self.tasks = [asyncio.create_task(self.read()), asyncio.create_task(self.discard(self.process.stderr))]
        try:
            await self.request('initialize', {'clientInfo': {'name': 'consult_expert', 'version': __version__},
                'capabilities': {'experimentalApi': True}})
            await self.send({'method': 'initialized'})
        except BaseException:
            await self.close()
            raise

    @staticmethod
    async def discard(stream):
        while await stream.read(65536):
            pass

    async def send(self, message):
        async with self.write_lock:
            if self.closing or not self.process or self.process.returncode is not None:
                raise ExpertError('RUNTIME_DISCONNECTED', 'The Codex runtime disconnected; edits were preserved.')
            try:
                self.process.stdin.write((json.dumps(message) + '\n').encode())
                await self.process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                raise ExpertError('RUNTIME_DISCONNECTED', 'The Codex runtime disconnected; edits were preserved.') from None

    async def request(self, method, params):
        self.serial += 1
        ident = self.serial
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        try:
            await self.send({'id': ident, 'method': method, 'params': params})
            return await asyncio.wait_for(future, 30)
        except asyncio.TimeoutError:
            raise ExpertError('RUNTIME_TIMEOUT', 'Codex did not acknowledge the operation. Check job status before retrying.') from None
        finally:
            self.pending.pop(ident, None)

    async def read(self):
        try:
            while line := await self.process.stdout.readline():
                message = json.loads(line)
                if 'method' not in message and 'id' in message:
                    future = self.pending.get(message['id'])
                    if future and not future.done():
                        if 'error' in message:
                            future.set_exception(process_error(message['error']))
                        else:
                            future.set_result(message.get('result', {}))
                else:
                    await self.handler(message)
        except Exception:
            pass
        finally:
            error = ExpertError('RUNTIME_DISCONNECTED', 'Codex disconnected. Work already saved in the source folder was preserved.')
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(error)
            if not self.closing:
                await self.lost(error)

    async def close(self):
        if not self.close_task:
            self.closing = True
            self.close_task = asyncio.create_task(self.cleanup(asyncio.current_task()))
        await asyncio.shield(self.close_task)

    async def cleanup(self, owner):
        if not self.process:
            return
        if self.process.returncode is None:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for task in self.tasks:
            if task is not owner and not task.done():
                task.cancel()
        await asyncio.gather(*(t for t in self.tasks if t is not owner), return_exceptions=True)
        await asyncio.gather(self.discard(self.process.stdout), self.discard(self.process.stderr), self.process.wait())
        for future in self.pending.values():
            if not future.done():
                future.set_exception(ExpertError('RUNTIME_DISCONNECTED', 'Codex was stopped; existing edits are preserved.'))
