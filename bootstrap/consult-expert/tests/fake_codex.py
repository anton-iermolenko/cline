#!/usr/bin/env python3
"""Protocol fixture: real subprocess/pipes, edits, clarification, interrupt, exit."""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

threads = {}
turns = {}
lock = threading.Lock()

def send(value):
    with lock:
        print(json.dumps(value), flush=True)

def reply(ident, value):
    send({'id': ident, 'result': value})

def event(method, params):
    send({'method': method, 'params': params})

def finish(thread, turn, disposition='completed'):
    state = threads[thread]
    workspace = Path(state['cwd'])
    if state['scenario'] == 'blocked':
        disposition = 'blocked'
    if state['scenario'] in ('question', 'quota_reply') and state['count'] == 1:
        disposition = 'needs_user_input'
    if disposition == 'completed':
        (workspace / 'expert.txt').write_text('completed after actual work\n')
    question = {'question': 'Which format should the result use?', 'options': [
        {'id': 'text', 'label': 'Text', 'tradeoff': 'Simple', 'recommended': True},
        {'id': 'json', 'label': 'JSON', 'tradeoff': 'Structured', 'recommended': False}]} if disposition == 'needs_user_input' else None
    result = {'disposition': disposition, 'summary': 'Read existing source and updated expert.txt.',
        'changed_files': ['expert.txt'], 'validation': ['Verified file contents.'], 'remaining_issues': [],
        'sources': [], 'report_path': None, 'user_question': question}
    text = 'invalid-json' if state['scenario'] == 'bad' else json.dumps(result)
    item = {'id': 'answer-' + turn, 'type': 'agentMessage', 'phase': 'final_answer', 'text': text}
    event('item/completed', {'threadId': thread, 'turnId': turn, 'item': item})
    event('turn/completed', {'threadId': thread, 'turn': {'id': turn, 'status': 'completed', 'items': [item], 'error': None}})

def produce(thread, turn):
    state = threads[thread]
    workspace = Path(state['cwd'])
    (workspace / 'expert.txt').write_text('partial saved edit\n')
    event('item/completed', {'threadId': thread, 'turnId': turn, 'item': {'type': 'webSearch', 'id': 'web-' + turn}})
    if state['scenario'] in ('background', 'cleanup_failure', 'quota_during') or (state['scenario'] == 'quota_reply' and state['count'] > 1):
        code = 'import time; from pathlib import Path; time.sleep(1); Path(' + repr(str(workspace / 'late.txt')) + ').write_text("unsafe late write")'
        state['background'] = subprocess.Popen([sys.executable, '-c', code])
    if state['scenario'] in ('quota_during', 'quota_event') or (state['scenario'] == 'quota_reply' and state['count'] > 1):
        error = {'message': 'private fixture quota canary', 'codexErrorInfo': 'usage_limit_exceeded'}
        event('error', {'threadId': thread, 'turnId': turn, 'error': error, 'willRetry': False})
        event('turn/completed', {'threadId': thread, 'turn': {'id': turn, 'status': 'failed', 'items': [], 'error': None if state['scenario'] == 'quota_event' else error}})
        return
    if state['scenario'] == 'crash':
        import os
        os._exit(2)
    if state['scenario'] == 'native':
        send({'id': 'native-' + turn, 'method': 'item/tool/requestUserInput', 'params': {
            'threadId': thread, 'turnId': turn, 'questions': [{'id': 'format', 'question': 'Select a format.',
            'options': [{'label': 'Text', 'description': 'Simple'}, {'label': 'JSON', 'description': 'Structured'}]}]}})
        return
    time.sleep(0.2 if state['scenario'] != 'hold' else 30)
    if not turns[turn].get('interrupted'):
        finish(thread, turn)

for line in sys.stdin:
    message = json.loads(line)
    method, params, ident = message.get('method'), message.get('params', {}), message.get('id')
    if method == 'initialize':
        reply(ident, {'userAgent': 'fake'})
    elif method in ('thread/start', 'thread/resume'):
        thread = params.get('threadId', 'thread-' + str(ident))
        workspace = Path(params['cwd'])
        scenario = (workspace / '.scenario').read_text().strip() if (workspace / '.scenario').exists() else 'normal'
        if scenario == 'quota_start':
            send({'id': ident, 'error': {'code': -32000, 'data': {'codexErrorInfo': 'UsageLimitExceeded'}, 'message': 'private fixture quota canary'}})
            continue
        threads[thread] = {'cwd': str(workspace), 'scenario': scenario, 'count': 1 if method == 'thread/resume' else 0}
        reply(ident, {'thread': {'id': thread}, 'activePermissionProfile': {
            'id': params.get('config', {}).get('default_permissions', ':workspace')}})
    elif method == 'thread/backgroundTerminals/clean':
        state = threads[params['threadId']]
        if state['scenario'] == 'cleanup_failure':
            send({'id': ident, 'error': {'code': -32601, 'message': 'Fixture cleanup failure'}})
        else:
            child = state.get('background')
            if child and child.poll() is None:
                child.kill()
                child.wait()
            reply(ident, {})
    elif method == 'thread/backgroundTerminals/list':
        reply(ident, {'data': []})
    elif method == 'turn/start':
        thread = params['threadId']
        if threads[thread]['scenario'] == 'quota_rpc':
            send({'id': ident, 'error': {'code': -32000, 'data': {'httpStatusCode': 429}, 'message': 'private fixture quota canary'}})
            continue
        threads[thread]['count'] += 1
        turn = 'turn-' + str(os.getpid()) + '-' + str(ident)
        turns[turn] = {'thread': thread, 'interrupted': False}
        reply(ident, {'turn': {'id': turn, 'status': 'inProgress', 'items': []}})
        threading.Thread(target=produce, args=(thread, turn), daemon=True).start()
    elif method == 'turn/interrupt':
        turn = params['turnId']
        turns[turn]['interrupted'] = True
        reply(ident, {})
        event('turn/completed', {'threadId': params['threadId'], 'turn': {'id': turn, 'status': 'interrupted', 'items': []}})
    elif str(ident).startswith('native-') and 'result' in message:
        turn = ident.removeprefix('native-')
        finish(turns[turn]['thread'], turn)
