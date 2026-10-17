#!/usr/bin/env python3
"""Deterministic Traex app-server v2 fixture; no model, login or shared daemon."""
import json
import os
import pathlib
import sys

if '--version' in sys.argv:
    print('fixture-traex 0.210.1')
    sys.exit(0)
if '--help' in sys.argv:
    print('--permission-mode <MODE>\n          - default: workspace access\n          - bypass_permissions: full access\n          - auto: auto reviewer\n\n  -h, --help')
    sys.exit(0)
assert sys.argv[1:3] == ['app-server', '--stdio'], sys.argv
launch = {}
for index, arg in enumerate(sys.argv[3:]):
    if arg == '-c':
        key, value = sys.argv[index + 4].split('=', 1)
        launch[key] = value
thread = 'traex-native-thread'
turn = None
count = 0
waiting = None

def emit(value):
    print(json.dumps(value), flush=True)

def reply(value, result):
    emit({'id': value['id'], 'result': result})

def notify(method, params):
    emit({'method': method, 'params': {'threadId': thread, 'turnId': turn, **params}})

def complete(status='completed'):
    notify('turn/completed', {'turn': {'id': turn, 'status': status, 'error': {'message': 'native failure'} if status == 'failed' else None}})

def text(content):
    notify('item/agentMessage/delta', {'itemId': 'msg-' + turn, 'delta': content})
    notify('item/completed', {'item': {'id': 'msg-' + turn, 'type': 'agentMessage', 'text': content}})

for line in sys.stdin:
    value = json.loads(line)
    method = value.get('method')
    params = value.get('params', {})
    if method == 'initialize':
        reply(value, {'userAgent': 'fixture-traex'})
    elif method == 'initialized':
        pass
    elif method == 'config/read':
        reply(value, {'config': {'model_provider': 'fixture-native', 'model': 'seed-test'}})
    elif method == 'model/list':
        reply(value, {'data': [{'id': 'seed-test', 'displayName': 'Seed Test', 'isDefault': True, 'supportedReasoningEfforts': [{'reasoningEffort': 'high'}]},
            {'id': 'gpt-test', 'displayName': 'GPT Test', 'supportedReasoningEfforts': [{'reasoningEffort': 'high'}],
             'businessMetadata': {'variants': {'standard_key': 'backend-small', 'max_key': 'backend-large',
                'standard_context_window': 475000, 'max_context_window': 800000,
                'standard_supported_reasoning_levels': [{'effort': 'high'}],
                'max_supported_reasoning_levels': [{'effort': 'low'}]}}}], 'nextCursor': None})
    elif method in ('thread/start', 'thread/resume'):
        if method == 'thread/resume':
            assert params['threadId'] == thread
            if not pathlib.Path('traex-inputs').exists():
                emit({'id': value['id'], 'error': {'code': -32602, 'message': 'no rollout found for empty thread'}})
                continue
        with pathlib.Path('traex-opens').open('a') as record:
            record.write(json.dumps({'pid': os.getpid(), 'method': method, 'params': params, 'provider_config': launch}) + '\n')
        reply(value, {'thread': {'id': thread}})
    elif method == 'thread/name/set':
        notify('thread/name/updated', {'threadName': params['name']})
        reply(value, {})
    elif method == 'turn/start':
        count += 1
        turn = 'turn-' + str(count)
        prompt = params['input'][0]['text']
        assert params['threadId'] == thread
        with pathlib.Path('traex-inputs').open('a') as record:
            record.write(json.dumps({'prompt': prompt, 'params': params, 'pid': os.getpid()}) + '\n')
        if prompt == 'early-complete':
            complete()
            reply(value, {'turn': {'id': turn, 'status': 'completed'}})
            notify('turn/started', {'turn': {'id': turn, 'status': 'inProgress'}})
            continue
        notify('turn/started', {'turn': {'id': turn, 'status': 'inProgress'}})
        reply(value, {'turn': {'id': turn, 'status': 'inProgress'}})
        if prompt == 'eof':
            sys.exit(0)
        if prompt in ('approval', 'question'):
            waiting = prompt
            if prompt == 'approval':
                emit({'id': 73, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': thread, 'turnId': turn, 'itemId': 'bash', 'command': 'echo approved', 'cwd': os.getcwd()}})
            else:
                emit({'id': 'ask', 'method': 'item/tool/requestUserInput', 'params': {'threadId': thread, 'turnId': turn, 'itemId': 'ask-tool', 'questions': [{'id': 'q', 'header': 'Pick', 'question': 'Choose one', 'options': [{'label': 'A', 'description': 'first'}, {'label': 'B', 'description': 'second'}]}]}})
        elif prompt in ('wait', 'wait-interrupt-race'):
            text('WAITING')
        elif prompt == 'complete-only':
            for _ in range(2):
                notify('item/completed', {'item': {'id': 'msg-' + turn, 'type': 'agentMessage', 'text': 'ONCE'}})
            complete()
        elif prompt == 'credential':
            text(os.environ['LATTE_WORK_TRAEX_PROVIDER_TOKEN'])
            complete()
        elif prompt == 'failed':
            complete('failed')
        else:
            notify('item/started', {'item': {'id': 'bash', 'type': 'commandExecution', 'command': 'echo fixture', 'cwd': os.getcwd(), 'status': 'inProgress'}})
            notify('item/completed', {'item': {'id': 'bash', 'type': 'commandExecution', 'command': 'echo fixture', 'cwd': os.getcwd(), 'status': 'completed', 'exitCode': 0, 'aggregatedOutput': 'fixture'}})
            text('TRAE:' + prompt)
            complete()
    elif method == 'turn/interrupt':
        assert params['turnId'] == turn
        if prompt == 'wait-interrupt-race':
            complete()
            emit({'id': value['id'], 'error': {'code': -32602, 'message': 'turn not found'}})
        else:
            complete('interrupted')
            reply(value, {})
    elif method is None and waiting:
        if waiting == 'approval':
            assert value['id'] == 73
            text('APPROVED' if value['result']['decision'] == 'accept' else 'DENIED')
        else:
            assert value['id'] == 'ask'
            text('ANSWER:' + json.dumps(value['result']['answers']))
        waiting = None
        complete()
    else:
        raise AssertionError(value)
