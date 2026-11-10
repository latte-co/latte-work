#!/usr/bin/env python3
"""Strict Codex app-server fixture; no account, model or shared daemon."""
import json
import os
import pathlib
import sys

if '--version' in sys.argv:
    print('codex-cli fixture-0.162.0')
    sys.exit(0)
if '--help' in sys.argv:
    print('--sandbox [read-only, workspace-write, danger-full-access]\n--ask-for-approval [on-request, never]')
    sys.exit(0)
assert sys.argv[1:3] == ['app-server', '--stdio'], sys.argv
thread = 'codex-native-thread'
turn = None
count = 0
waiting = None
turn_prompt = None


def emit(value):
    print(json.dumps(value), flush=True)


def reply(value, result):
    emit({'id': value['id'], 'result': result})


def notify(method, params):
    emit({'method': method, 'params': {'threadId': thread, 'turnId': turn, **params}})


def text(content):
    notify('item/agentMessage/delta', {'itemId': 'message-' + turn, 'delta': content})
    notify('item/completed', {'item': {'id': 'message-' + turn, 'type': 'agentMessage', 'text': content}})


def complete(status='completed'):
    notify('turn/completed', {'turn': {'id': turn, 'status': status}})


for line in sys.stdin:
    value = json.loads(line)
    method = value.get('method')
    params = value.get('params', {})
    if method == 'initialize':
        assert params['clientInfo']['name'] == 'latte-work'
        reply(value, {'userAgent': 'codex-fixture'})
    elif method == 'initialized':
        pass
    elif method == 'model/list':
        reply(value, {'data': [{'id': 'catalog-row', 'model': 'codex-test', 'displayName': 'Codex Test', 'isDefault': True,
                               'supportedReasoningEfforts': [{'reasoningEffort': 'low'}, {'reasoningEffort': 'high'}]}], 'nextCursor': None})
    elif method == 'config/read':
        reply(value, {'config': {'model_provider': None, 'model': None, 'developer_instructions': 'NATIVE_CODEX_INSTRUCTIONS'}})
    elif method in ('thread/start', 'thread/resume'):
        assert 'model_backend_variant' not in params.get('config', {}), params
        if 'developerInstructions' in params:
            assert params['developerInstructions'].startswith('NATIVE_CODEX_INSTRUCTIONS\n\nLatte Work')
        if method == 'thread/resume':
            assert params['threadId'] == thread and params['excludeTurns'] is True
            assert pathlib.Path('codex-inputs').exists()
        with pathlib.Path('codex-opens').open('a') as f:
            f.write(json.dumps({'method': method, 'params': params, 'pid': os.getpid()}) + '\n')
        reply(value, {'thread': {'id': thread}})
    elif method == 'thread/name/set':
        notify('thread/name/updated', {'threadName': params['name']})
        reply(value, {})
    elif method == 'turn/start':
        assert 'modelProvider' not in params and 'modelBackendVariant' not in params, params
        assert params['threadId'] == thread
        assert params.get('model') in (None, 'codex-test', 'custom-codex')
        count += 1
        turn = 'turn-' + str(count)
        prompt = params['input'][0]['text']
        turn_prompt = prompt
        with pathlib.Path('codex-inputs').open('a') as f:
            f.write(json.dumps({'prompt': prompt, 'params': params, 'pid': os.getpid()}) + '\n')
        notify('turn/started', {'turn': {'id': turn, 'status': 'inProgress'}})
        reply(value, {'turn': {'id': turn, 'status': 'inProgress'}})
        if prompt == 'eof':
            sys.exit(0)
        if prompt == 'custom-environment':
            text(json.dumps({'pid':os.getpid(), **{name:os.environ.get(name) for name in ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','LATTE_TEST_LITERAL','LATTE_TEST_EMPTY','LATTE_TEST_SECRET']}}))
            complete()
        elif prompt == 'failed':
            complete('failed')
        elif prompt == 'wait':
            text('WAITING')
        elif prompt == 'subtask':
            notify('item/started', {'item': {'id': 'agent-activity', 'type': 'subAgentActivity',
                                             'agentThreadId': 'child', 'kind': 'started'}})
            notify('item/started', {'item': {'id': 'agent-tool', 'type': 'collabAgentToolCall', 'tool': 'spawnAgent',
                                             'receiverThreadIds': ['child'],
                                             'agentsStates': {'child': {'status': 'running'}},
                                             'status': 'inProgress'}})
            text('SUBTASK_RUNNING')
        elif prompt == 'background-command':
            # A resumable command: it keeps running natively after the turn
            # ends. The real exit only arrives when a later turn solicits it.
            notify('item/started', {'item': {'id': 'bg-cmd', 'type': 'commandExecution', 'command': 'sleep 300',
                                             'cwd': os.getcwd(), 'status': 'inProgress', 'processId': '91'}})
            text('LONG_COMMAND_RUNNING')
            complete()
        elif prompt == 'release-background-command':
            # The unsolicited exit is tied to the ORIGINAL turn id; params
            # override the notify() turn so the guarded idle channel accepts it.
            notify('item/completed', {'turnId': 'turn-1',
                                      'item': {'id': 'bg-cmd', 'type': 'commandExecution', 'command': 'sleep 300',
                                               'cwd': os.getcwd(), 'status': 'completed', 'exitCode': 0,
                                               'processId': '91', 'aggregatedOutput': 'bg-done'}})
            text('BACKGROUND_RELEASED')
            complete()
        elif prompt in ('approval', 'question'):
            waiting = prompt
            if waiting == 'approval':
                emit({'id': 73, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': thread, 'turnId': turn, 'itemId': 'bash', 'command': 'echo approved', 'cwd': os.getcwd()}})
            else:
                emit({'id': 'ask', 'method': 'item/tool/requestUserInput', 'params': {'threadId': thread, 'turnId': turn, 'itemId': 'question', 'questions': [{'id': 'q', 'header': 'Pick', 'question': 'Choose one', 'options': [{'label': 'A', 'description': 'first'}, {'label': 'B', 'description': 'second'}]}]}})
        else:
            notify('item/reasoning/textDelta', {'itemId': 'thinking', 'delta': 'DO_NOT_PERSIST_REASONING'})
            notify('item/completed', {'item': {'id': 'bash', 'type': 'commandExecution', 'command': 'echo fixture', 'cwd': os.getcwd(), 'status': 'completed', 'exitCode': 0, 'aggregatedOutput': 'fixture'}})
            text(os.environ['LATTE_WORK_CODEX_PROVIDER_TOKEN'] if prompt == 'credential' else 'CODEX:' + prompt)
            complete()
    elif method == 'turn/steer':
        assert params['threadId'] == thread and params['expectedTurnId'] == turn
        extra = params['input'][0]['text']
        if extra == 'reject-steer':
            emit({'id': value['id'], 'error': {'code': -32602, 'message': 'steering rejected'}})
        else:
            reply(value, {'turnId': turn})
            text('STEER:' + extra)
            complete()
    elif method == 'turn/interrupt':
        assert params['turnId'] == turn
        if turn_prompt == 'subtask':
            notify('item/completed', {'item': {'id': 'agent-activity', 'type': 'subAgentActivity',
                                               'agentThreadId': 'child', 'kind': 'completed'}})
            notify('item/completed', {'item': {'id': 'agent-tool', 'type': 'collabAgentToolCall', 'tool': 'spawnAgent',
                                               'receiverThreadIds': ['child'],
                                               'agentsStates': {'child': {'status': 'interrupted'}},
                                               'status': 'interrupted'}})
        complete('interrupted')
        reply(value, {})
    elif method is None and waiting:
        if waiting == 'approval':
            assert value['id'] == 73 and value['result']['decision'] in ('accept', 'decline')
            text('APPROVED' if value['result']['decision'] == 'accept' else 'DENIED')
        else:
            assert value['id'] == 'ask'
            text('ANSWER:' + json.dumps(value['result']['answers']))
        waiting = None
        complete()
    else:
        raise AssertionError(value)
