"""Public MCP contracts and the expert's structured turn result."""
MODEL = 'gpt-6.1-sol'
EFFORTS = ['xhigh']
MAX_INPUT = 32000
MAX_OUTPUT = 24000
ACTIVE = {'running', 'waiting_for_user'}
TERMINAL = {'completed', 'failed', 'cancelled', 'unavailable'}


def obj(properties, required=None):
    return {'type': 'object', 'properties': properties,
            'required': list(properties) if required is None else required,
            'additionalProperties': False}


def string(limit):
    return {'type': 'string', 'minLength': 1, 'maxLength': limit}


def array(items, maximum, minimum=0):
    return {'type': 'array', 'items': items, 'minItems': minimum, 'maxItems': maximum}


INPUT = obj({
    'assignment_id': {**string(80), 'description': 'Unique assignment ID. Reuse only to retry an identical start after a lost response.'},
    'workspace_path': {**string(2048), 'description': 'Absolute saved Cline repository folder; Ubuntu, /mnt/c, Windows, or WSL path. Handover destination in default mode; shared working folder in full mode.'},
    'permission_mode': {'type': 'string', 'enum': ['default', 'full'], 'default': 'default', 'description': 'Default: live web search and a private artifact sandbox only; no local repository/file access. Full: current shared-workspace file, command/test, and shell-network access. Use full ONLY when the user explicitly requests full mode; asking to consult the expert alone does not authorize it.'},
    'user_objective': {**string(3000), 'description': "The user's parent objective."},
    'subgoal': {**string(3000), 'description': 'Concrete outcome delegated to the expert.'},
    'acceptance_criteria': {**array(string(1000), 10, 1), 'description': 'Observable completion conditions and required validation.'},
    'research_summary': {**string(10000), 'description': 'Available facts from docs, source, and system state. No extra research is required before a user-requested handoff; no activity log or secrets.'},
    'attempted_approaches': {**array(string(1500), 8), 'description': 'Actual diagnostic/fix attempts: action -> result -> remaining issue. Use [] if none; omit research.'},
    'uncertainty': {**string(3000), 'description': 'Question or review focus for the expert; include conflicting evidence or failures if any. A prior failure is not required.'},
    'reasoning_effort': {'type': 'string', 'enum': EFFORTS, 'description': 'Use xhigh (Extra High) for expert consultations.'},
    'context_files': {**array(string(2048), 20), 'description': 'Relative path[:line] breadcrumbs. Accessible only in full mode; in default mode provide relevant facts in research_summary.'},
    'constraints': {**array(string(1000), 10), 'description': 'Actual user requirements and approval/scope boundaries.'},
    'candidate_options': array(string(1500), 6),
    'sources': array(obj({'url': string(2048), 'finding': string(1000)}), 10),
    'report_path': {**string(2048), 'description': 'Optional relative .md path: inside the artifact sandbox in default mode, or the shared repository in full mode.'},
}, ['assignment_id', 'workspace_path', 'user_objective', 'subgoal', 'acceptance_criteria',
    'research_summary', 'attempted_approaches', 'uncertainty', 'reasoning_effort'])

OPTION = obj({'id': string(40), 'label': string(120), 'tradeoff': string(700), 'recommended': {'type': 'boolean'}})
QUESTION = obj({'question': string(1600), 'options': array(OPTION, 5)})
RESULT = obj({
    'disposition': {'type': 'string', 'enum': ['completed', 'needs_user_input', 'blocked']},
    'summary': string(4000),
    'changed_files': array(string(2048), 80),
    'validation': array(string(1000), 12),
    'remaining_issues': array(string(1000), 12),
    'sources': array(obj({'url': string(2048), 'supports': string(1000)}), 10),
    'report_path': {'anyOf': [string(2048), {'type': 'null'}]},
    'user_question': {'anyOf': [QUESTION, {'type': 'null'}]},
})
STATUS_INPUT = obj({'job_id': string(80), 'wait_seconds': {'type': 'integer', 'minimum': 0, 'maximum': 60, 'default': 60, 'description': 'Default 60; return early for a question or terminal state. Use 0 only for an immediate snapshot.'},
                    'after_revision': {'type': 'integer', 'minimum': 0, 'description': 'Revision from the last result.'}}, [])
REPLY_INPUT = obj({'job_id': string(80), 'request_id': string(80),
                  'answer': {**string(8000), 'description': 'Actual human answer; never invent a reply or treat waiting as consent.'}})
CANCEL_INPUT = obj({'job_id': string(80)})
DESCRIPTION = (
    'Use only when the user explicitly requests expert help or delegation to Codex. '
    'Make the handoff the next relevant action using available facts; no failed attempts or extra research are required. '
    'Default permission_mode is default: live web search and a private persistent sandbox for files handed back to Cline; '
    'no access to local files or the repository. Supply relevant facts in the packet. '
    'Full mode preserves shared-repository reads/edits, commands/tests, and shell networking. '
    'The user must explicitly request full mode before setting permission_mode=full; a consultation or coding request alone is insufficient. '
    'Returns job_id and, in default mode, sandbox_path for later artifact handover. Follow next_action; '
    'in full mode pause repository reads, edits, and commands until the job stops. Authentication is managed outside Cline.'
)

TOOLS = {'consult_expert': INPUT, 'expert_status': STATUS_INPUT, 'expert_reply': REPLY_INPUT, 'expert_cancel': CANCEL_INPUT}



def tool_input_schema(schema):
    """Advertise structure without costly bounded-string decoding grammars.

    The canonical TOOLS contracts remain authoritative for server validation.
    Qwen XML constrained decoding expands large string bounds into slow grammar
    states; describe those limits to callers instead of enforcing them in tokens.
    """
    if isinstance(schema, list):
        return [tool_input_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    result = {key: tool_input_schema(value) for key, value in schema.items()
              if key not in ('minLength', 'maxLength')}
    if schema.get('type') == 'string' and 'maxLength' in schema:
        limit = f"Length: {schema.get('minLength', 0)}-{schema['maxLength']} characters; validated by server."
        result['description'] = (result.get('description', '') + ' ' + limit).strip()
    return result
