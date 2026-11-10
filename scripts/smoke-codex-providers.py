#!/usr/bin/env python3
"""Real installed Codex + Server against disposable localhost providers; no paid API.
Checks Responses authentication, provider/model changes on resume,
CLI restoration and credential absence from persisted state and CLI argv.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', default='target/debug/latte-work-server')
parser.add_argument('--codex', default=shutil.which('codex') or 'codex')
parser.add_argument('--output', default='target/codex-provider-smoke.json')
args = parser.parse_args()
binary = str(Path(args.binary).resolve())
if not Path(args.codex).exists():
    raise SystemExit(f'codex CLI 不存在: {args.codex}（请安装后重试或用 --codex 指定路径）')
codex = str(Path(args.codex).resolve())
KEY = 'latte-codex-fixture-secret-91b4'

def kill_agent_groups(server_pid):
    """SIGKILL of the Server's own group cannot reach the agents: the runtime
    puts every agent into a fresh process group (PGID = its own PID), and a
    killed Server never runs its Group drop. Collect the Server's direct
    children while it is still alive and kill each agent group explicitly."""
    try:
        children = subprocess.check_output(
            ['pgrep', '-P', str(server_pid)], text=True
        ).split()
    except (subprocess.CalledProcessError, OSError):
        return
    for child in children:
        try:
            os.killpg(int(child), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
seen = []
title_requests = []
tool_called = False
native_config_drift = None

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        global tool_called
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        title_request = 'title' in body.get('text', {}).get('format', {}).get('schema', {}).get('properties', {})
        if title_request:
            title_requests.append(body)
            assert not body.get('tools'), body.get('tools')
        if not title_request and 'NATIVE_PROVIDER_DRIFT_CHECK' in json.dumps(body.get('input', [])):
            config, origin = native_config_drift
            config.write_text(config.read_text().replace('model_provider="cli-fixture"', 'model_provider="changed-fixture"', 1)
                              + f'\n[model_providers.changed-fixture]\nname="Changed"\nbase_url="{origin}/changed/v1"\nwire_api="responses"\nrequires_openai_auth=false\n')
        if not title_request and 'BUILTIN_OPENAI_ENDPOINT_DRIFT_CHECK' in json.dumps(body.get('input', [])):
            config, origin = native_config_drift
            config.write_text(config.read_text().replace(f'openai_base_url="{origin}/builtin-a/v1"',
                                                        f'openai_base_url="{origin}/builtin-b/v1"', 1))
        seen.append({'path': self.path, 'model': body.get('model'),
                     'title_request': title_request, 'reasoning_effort': body.get('reasoning', {}).get('effort'),
                     'authorization': self.headers.get('Authorization'),
                     'api_key': self.headers.get('x-api-key'), 'old_header': self.headers.get('X-Old-Header')})
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        marker = json.dumps({'title': '检查 Codex Provider 切换'}, ensure_ascii=False) if title_request else 'PROVIDER_OK'
        if self.path.endswith('/responses') and 'NATIVE_TOOL_CHECK' in json.dumps(body.get('input', [])) and not tool_called:
            assert any(t.get('name') == 'exec_command' for t in body.get('tools', [])), 'native exec_command not offered'
            tool_called = True
            item = {'id': 'fc_fixture', 'type': 'function_call', 'call_id': 'call_fixture', 'name': 'exec_command',
                    'arguments': json.dumps({'cmd': 'printf NATIVE_TOOL_OK > native-tool.txt', 'max_output_tokens': 100})}
            events = [
                {'type': 'response.created', 'response': {'id': 'resp_tool', 'status': 'in_progress', 'output': []}},
                {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'arguments': ''}},
                {'type': 'response.function_call_arguments.delta', 'item_id': item['id'], 'output_index': 0, 'delta': item['arguments']},
                {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                {'type': 'response.completed', 'response': {'id': 'resp_tool', 'object': 'response', 'status': 'completed', 'output': [item], 'usage': {'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15}}},
            ]
        elif self.path.endswith('/responses'):
            item = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': marker, 'annotations': []}]}
            events = [
                {'type': 'response.created', 'response': {'id': 'resp_fixture', 'status': 'in_progress', 'output': []}},
                {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'content': []}},
                {'type': 'response.output_text.delta', 'item_id': 'msg_fixture', 'output_index': 0, 'content_index': 0, 'delta': marker},
                {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                {'type': 'response.completed', 'response': {'id': 'resp_fixture', 'object': 'response', 'status': 'completed', 'output': [item], 'usage': {'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15}}},
            ]
        else:
            raise AssertionError('Unexpected endpoint: ' + self.path)
        for event in events:
            prefix = 'event: ' + event['type'] + '\n' if 'type' in event else ''
            self.wfile.write((prefix + 'data: ' + json.dumps(event) + '\n\n').encode())
        self.wfile.flush()

httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
report = {'cli_version': subprocess.check_output([codex, '--version'], text=True, timeout=5).strip(),
          'binary_sha256': hashlib.sha256(Path(binary).read_bytes()).hexdigest(), 'checks': []}
try:
    with tempfile.TemporaryDirectory(prefix='lw-codex-p-', dir='/tmp') as directory:
        root = Path(directory)
        project = root / 'project'
        project.mkdir()
        native = root / 'codex'
        native.mkdir()
        origin = f'http://127.0.0.1:{httpd.server_port}'
        notify = root / 'notify.py'
        notify.write_text('import pathlib,sys\nwith pathlib.Path(__file__).with_suffix(".events").open("a") as f: f.write(sys.argv[-1]+"\\n")\n')
        (native / 'config.toml').write_text(f'model="cli-model"\nmodel_provider="cli-fixture"\nmodel_reasoning_effort="high"\nnotify=["python3", {json.dumps(str(notify))}]\n[features]\nstable_environment_tools=true\nsleep_tool={{enabled=true,mode="always_on"}}\n[model_providers.cli-fixture]\nname="CLI Fixture"\nbase_url="{origin}/cli/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[model_providers.latte-work]\nname="Old"\nbase_url="http://127.0.0.1:1"\nwire_api="responses"\nexperimental_bearer_token="legacy-fixture-token"\nhttp_headers={{X-Old-Header="legacy"}}\n')
        env = {**os.environ, 'LATTE_WORK_AGENT_ENV': 'inherit', 'LATTE_WORK_CODEX': codex, 'CODEX_HOME': str(native),
               'OPENAI_API_KEY': 'latte-builtin-openai-fixture-key'}
        env.pop('OPENAI_BASE_URL', None)
        server = subprocess.Popen([binary, 'serve', '--state-dir', str(root / 'state')], env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        connection = None
        try:
            deadline = time.monotonic() + 15
            while not (root / 'state/control.sock').exists():
                if time.monotonic() > deadline or server.poll() is not None:
                    raise TimeoutError('Server startup')
                time.sleep(.05)
            connection = socket.socket(socket.AF_UNIX)
            connection.settimeout(25)
            connection.connect(str(root / 'state/control.sock'))
            wire = connection.makefile('rw')

            def rpc(method, **params):
                wire.write(json.dumps({'method': method, **params}) + '\n')
                wire.flush()
                value = json.loads(wire.readline())
                if value['kind'] == 'error':
                    raise RuntimeError(value['message'])
                return value

            rpc('hello', version=1)
            pid = rpc('add_project', path=str(project), name=None)['project']['id']
            sid = rpc('create_session', project_id=pid, agent='codex')['session']['id']
            native_id = None
            cases = [('openai_responses', 'bearer'), ('openai_responses', 'api_key'), ('openai_responses', 'none')]
            for index, case in enumerate([*cases, None]):
                if case:
                    protocol, auth = case
                    model = f'provider-model-{index}'
                    provider = {'id': 'fixture', 'name': 'Fixture', 'protocol': protocol, 'base_url': origin + '/v1',
                                'model': model, 'models': [model + '-other'], 'auth': auth, 'has_credential': auth != 'none', 'revision': str(index)}
                    catalog = rpc('models_for_provider', agent='codex', model=model, project_id=pid, provider=provider)
                    assert catalog['models'] == [model, model + '-other'] and not catalog['effort_levels']
                    choice = {'kind': 'snapshot', 'snapshot': {'provider': provider, 'credential': KEY if auth != 'none' else ''}}
                else:
                    model, auth = 'cli-model', 'none'
                    choice = {'kind': 'cli'}
                before = len(seen)
                rpc('send_queued', session_id=sid, request_id='provider-' + str(index), text='Reply PROVIDER_OK. Do not use tools.',
                    model=model if case and index else None, effort=None, permission_mode='default', provider=choice)
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    value = rpc('poll', session_id=sid, after=0)
                    status = value['session']['status']
                    if status == 'completed':
                        break
                    if status not in ('running', 'waiting'):
                        raise RuntimeError(json.dumps(value, ensure_ascii=False))
                    time.sleep(.1)
                else:
                    raise TimeoutError('native Provider turn')
                assert len(seen) > before, value
                actual = seen[-1]
                assert actual['model'] == model, actual
                assert actual['old_header'] is None, actual
                expected_path = '/v1/responses' if case else '/cli/v1/responses'
                assert actual['path'] == expected_path, actual
                assert actual['authorization'] == ('Bearer ' + KEY if auth == 'bearer' else None), actual
                assert actual['api_key'] == (KEY if auth == 'api_key' else None), actual
                text = ''.join(e['event'].get('text', '') for e in value['events'] if e['event']['kind'] == 'text')
                assert 'PROVIDER_OK' in text
                if index == 0:
                    while time.monotonic() < deadline:
                        value = rpc('poll', session_id=sid, after=0)
                        if value['session']['title'] == '检查 Codex Provider 切换':
                            break
                        time.sleep(.1)
                    else:
                        raise TimeoutError('native automatic title: ' + json.dumps(value, ensure_ascii=False))
                    assert len(title_requests) == 1 and not value['session']['custom_title']
                    assert len([e for e in value['events'] if e['event']['kind'] == 'user']) == 1
                    title_input = json.dumps(title_requests[0]['input'], ensure_ascii=False)
                    assert 'Assistant reply:' in title_input and 'PROVIDER_OK' in title_input
                    report['checks'].append('ephemeral automatic title uses first reply, exposes no tools and adds no visible turn')
                current_native = value['session']['native_id']
                assert current_native and (native_id is None or current_native == native_id)
                native_id = current_native
                assert KEY not in subprocess.check_output(['ps', '-Ao', 'args='], text=True), 'credential in argv'
                # Alternate explicit close/resume with automatic idle reconfiguration.
                if index % 2:
                    rpc('close_agent_session', session_id=sid, only_if_idle=True)
                report['checks'].append({'protocol': case[0] if case else 'restored CLI config', 'auth': auth, 'endpoint': actual['path'], 'model': model})
            rpc('send_queued', session_id=sid, request_id='native-tool', text='NATIVE_TOOL_CHECK', model=None, effort=None, permission_mode='default', provider={'kind': 'cli'})
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                value = rpc('poll', session_id=sid, after=0)
                if value['session']['status'] == 'completed':
                    break
                if value['session']['status'] not in ('running', 'waiting'):
                    raise RuntimeError(json.dumps(value, ensure_ascii=False))
                time.sleep(.1)
            else:
                raise TimeoutError('native tool execution')
            assert tool_called and (project / 'native-tool.txt').read_text() == 'NATIVE_TOOL_OK'
            assert any(e['event']['kind'] == 'tool' for e in value['events'])
            assert any(e['event']['kind'] == 'tool_result' and not e['event']['is_error'] for e in value['events'])
            report['checks'].append('real CLI executes fixture-requested shell tool and records its result')
            # A native config with no model must use the current catalog default,
            # rather than inheriting the previous Provider model from its rollout.
            rpc('close_agent_session', session_id=sid, only_if_idle=True)
            config = native / 'config.toml'
            config.write_text(config.read_text().replace('model="cli-model"\n', '', 1))
            default = rpc('models_for_provider', agent='codex', model=None, project_id=pid, provider=None)['default_model']
            assert default
            before = len(seen)
            rpc('send_queued', session_id=sid, request_id='native-default', text='Reply PROVIDER_OK. Do not use tools.', model=None, effort=None, permission_mode='default', provider={'kind': 'cli'})
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                value = rpc('poll', session_id=sid, after=0)
                if value['session']['status'] == 'completed':
                    break
                if value['session']['status'] not in ('running', 'waiting'):
                    raise RuntimeError(json.dumps(value, ensure_ascii=False))
                time.sleep(.1)
            else:
                raise TimeoutError('native default model turn')
            assert len(seen) > before and seen[-1]['model'] == default, seen[-1]
            assert seen[-1]['path'] == '/cli/v1/responses'
            assert value['session']['native_id'] == native_id
            report['checks'].append('unset CLI model resolves current catalog default on resume')
            # Changing the active native provider during a turn must not route
            # its private transcript to the newly selected service for naming.
            drift_id = rpc('create_session', project_id=pid, agent='codex')['session']['id']
            native_config_drift = (config, origin)
            before = len(seen)
            before_titles = len(title_requests)
            rpc('send_queued', session_id=drift_id, request_id='native-provider-drift', text='NATIVE_PROVIDER_DRIFT_CHECK. Reply PROVIDER_OK.', model=None, effort='low', permission_mode='default', provider={'kind': 'cli'})
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                value = rpc('poll', session_id=drift_id, after=0)
                if value['session']['title'] == '检查 Codex Provider 切换' and value['session']['status'] == 'completed':
                    break
                if value['session']['status'] not in ('running', 'waiting', 'completed'):
                    raise RuntimeError(json.dumps(value, ensure_ascii=False))
                time.sleep(.1)
            else:
                raise TimeoutError('native provider snapshot title: ' + json.dumps(value, ensure_ascii=False))
            assert len(title_requests) == before_titles + 1
            actual = seen[before:]
            assert len(actual) == 2 and {item['title_request'] for item in actual} == {True, False}, actual
            assert all(item['path'] == '/cli/v1/responses' and item['reasoning_effort'] == 'low' for item in actual), actual
            report['checks'].append('CLI title pins the first-turn provider across native selection changes and forwards low effort over a high native default')
            # Built-in OpenAI routes via a top-level setting, with no custom
            # model_providers.openai definition. Changing it must decline naming.
            config.write_text(f'model={json.dumps(default)}\nmodel_provider="openai"\nopenai_base_url="{origin}/builtin-a/v1"\n')
            builtin_id = rpc('create_session', project_id=pid, agent='codex')['session']['id']
            before = len(seen)
            before_titles = len(title_requests)
            prompt = 'BUILTIN_OPENAI_ENDPOINT_DRIFT_CHECK. Reply PROVIDER_OK.'
            rpc('send_queued', session_id=builtin_id, request_id='builtin-openai-endpoint-drift', text=prompt,
                model=None, effort='low', permission_mode='default', provider={'kind': 'cli'})
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                value = rpc('poll', session_id=builtin_id, after=0)
                if value['session']['status'] == 'completed' and any(
                    event['event']['kind'] == 'notice' and 'Provider 配置已变化' in event['event'].get('text', '')
                    for event in value['events']
                ):
                    break
                if value['session']['status'] not in ('running', 'waiting', 'completed'):
                    raise RuntimeError(json.dumps(value, ensure_ascii=False))
                time.sleep(.1)
            else:
                raise TimeoutError('built-in OpenAI endpoint drift: ' + json.dumps(value, ensure_ascii=False))
            assert f'openai_base_url="{origin}/builtin-b/v1"' in config.read_text()
            assert len(title_requests) == before_titles, seen[before:]
            assert len(seen[before:]) == 1 and seen[-1]['path'] == '/builtin-a/v1/responses', seen[before:]
            assert value['session']['title'] == prompt[:48], value['session']
            report['checks'].append('built-in OpenAI top-level endpoint A to B drift declines naming before sending any title request')
            deadline = time.monotonic() + 5
            while not notify.with_suffix('.events').exists():
                assert time.monotonic() < deadline, 'regular native turns must exercise legacy notify'
                time.sleep(.05)
            notifications = [json.loads(line) for line in notify.with_suffix('.events').read_text().splitlines()]
            assert notifications and all('检查 Codex Provider 切换' not in json.dumps(event, ensure_ascii=False) for event in notifications)
            report['checks'].append('title requests expose no tools with inherited stable environment/sleep features and never run legacy notify')
            # Check the durable Server and native rollout files, not transient WAL state alone.
            for directory, _, files in os.walk(root):
                for name in files:
                    file = Path(directory) / name
                    try:
                        if file.is_file() and not file.is_symlink() and file.stat().st_size < 8 * 1024 * 1024:
                            assert KEY.encode() not in file.read_bytes(), f'credential persisted: {file.relative_to(root)}'
                    except FileNotFoundError:
                        pass  # Native CLI temporary files may disappear during the scan.
            report['checks'].append('same native identity across automatic provider reconfiguration and explicit close/resume; credential absent from durable files')
        finally:
            if connection:
                connection.close()
            os.killpg(server.pid, signal.SIGTERM)
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # Agents live in their own process groups; kill them while the
                # Server is still alive and their PIDs are discoverable.
                kill_agent_groups(server.pid)
                os.killpg(server.pid, signal.SIGKILL)
                server.wait()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
finally:
    httpd.shutdown()
    httpd.server_close()
