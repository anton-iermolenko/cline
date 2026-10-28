"""Trusted runtime permission profile; assignment text cannot widen its roots."""
import json

DEFAULT_PROFILE = 'consult-expert-default'


def default_profile_overrides(settings):
    # The npm runtime's executable/tool-host dependencies must be readable by
    # sandboxed children. No auth, state, source, or other job roots are added.
    codex = settings.codex
    runtime = codex.parent.parent.resolve() if codex.parent.name == '.bin' else codex.resolve()
    filesystem = ('{":root"="deny",":minimal"="read",'
                  '":workspace_roots"={"."="write"},'
                  '":tmpdir"="deny",":slash_tmp"="deny",'
                  + json.dumps(str(runtime)) + '="read"}')
    return {
        'permissions.' + DEFAULT_PROFILE + '.filesystem': filesystem,
        'permissions.' + DEFAULT_PROFILE + '.network.enabled': 'false',
        'features.use_legacy_landlock': 'false',
    }
