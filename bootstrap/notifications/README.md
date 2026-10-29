# CLI status notification hooks

Opt-in file hooks for ordinary CLI mode. `TaskComplete.py` receives `agent_end`
and `TaskError.py` receives `agent_error`. `PreToolUse.py` receives `tool_call`
and sends a generic waiting-for-answer notification for `ask_question`,
`ask_followup_question`, or `plan_mode_respond`. Other tools and subagent question
events are ignored; question text and tool arguments are never forwarded.
Completion means a successful runtime
run/continuation (one submitted turn in interactive mode), not proof that every
user acceptance criterion passed. Error means the run failed; individual failed
tool calls are not task errors. Cancellation is not notified. No YOLO support:
the CLI disables its normal hooks in YOLO mode.

The same `notify.py` handles all three statuses: `completed`, `error`, and `waiting`. It sends only generic status/message,
source and UTC timestamp. Prompts, output, exception text, task IDs, branch names,
user IDs and workspace paths never enter the webhook body. An unset endpoint
disables sending. Delivery is best effort: one POST with a three-second timeout,
no retries or redirects, and no effect on task outcome. Hook stdout stays `{}`.
Errors are generic on stderr and never include the secret endpoint.

## Try without sending

From the repository root, using Python >=3.11:

```sh
printf '%s' '{"hookName":"agent_end"}' | CLINE_NOTIFY_DRY_RUN=1 python3 bootstrap/notifications/notify.py
printf '%s' '{"hookName":"agent_error"}' | CLINE_NOTIFY_DRY_RUN=1 python3 bootstrap/notifications/notify.py
printf '%s' '{"hookName":"tool_call","tool_call":{"name":"ask_question"}}' | CLINE_NOTIFY_DRY_RUN=1 python3 bootstrap/notifications/notify.py
python3 -m unittest discover -s bootstrap/notifications/tests -v
```

## Install (opt-in, Linux/WSL)

In the target workspace, preserve existing hooks with these names. Copy this
single script to each desired hook name; neither needs a repository-specific absolute path:

```sh
mkdir -p .cline/hooks
cp /path/to/cline/bootstrap/notifications/notify.py .cline/hooks/TaskComplete.py
cp /path/to/cline/bootstrap/notifications/notify.py .cline/hooks/TaskError.py
cp /path/to/cline/bootstrap/notifications/notify.py .cline/hooks/PreToolUse.py
chmod +x .cline/hooks/TaskComplete.py .cline/hooks/TaskError.py .cline/hooks/PreToolUse.py
```

Alternatively use `~/.cline/hooks/` for all workspaces. Install only one set to
avoid duplicate alerts. Python must be available to Cline's execution environment.
Hooks are CLI examples; no extension-specific payload/config behavior is assumed.

Load `CLINE_NOTIFY_WEBHOOK_URL` from a private environment file or secret manager
before starting Cline. Use `.env.example` as a template outside Git; it is not
loaded automatically. The endpoint is `https://YOUR_HOST/api/webhook/YOUR_ID`.
Use the Home Assistant base URL reachable from the CLI host. For a trusted local
network, HTTP is accepted too. A webhook ID is a credential: generate a long random
one and keep it out of source, shell history and logs. No bearer token is needed.

## Home Assistant

`home-assistant-automation.example.yaml` is one automation object for the YAML
editor. In an `automations.yaml` list, add it as one list item. Add a private
`cline_webhook_id` value to Home Assistant's `secrets.yaml`; the sender URL must
end with that same ID. The example allows POST from the local network and creates
a generic persistent notification. Adapt the action to your preferred device.
Do not disable `local_only` unless you deliberately configure remote delivery.
Check the automation in Home Assistant before enabling actual sending.

JSON POST data is available as `trigger.json` when Content-Type is
`application/json`; see the official [webhook trigger documentation](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger)
and [persistent notification action](https://www.home-assistant.io/integrations/persistent_notification/).
This kit does not install an automation, contact Home Assistant, or replace any
existing notifier/trigger configuration.
