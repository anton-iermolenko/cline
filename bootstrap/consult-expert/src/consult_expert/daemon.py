"""Private Unix-socket supervisor; job lifetime is independent of MCP stdio."""
import argparse
import asyncio
import fcntl
import json
import os
import signal
import socket
import struct
from . import __version__
from .client import LIMIT, identity, exchange
from .contracts import ACTIVE
from .jobs import JobManager
from .settings import ExpertError, Settings, private_directory


async def serve(settings):
    private_directory(settings.state)
    lock_path = settings.state / 'supervisor.lock'
    with lock_path.open('a') as lock:
        lock_path.chmod(0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        address = settings.state / 'supervisor.sock'
        if len(str(address).encode()) > 100:
            raise ExpertError('CONFIG_INVALID', 'state_directory is too long for a Unix socket.')
        address.unlink(missing_ok=True)
        manager = JobManager(settings)
        stopping = asyncio.Event()
        clients = set()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stopping.set)

        async def handle(reader, writer):
            task = asyncio.current_task()
            clients.add(task)
            try:
                peer = writer.get_extra_info('socket').getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                if struct.unpack('3i', peer)[1] != os.getuid():
                    return
                message = json.loads(await asyncio.wait_for(reader.readline(), 10))
                if message.get('version') != __version__ or message.get('settings') != identity(settings):
                    raise ExpertError('SUPERVISOR_CONFIG_CHANGED', 'Supervisor version/config differs. Finish active jobs, then run consult-expert-supervisor --stop before reconnecting.')
                if message['method'] == '_stop':
                    if any(j['state'] in ACTIVE for j in manager.jobs.values()):
                        raise ExpertError('EXPERT_BUSY', 'Finish/cancel active jobs before stopping or upgrading the supervisor.')
                    stopping.set()
                    result = {'stopped': True}
                else:
                    result = await manager.dispatch(message['method'], message['arguments'])
                response = {'result': result}
            except ExpertError as exc:
                response = {'error': {'code': exc.code, 'message': str(exc)}}
            except Exception:
                response = {'error': {'code': 'SUPERVISOR_ERROR', 'message': 'The local job operation failed; existing edits remain. Private diagnostics are withheld.'}}
            try:
                writer.write((json.dumps(response) + '\n').encode())
                await writer.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                writer.close()
                await writer.wait_closed()
                clients.discard(task)

        server = await asyncio.start_unix_server(handle, path=address, limit=LIMIT)
        address.chmod(0o600)
        async def idle():
            while not stopping.is_set():
                await asyncio.sleep(10)
                # Structured waiting jobs are persisted and resumable after idle exit.
                if not any(not task.done() for task in manager.tasks.values()) and loop.time() - manager.last_activity > 120:
                    stopping.set()
        idle_task = asyncio.create_task(idle())
        try:
            async with server:
                await stopping.wait()
        finally:
            server.close()
            await server.wait_closed()
            idle_task.cancel()
            await asyncio.gather(idle_task, return_exceptions=True)
            await manager.close()
            await manager.runtime_lost(ExpertError('SUPERVISOR_STOPPED', 'The supervisor stopped during an active turn. Inspect saved edits before assigning more work.'))
            for task in clients:
                task.cancel()
            await asyncio.gather(*clients, return_exceptions=True)
            address.unlink(missing_ok=True)


async def stop(settings):
    try:
        print(json.dumps(await exchange(settings, '_stop', {})))
        for _ in range(50):
            if not (settings.state / 'supervisor.sock').exists():
                return
            await asyncio.sleep(0.1)
    except (ConnectionRefusedError, FileNotFoundError):
        print(json.dumps({'stopped': True, 'already_stopped': True}))


def main():
    parser = argparse.ArgumentParser(description='Private local expert job supervisor.')
    parser.add_argument('--stop', action='store_true', help='Stop when no active job exists; useful before upgrading.')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        asyncio.run(stop(Settings.load()) if args.stop else serve(Settings.load()))
    except ExpertError as exc:
        print(json.dumps({'code': exc.code, 'message': str(exc)}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
