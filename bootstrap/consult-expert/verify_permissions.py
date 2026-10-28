"""No-model checks against the pinned runtime's real Linux/WSL sandbox."""
import argparse
import asyncio
import json
from pathlib import Path
import tempfile

from consult_expert.appserver import AppServer
from consult_expert.permissions import DEFAULT_PROFILE
from consult_expert.settings import Settings, private_directory


async def verify():
    # Keep fixtures outside /tmp: full mode deliberately allows shared temporary writes.
    with tempfile.TemporaryDirectory(prefix='.expert-permissions-', dir=Path.home()) as tmp:
        base = Path(tmp)
        repo, sandbox, auth = (base / name for name in ('repo', 'sandbox', 'auth'))
        for path in (repo, sandbox, auth):
            private_directory(path)
        (repo / 'source.txt').write_text('fixture source')
        (auth / 'credential-canary.txt').write_text('fixture only; no real credential')
        sibling = base / 'sibling.txt'
        sibling.write_text('fixture sibling')
        (sandbox / 'escape').symlink_to(repo, target_is_directory=True)
        # A shared-/tmp file must remain hidden even though the job can write its
        # own working folder. Use only disposable canaries, never private contents.
        with tempfile.NamedTemporaryFile(prefix='expert-denied-', mode='w') as shared:
            shared.write('fixture temporary file')
            shared.flush()

            async def accept(reader, writer):
                writer.close()
                await writer.wait_closed()

            listener = await asyncio.start_server(accept, '127.0.0.1', 0)
            port = listener.sockets[0].getsockname()[1]
            reader, writer = await asyncio.open_connection('127.0.0.1', port)
            writer.close()
            await writer.wait_closed()

            async def ignore(*args):
                pass

            runtime = AppServer(Settings(auth_home=auth), ignore, ignore)
            try:
                await runtime.start()
                params = {'cwd': str(sandbox), 'approvalPolicy': 'never', 'ephemeral': False,
                          'config': {'default_permissions': DEFAULT_PROFILE, 'web_search': 'live'}}
                thread = await runtime.request('thread/start', params)
                assert thread['activePermissionProfile']['id'] == DEFAULT_PROFILE, thread
                assert thread['sandbox']['networkAccess'] is False, thread
                await runtime.request('thread/inject_items', {'threadId': thread['thread']['id'],
                    'items': [{'type': 'message', 'role': 'user',
                               'content': [{'type': 'input_text', 'text': 'Disposable permission fixture; no model request.'}]}]})
                resumed = await runtime.request('thread/resume', {k: v for k, v in {
                    **params, 'threadId': thread['thread']['id']}.items() if k != 'ephemeral'})
                assert resumed['activePermissionProfile']['id'] == DEFAULT_PROFILE, resumed

                denied = [str(repo / 'source.txt'), str(auth / 'credential-canary.txt'), str(sibling),
                          shared.name, str(sandbox / 'escape/source.txt')]
                code = ('import json, socket; from pathlib import Path\n'
                        "Path('artifact.md').write_text('# Saved for Cline\\n')\n"
                        "assert Path('artifact.md').read_text() == '# Saved for Cline\\n'\n"
                        'checks = {}\n')
                code += 'for value in ' + repr(denied) + ':\n'
                code += (' try:\n  Path(value).read_text()\n  checks[value] = False\n'
                         ' except OSError:\n  checks[value] = True\n')
                code += ('try:\n Path(' + repr(str(repo / 'blocked.txt')) + ").write_text('blocked')\n checks['outside_write_denied'] = False\n"
                         "except OSError:\n checks['outside_write_denied'] = True\n")
                code += ('try:\n socket.create_connection((\'127.0.0.1\', ' + str(port) + "), timeout=2).close()\n checks['shell_network_denied'] = False\n"
                         "except OSError:\n checks['shell_network_denied'] = True\n")
                code += "print(json.dumps(checks))\nassert all(checks.values()), checks\n"
                result = await runtime.request('command/exec', {'cwd': str(sandbox),
                    'permissionProfile': DEFAULT_PROFILE, 'command': ['python3', '-c', code], 'timeoutMs': 10000})
                assert result['exitCode'] == 0, result
                assert (sandbox / 'artifact.md').is_file()
                assert not (repo / 'blocked.txt').exists()
                assert (repo / 'source.txt').read_text() == 'fixture source'
                default_checks = json.loads(result['stdout'])

                full_thread = await runtime.request('thread/start', {'cwd': str(repo), 'approvalPolicy': 'never',
                    'sandbox': 'workspace-write', 'ephemeral': True,
                    'config': {'web_search': 'live', 'sandbox_workspace_write.network_access': True}})
                assert full_thread['sandbox']['networkAccess'] is True, full_thread
                full_code = ("from pathlib import Path; import socket\n"
                             "assert Path('source.txt').read_text() == 'fixture source'\n"
                             "Path('full.txt').write_text('shared workspace edit')\n"
                             "socket.create_connection(('127.0.0.1', " + str(port) + '), timeout=2).close()\n'
                             'try:\n Path(' + repr(str(base / 'outside-write.txt')) + ").write_text('blocked')\n"
                             "except OSError:\n print('full_mode_passed')\n"
                             "else:\n raise AssertionError('outside write allowed')\n")
                full = await runtime.request('command/exec', {'cwd': str(repo),
                    'sandboxPolicy': {'type': 'workspaceWrite', 'writableRoots': [str(repo)],
                        'networkAccess': True, 'excludeSlashTmp': False, 'excludeTmpdirEnvVar': False},
                    'command': ['python3', '-c', full_code], 'timeoutMs': 10000})
                assert full['exitCode'] == 0, full
                assert (repo / 'full.txt').read_text() == 'shared workspace edit'
                return {'passed': True, 'model_calls': 0, 'default': {
                    'profile_confirmed_on_start_and_resume': True, 'sandbox_artifact_roundtrip': True,
                    'outside_read_denials': sum(default_checks[p] for p in denied),
                    'outside_write_denied': default_checks['outside_write_denied'],
                    'shell_network_denied': default_checks['shell_network_denied']},
                    'full': {'repository_read_write': True, 'local_network_access': True,
                             'outside_workspace_write_denied': True}}
            finally:
                await runtime.close()
                listener.close()
                await listener.wait_closed()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = asyncio.run(verify())
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
