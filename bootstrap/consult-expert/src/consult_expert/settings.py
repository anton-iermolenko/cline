"""Private local configuration and ChatGPT-only authentication."""
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from .contracts import MODEL, EFFORTS

BASE = Path.home() / '.local/share/consult-expert'
AUTH_HOME = Path.home() / '.config/consult-expert/codex'
STATE = Path.home() / '.local/state/consult-expert'
DEFAULT_CODEX = BASE / 'codex-runtime/node_modules/.bin/codex'


class ExpertError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Settings:
    auth_home: Path = AUTH_HOME
    codex: Path = DEFAULT_CODEX
    timeout: float = 1800
    state: Path = STATE
    workspace_roots: tuple = field(default_factory=lambda: (Path.home() / 'Projects', Path.home() / 'projects', BASE / 'verification'))

    @classmethod
    def load(cls):
        path = Path(os.environ.get('CONSULT_EXPERT_CONFIG', str(AUTH_HOME.parent / 'config.json')))
        try:
            data = json.loads(path.read_text()) if path.exists() else {}
            if not isinstance(data, dict) or set(data) - {'codex_path', 'timeout_seconds', 'workspace_roots', 'state_directory'}:
                raise ValueError()
            timeout = data.get('timeout_seconds', 1800)
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 30 <= timeout <= 7200:
                raise ValueError()
            codex = Path(data.get('codex_path', DEFAULT_CODEX)).expanduser()
            state = Path(data.get('state_directory', STATE)).expanduser()
            roots = data.get('workspace_roots')
            if roots is not None and (not isinstance(roots, list) or not roots or any(not isinstance(p, str) for p in roots)):
                raise ValueError()
            roots = tuple(Path(p).expanduser() for p in roots) if roots is not None else cls().workspace_roots
            if not all(p.is_absolute() for p in (codex, state, *roots)):
                raise ValueError()
            return cls(codex=codex, timeout=timeout, state=state, workspace_roots=roots)
        except (ValueError, TypeError, OSError):
            raise ExpertError('CONFIG_INVALID', 'Expert config needs absolute codex/state/workspace paths and timeout_seconds between 30 and 7200.') from None


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def require_chatgpt(settings):
    credential = settings.auth_home / 'auth.json'
    if not credential.exists():
        raise ExpertError('AUTH_REQUIRED', 'Sign in outside Cline: consult-expert-auth login, using the standalone authentication helper.')
    try:
        if credential.stat().st_size > 65536:
            raise ValueError()
        data = json.loads(credential.read_text())
        if not isinstance(data, dict):
            raise ValueError()
    except (ValueError, OSError):
        raise ExpertError('AUTH_INVALID', 'Stored credentials are unreadable. Sign in outside Cline.') from None
    if data.get('auth_mode') != 'chatgpt' or data.get('OPENAI_API_KEY') or not isinstance(data.get('tokens'), dict):
        raise ExpertError('CHATGPT_AUTH_REQUIRED', 'Only Login with ChatGPT credentials are accepted; API-key fallback is disabled.')
    if not data['tokens'].get('access_token') or not data['tokens'].get('refresh_token'):
        raise ExpertError('AUTH_INVALID', 'ChatGPT credentials are incomplete. Sign in outside Cline.')
    settings.auth_home.chmod(0o700)
    credential.chmod(0o600)


def codex_environment(settings):
    env = dict(os.environ)
    for key in ('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
                'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'CODEX_ACCESS_TOKEN',
                'CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'):
        env.pop(key, None)
    env['CODEX_HOME'] = str(settings.auth_home)
    return env


def status(settings):
    try:
        require_chatgpt(settings)
        auth = 'chatgpt_credentials_present'
    except ExpertError as exc:
        auth = exc.code
    return {'model': MODEL, 'codex_available': settings.codex.is_file() and os.access(settings.codex, os.X_OK),
            'authentication': auth, 'web_search': 'live', 'shell_network_access': False, 'reasoning_levels': list(EFFORTS),
            'default_permission_mode': 'default',
            'permission_modes': {'default': {'local_files': 'private artifact sandbox only', 'shell_network_access': False},
                                 'full': {'local_files': 'shared workspace (existing behavior)', 'shell_network_access': True,
                                          'requires': 'The user must explicitly request full mode.'}},
            'active_time_limit_seconds': settings.timeout,
            'workspace_roots': [str(p) for p in settings.workspace_roots],
            'next_step': 'Sign in outside Cline.' if auth != 'chatgpt_credentials_present' else 'Ready for a web consultation with private artifact storage. Full mode requires an explicit user request; account/model access is checked at runtime.'}
