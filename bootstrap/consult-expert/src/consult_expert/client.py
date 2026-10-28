"""MCP-facing proxy to a detached per-user supervisor, never to credential endpoints."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
from . import __version__
from .settings import ExpertError, private_directory

LIMIT = 262144


def identity(settings):
    return {'codex': str(settings.codex), 'auth_home': str(settings.auth_home),
            'timeout': settings.timeout, 'workspace_roots': [str(p) for p in settings.workspace_roots]}


async def exchange(settings, method, arguments):
    socket = settings.state / 'supervisor.sock'
    reader, writer = await asyncio.open_unix_connection(str(socket), limit=LIMIT)
    try:
        writer.write((json.dumps({'version': __version__, 'settings': identity(settings),
                                'method': method, 'arguments': arguments}) + '\n').encode())
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), 90)
        response = json.loads(line)
        if 'error' in response:
            raise ExpertError(response['error']['code'], response['error']['message'])
        return response['result']
    except (ValueError, asyncio.TimeoutError):
        raise ExpertError('SUPERVISOR_UNAVAILABLE', 'The supervisor did not return a valid response. Retry the same assignment_id after checking status.') from None
    finally:
        writer.close()
        await writer.wait_closed()


async def call(settings, method, arguments):
    private_directory(settings.state)
    try:
        return await exchange(settings, method, arguments)
    except (ConnectionRefusedError, FileNotFoundError):
        pass
    # A singleton flock in the child resolves simultaneous Cline reconnects safely.
    env = dict(os.environ)
    command = [sys.executable, '-m', 'consult_expert.daemon']
    with open(os.devnull, 'rb') as source, open(os.devnull, 'wb') as sink:
        subprocess.Popen(command, stdin=source, stdout=sink, stderr=sink, env=env,
                         cwd=settings.state, start_new_session=True, close_fds=True)
    for _ in range(100):
        await asyncio.sleep(0.1)
        try:
            return await exchange(settings, method, arguments)
        except (ConnectionRefusedError, FileNotFoundError):
            pass
    raise ExpertError('SUPERVISOR_UNAVAILABLE', 'Cannot connect to the local expert supervisor. Check the installation steps and local config.')
