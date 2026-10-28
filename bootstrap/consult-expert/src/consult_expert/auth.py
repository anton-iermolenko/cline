"""User-run sign-in helper, separate from Cline and the MCP protocol."""
import argparse
import asyncio
import json
import subprocess
import sys
from .daemon import stop
from .runner import account_lock
from .settings import Settings, ExpertError, private_directory, codex_environment, require_chatgpt, status


def main():
    parser = argparse.ArgumentParser(description='Manage the expert\'s isolated ChatGPT login outside Cline.')
    parser.add_argument('action', choices=['login', 'status', 'logout'], nargs='?', default='login')
    parser.add_argument('--browser', action='store_true', help='Use localhost browser callback instead of device-code sign-in.')
    args = parser.parse_args()
    settings = Settings.load()
    try:
        if args.action == 'status':
            print(json.dumps(status(settings), indent=2))
            return
        # A user-run auth action may stop an idle supervisor, but never an active job.
        asyncio.run(stop(settings))
        private_directory(settings.auth_home.parent)
        private_directory(settings.auth_home)
        command = [str(settings.codex), '-c', 'cli_auth_credentials_store="file"',
                   '-c', 'forced_login_method="chatgpt"']
        with account_lock(settings):
            if args.action == 'logout':
                result = subprocess.run(command + ['logout'], env=codex_environment(settings))
            else:
                print('Sign in with ChatGPT using the browser link below. Credentials stay in Ubuntu; Cline does not participate.' if args.browser else
                      'Sign in with ChatGPT using the device link/code below. Device login may need enabling in ChatGPT security settings. Credentials stay in Ubuntu.', flush=True)
                result = subprocess.run(command + ['login'] + ([] if args.browser else ['--device-auth']),
                                        env=codex_environment(settings))
                if result.returncode == 0:
                    require_chatgpt(settings)
                    print('ChatGPT expert authentication saved. Restart/reconnect the consult-expert MCP collection if needed.')
            raise SystemExit(result.returncode)
    except (ExpertError, OSError) as exc:
        print(str(exc) if isinstance(exc, ExpertError) else 'Could not launch the expert runtime. Check the installation steps in bootstrap/consult-expert/README.md.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
