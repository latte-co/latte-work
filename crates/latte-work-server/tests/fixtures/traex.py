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
        saved = {'id': thread}
        history_size = pathlib.Path('traex-resume-bytes')
        if method == 'thread/resume' and history_size.exists():
            size = int(history_size.read_text())
            saved['turns'] = [{'id': 'past-turn', 'items': [{'type': 'agentMessage', 'text': 'HISTORY_ONLY_MARKER' + 'h' * size}]}]
        reply(value, {'thread': saved})
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
        elif prompt in ('wait', 'wait-interrupt-race', 'wait-think', 'wait-reply'):
            text('WAITING')
            if prompt == 'wait-think': notify('item/reasoning/textDelta', {'itemId':'think','delta':'private reasoning'})
        elif prompt == 'complete-only':
            for _ in range(2):
                notify('item/completed', {'item': {'id': 'msg-' + turn, 'type': 'agentMessage', 'text': 'ONCE'}})
            complete()
        elif prompt == 'credential':
            text(os.environ['LATTE_WORK_TRAEX_PROVIDER_TOKEN'])
            complete()
        elif prompt == 'failed':
            complete('failed')
        elif prompt in ('background', 'background-wait'):
            item = {'id': 'background-start', 'type': 'commandExecution', 'command': 'python -m unittest discover',
                    'cwd': os.getcwd(), 'status': 'inProgress'}
            notify('item/started', {'item': item})
            notify('item/completed', {'item': {**item, 'status': 'backgrounded', 'processId': '47462',
                    'exitCode': None, 'aggregatedOutput': 'partial regression output',
                    'rawOutput': {'process_id': 47462}}})
            text('BACKGROUND_WAITING')
            if prompt == 'background':
                complete()
        elif prompt in ('background-write-hold', 'background-write-eof'):
            pathlib.Path('background-late.txt').write_text('written by background command\n')
            notify('item/completed', {'item': {'id': 'background-poll', 'type': 'commandExecution',
                    'command': '', 'cwd': os.getcwd(), 'source': 'unifiedExecInteraction', 'status': 'completed',
                    'processId': '47462', 'exitCode': 0, 'aggregatedOutput': 'final regression output'}})
            text('BACKGROUND_LATE')
            if prompt == 'background-write-eof':
                sys.exit(0)
        elif prompt == 'background-write':
            pathlib.Path('background-late.txt').write_text('written by background command\n')
            notify('item/completed', {'item': {'id': 'background-poll', 'type': 'commandExecution',
                    'command': '', 'cwd': os.getcwd(), 'source': 'unifiedExecInteraction', 'status': 'completed',
                    'processId': '47462', 'exitCode': 0, 'aggregatedOutput': 'final regression output'}})
            text('BACKGROUND_WROTE')
            complete()
        elif prompt in ('background-poll-success', 'background-poll-failure'):
            code = 0 if prompt.endswith('success') else 1
            notify('item/completed', {'item': {'id': 'background-poll', 'type': 'commandExecution',
                    'command': '', 'cwd': os.getcwd(), 'source': 'unifiedExecInteraction', 'status': 'completed',
                    'processId': '47462', 'exitCode': code, 'aggregatedOutput': 'final regression output'}})
            text('BACKGROUND_FINISHED')
            complete()
        else:
            notify('item/started', {'item': {'id': 'bash', 'type': 'commandExecution', 'command': 'echo fixture', 'cwd': os.getcwd(), 'status': 'inProgress'}})
            notify('item/completed', {'item': {'id': 'bash', 'type': 'commandExecution', 'command': 'echo fixture', 'cwd': os.getcwd(), 'status': 'completed', 'exitCode': 0, 'aggregatedOutput': 'fixture'}})
            text('TRAE:' + prompt)
            complete()
    elif method == 'turn/steer':
        assert params['threadId'] == thread and params['expectedTurnId'] == turn
        extra=params['input'][0]['text']
        with pathlib.Path('traex-steers').open('a') as record:
            record.write(json.dumps({'prompt':extra,'params':params,'pid':os.getpid()})+'\n')
        if extra == 'reject-steer':
            emit({'id':value['id'],'error':{'code':-32602,'message':'current turn cannot accept steering'}})
        else:
            reply(value,{'turnId':turn})
            if extra != 'hold-steer':
                text('STEER:'+extra)
                complete()
    elif method == 'turn/interrupt':
        pathlib.Path('traex-interrupted').write_text('interrupt')
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
