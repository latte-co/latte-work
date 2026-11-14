#!/usr/bin/env python3
"""Strict Codex app-server fixture; no account, model or shared daemon."""
import json
import os
import pathlib
import signal
import subprocess
import sys
import threading
import time

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
title_only = False
title_provider = None


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
        config_file = pathlib.Path('codex-native-config.json')
        reply(value, {'config': json.loads(config_file.read_text()) if config_file.exists() else {'model_provider': None, 'model': None, 'developer_instructions': 'NATIVE_CODEX_INSTRUCTIONS'}})
    elif method == 'thread/fork' or (method == 'thread/resume' and params['threadId'].startswith('side-thread-')):
        sandbox, approval = {
            'read-only': ('readOnly', 'never'),
            'workspace-write': ('workspaceWrite', 'on-request'),
            'danger-full-access': ('dangerFullAccess', 'never'),
        }[params['sandbox']]
        assert params['approvalPolicy'] == approval
        assert 'inherited messages' in params['developerInstructions']
        if method == 'thread/fork':
            assert params['threadId'] == thread and params['excludeTurns']
        parent_thread = thread
        thread = f'side-thread-{os.getpid()}' if method == 'thread/fork' else params['threadId']
        reply(value, {'thread': {'id': thread, 'forkedFromId': parent_thread},
                      'sandbox': {'type': sandbox}, 'approvalPolicy': approval})
    elif method in ('thread/start', 'thread/resume'):
        if params.get('ephemeral'):
            expected_env = pathlib.Path('title-environment.json')
            if expected_env.exists():
                for key, expected in json.loads(expected_env.read_text()).items():
                    assert os.environ.get(key) == expected
            assert params['sandbox'] == 'read-only'
            assert params['config']['features.shell_tool'] is False
            assert params['config']['features.plugins'] is False
            assert params['config']['notify'] == []
            assert params['config']['features.stable_environment_tools'] is False
            assert params['config']['features.sleep_tool'] is False
            assert params['environments'] == [] and params['dynamicTools'] == []
            assert params['developerInstructions'] == ''
            title_only = True
            title_provider = params['modelProvider']
            thread = 'codex-title-thread'
            reply(value, {'thread': {'id': thread, 'ephemeral': True}, 'sandbox': {'type': 'readOnly'}})
            continue
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
        if title_only:
            assert params['threadId'] == thread and params['outputSchema']['required'] == ['title']
            description = params['input'][0]['text']
            with pathlib.Path('codex-title-inputs').open('a') as f:
                f.write(json.dumps({'description': description, 'pid': os.getpid(), 'provider': title_provider, 'effort': params.get('effort')}) + '\n')
            turn = 'title-turn'
            early_title = 'native-auto-title-early' in description
            if not early_title:
                notify('turn/started', {'turn': {'id': turn, 'status': 'inProgress'}})
                reply(value, {'turn': {'id': turn, 'status': 'inProgress'}})
            if 'native-auto-title-held' in description:
                deadline = time.monotonic() + 10
                while not pathlib.Path('title-release').exists() and time.monotonic() < deadline:
                    time.sleep(.02)
            if 'native-auto-title-failed' in description:
                pathlib.Path('title-response').write_text('sent')
                complete('failed')
            else:
                title = '' if 'native-auto-title-empty' in description else '修复附件拖入失败'
                # Unrelated output must not become a title.
                notify('item/completed', {'threadId': 'other', 'item': {'id': 'bad', 'type': 'agentMessage', 'text': '{"title":"wrong"}'}})
                text(json.dumps({'title': title}, ensure_ascii=False))
                pathlib.Path('title-response').write_text('sent')
                complete()
            if early_title:
                reply(value, {'turn': {'id': turn, 'status': 'completed'}})
            continue
        assert 'modelProvider' not in params and 'modelBackendVariant' not in params, params
        assert params['threadId'] == thread
        assert params.get('model') in (None, 'codex-test', 'custom-codex')
        count += 1
        turn = 'turn-' + str(count)
        prompt = params['input'][0]['text']
        turn_prompt = prompt
        if prompt in ('native-provider-selection-drift', 'native-provider-endpoint-drift', 'native-provider-openai-base-url-drift'):
            config_file = pathlib.Path('codex-native-config.json')
            changed = json.loads(config_file.read_text())
            if prompt.endswith('selection-drift'):
                changed['model_provider'] = 'second'
            elif prompt == 'native-provider-openai-base-url-drift':
                changed['openai_base_url'] = 'http://localhost:9999/v1'
            else:
                changed['model_providers']['first']['base_url'] = 'http://localhost:9999/v1'
            config_file.write_text(json.dumps(changed))
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
        elif prompt == 'side-background-write':
            notify('item/started', {'item': {'id': 'side-writer', 'type': 'commandExecution',
                                             'command': 'write after signal', 'cwd': os.getcwd(),
                                             'status': 'inProgress', 'processId': '92'}})
            origin_turn = turn
            complete()
            def write_after_signal():
                deadline = time.monotonic() + 15
                while not pathlib.Path('release-side-writer').exists():
                    if time.monotonic() >= deadline:
                        return
                    time.sleep(.02)
                pathlib.Path('shared.txt').write_text('side edit\n')
                notify('item/completed', {'turnId': origin_turn, 'item': {
                    'id': 'side-writer', 'type': 'commandExecution', 'command': 'write after signal',
                    'cwd': os.getcwd(), 'status': 'completed', 'exitCode': 0, 'processId': '92'}})
            threading.Thread(target=write_after_signal, daemon=True).start()
        elif prompt in ('side-foreground-write', 'side-foreground-write-nested', 'main-foreground-write'):
            path = 'sub/shared.txt' if prompt == 'side-foreground-write-nested' else 'shared.txt'
            content = 'main edit\n' if prompt == 'main-foreground-write' else 'side edit\n'
            pathlib.Path(path).write_text(content)
            complete()
        elif prompt == 'side-cross-project-write':
            assert thread.startswith('side-thread-') and sandbox == 'dangerFullAccess'
            pathlib.Path('../main-project/shared.txt').write_text('side edit\n')
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
        elif prompt in ('approval', 'approval-then-main-write', 'side-write-until-closed', 'question'):
            if prompt == 'side-write-until-closed':
                worker = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
                def stop_side_writer(*_):
                    worker.wait(timeout=1)
                    sys.exit(0)
                signal.signal(signal.SIGTERM, stop_side_writer)
                pathlib.Path('side-writer-pids').write_text(f'{os.getpid()} {worker.pid}')
                pathlib.Path('shared.txt').write_text('side edit\n')
                notify('item/started', {'item': {'id': 'side-worker', 'type': 'commandExecution',
                                                 'command': 'background worker', 'cwd': os.getcwd(),
                                                 'status': 'inProgress', 'processId': str(worker.pid)}})
            waiting = 'question' if prompt == 'question' else 'approval'
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
            if turn_prompt == 'approval-then-main-write' and value['result']['decision'] == 'accept':
                pathlib.Path('shared.txt').write_text('main edit\n')
            text('APPROVED' if value['result']['decision'] == 'accept' else 'DENIED')
        else:
            assert value['id'] == 'ask'
            text('ANSWER:' + json.dumps(value['result']['answers']))
        waiting = None
        complete()
    else:
        raise AssertionError(value)
