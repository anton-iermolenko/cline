# consult-expert MCP

Linux/WSL stdio MCP server for explicitly requested expert assignments through
the official, ChatGPT-authenticated Codex runtime. This is a shareable copy of
the existing implementation, including its durable supervisor and tests.
It is Linux-only (`fcntl`, Unix sockets and peer credentials); run it inside WSL
for a Windows client.

## Install (opt-in, Linux/WSL)

Requires Python >=3.11 with venv/pip, Bun, and a supported Node runtime on PATH.
Use an isolated environment; installation does not register MCP or change rules.
From the Cline repository root:

```sh
python3 -m venv "$HOME/.local/share/consult-expert/venv"
"$HOME/.local/share/consult-expert/venv/bin/python" -m pip install ./bootstrap/consult-expert
mkdir -p "$HOME/.local/share/consult-expert/codex-runtime"
bun add --cwd "$HOME/.local/share/consult-expert/codex-runtime" --exact @openai/codex@0.160.1
"$HOME/.local/share/consult-expert/venv/bin/python" -m unittest discover -s bootstrap/consult-expert/tests -v
```

The Codex runtime is pinned to the app-server protocol used by this copy;
upgrading it requires rechecking the protocol and sandbox behavior. Commands
resolve Node from PATH, including when Cline starts non-interactively.

Copy `config.example.json` outside the checkout to
`~/.config/consult-expert/config.json`, replace every placeholder with an absolute
Linux/WSL path, and include only source roots you intend to allow. `~` expands in
path values. `CONSULT_EXPERT_CONFIG` can select another local config file.
Configuration must be an object containing only the four example keys.
`timeout_seconds` is 30–7200 active seconds; human waiting is excluded.
Do not point at a home directory or credential/state folder as a workspace.

Sign in separately from Cline, using the isolated authentication helper:

```sh
"$HOME/.local/share/consult-expert/venv/bin/consult-expert-auth" login
# Or use a localhost browser callback:
"$HOME/.local/share/consult-expert/venv/bin/consult-expert-auth" login --browser
```

Credentials remain in `~/.config/consult-expert/codex/` (directory 700, auth file
600). ChatGPT authentication is required; API-key fallback is disabled. Account
access and usage allowance are checked at runtime. No login data belongs in Git.

Merge the `consult-expert` entry from `mcp.example.json` into the MCP configuration
used by your Cline client, replacing the executable path. Preserve other entries.
For a Windows client launching WSL, use `wsl.exe` as command and arguments
`["-d", "YOUR_DISTRO", "--", "/absolute/linux/path/to/consult-expert-mcp"]`.
The command and config must describe the same Linux installation. Do not copy
Windows-native paths into Linux configuration. Reconnect MCP after registration.
Call `expert_status` with no arguments to check readiness without a model call.

## Tools and workflow

| Tool | Behavior |
| --- | --- |
| `consult_expert` | Start an assignment and return its durable job ID. |
| `expert_status` | Readiness without a job ID; job progress/question/report otherwise. |
| `expert_reply` | Forward the actual human answer with its current request ID. |
| `expert_cancel` | Interrupt, wait for cleanup, and preserve saved artifacts/edits. |

Only an explicit user request to consult or delegate starts an assignment.
The public tool schemas describe the required packet: assignment ID, absolute
workspace, objective/subgoal, acceptance criteria, learned research facts,
actual attempted approaches (`[]` is valid), uncertainty, and `xhigh` reasoning.
The selected model is `gpt-6.1-sol`; there is no silent model substitution.

Omitted `permission_mode` means `default`: live web research and a private
persistent artifact sandbox, no repository access, no shell networking. Cline
must supply the relevant facts, then inspect/copy deliverables from `sandbox_path`.
`full` requires the human to explicitly request full mode. It runs in the shared
workspace with network-enabled workspace-write permissions; general reads are
not restricted to that workspace. Pause parent workspace activity until that
expert job stops. Assignment text cannot enlarge the configured workspace roots.
No automatic permission upgrade, commits, deployment or messages are authorized.
Unsupported default sandbox profiles fail closed. Extra agents, external MCP,
plugins, hooks and browser/computer control are disabled for expert jobs.

Keep the same job ID and revision across compaction and reconnects. While running,
use sequential `expert_status(job_id, wait_seconds=60, after_revision=revision)`
calls. The normal wait defaults to 60 seconds; routine progress does not wake it
early. Questions and terminal states return promptly. An unchanged wait is normal,
not failure or completion. Forward pending questions to the actual human; silence
is not an answer. Repeating an identical assignment ID/packet is idempotent;
changed packets require a new assignment ID.

Terminal states are `completed`, `failed`, `cancelled`, and `unavailable`.
Usage exhaustion becomes a normal `unavailable` result, with no automatic retry,
reauthentication, model switch or paid API fallback. Preserve partial work and
continue the parent task. Inspect reported artifacts and actual validation before
integrating them; a report does not prove repository validation in default mode.

The detached per-user supervisor owns runtime work independently of MCP stdio.
Private jobs/replies/reports and default artifacts persist under
`~/.local/state/consult-expert/`; these contain task context and are not shareable
configuration. An active runtime crash fails its job safely; no automatic rerun.
Stop an idle supervisor before changing configuration or upgrading:

```sh
"$HOME/.local/share/consult-expert/venv/bin/consult-expert-supervisor" --stop
```

Stopping refuses while jobs or pending human clarifications remain active.
Do not replace an existing installation underneath an active assignment.

## Verification

The bundled unittest suite exercises fake-runtime subprocesses, real MCP
discovery, permissions/profile requests, questions/resume, durable jobs,
idempotency, reservation, cancellation, usage failures, timeouts and credential
guards. It never uses the user's login or model allowance. Run the included no-model native permission check against the installed pinned
Codex runtime before trusting its permission guarantees (and after any runtime
upgrade). It uses temporary fixture-only auth, files, threads and a loopback
listener; it does not read the real login or submit a model turn:

```sh
"$HOME/.local/share/consult-expert/venv/bin/python" bootstrap/consult-expert/verify_permissions.py
```

This check uses the default runtime path under
`~/.local/share/consult-expert/codex-runtime/`; it does not read the local config
file. The fake-runtime suite remains independent of an installed Codex binary.
