#!/usr/bin/env python3
"""Real Claude CLI with a localhost Anthropic fixture; no paid API calls.
Verifies explicit binding, tool approval, model changes on resume and protocol rejection.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', default='target/debug/latte-work-server')
parser.add_argument('--claude', default=str(Path.home() / '.local/bin/claude'))
args = parser.parse_args()
binary = str(Path(args.binary).resolve())
claude = str(Path(args.claude).resolve())
KEY = 'latte-local-fixture-key'
with tempfile.TemporaryDirectory(prefix='lw-p-', dir='/tmp') as directory:
    root = Path(directory)
    project = root / 'project'
    project.mkdir()
    target = project / 'provider.txt'
    settings = project / '.claude'
    settings.mkdir()
    (settings / 'settings.json').write_text(json.dumps({'permissions': {'defaultMode': 'manual', 'ask': ['Write']}}))
    expected_model = 'claude-sonnet-4-6'
    requests = []
    failures = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            path = self.path.split('?')[0]
            if path.endswith('/count_tokens'):
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"input_tokens":100}')
                return
            if path != '/v1/messages' or self.headers.get('Authorization') != 'Bearer ' + KEY or body['model'] != expected_model:
                failures.append({'path': path, 'model': body.get('model')})
                self.send_error(400)
                return
            requests.append(body)
            tool_done = any(any(b.get('type') == 'tool_result' for b in (m.get('content') or []) if isinstance(b, dict)) for m in body.get('messages', []))
            use_tool = any(t.get('name') == 'Write' for t in body.get('tools', [])) and not tool_done
            arguments = {'file_path': str(target), 'content': 'PROVIDER_OK'}
            content = [{'type': 'tool_use', 'id': 'call_fixture', 'name': 'Write', 'input': arguments}] if use_tool else [{'type': 'text', 'text': 'PROVIDER_OK'}]
            message = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant', 'model': expected_model, 'content': content, 'stop_reason': 'tool_use' if use_tool else 'end_turn', 'stop_sequence': None, 'usage': {'input_tokens': 100, 'output_tokens': 20}}
            self.send_response(200)
            if not body.get('stream'):
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(message).encode())
                return
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            events = [
                {'type': 'message_start', 'message': {**message, 'content': [], 'stop_reason': None}},
                {'type': 'content_block_start', 'index': 0, 'content_block': {**content[0], **({'input': {}} if use_tool else {'text': ''})}},
                {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(arguments)} if use_tool else {'type': 'text_delta', 'text': 'PROVIDER_OK'}},
                {'type': 'content_block_stop', 'index': 0},
                {'type': 'message_delta', 'delta': {'stop_reason': message['stop_reason'], 'stop_sequence': None}, 'usage': message['usage']},
                {'type': 'message_stop'},
            ]
            try:
                for event in events:
                    self.wfile.write(('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n').encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'CLAUDE_', 'CLAUDECODE'))}
    env.update(CLAUDE_CONFIG_DIR=str(root / 'claude'), LATTE_WORK_CLAUDE=claude, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
    server = subprocess.Popen([binary, 'serve', '--state-dir', str(root / 'state')], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 15
        while not (root / 'state/control.sock').exists():
            if time.monotonic() > deadline:
                raise TimeoutError('server startup')
            time.sleep(.05)
        connection = socket.socket(socket.AF_UNIX)
        connection.settimeout(15)
        connection.connect(str(root / 'state/control.sock'))
        wire = connection.makefile('rw')

        def rpc(value, allow_error=False):
            wire.write(json.dumps(value) + '\n')
            wire.flush()
            result = json.loads(wire.readline())
            if result['kind'] == 'error' and not allow_error:
                raise RuntimeError(result['message'])
            return result

        rpc({'method': 'hello', 'version': 1})
        draft = {'id': None, 'name': 'Fixture', 'protocol': 'anthropic_messages', 'base_url': f'http://127.0.0.1:{httpd.server_port}', 'model': expected_model, 'models': ['claude-opus-4-7'], 'auth': 'bearer', 'credential': KEY}
        saved = rpc({'method': 'save_provider', 'provider': draft})
        assert not saved['bindings']
        provider_id = saved['providers'][0]['id']
        rpc({'method': 'bind_agent_provider', 'agent': 'claude', 'provider_id': provider_id, 'target': None})
        pid = rpc({'method': 'add_project', 'path': str(project)})['project']['id']
        sid = rpc({'method': 'create_session', 'project_id': pid, 'agent': 'claude'})['session']['id']
        seen = set()
        approvals = 0
        for turn in range(3):
            if turn:
                expected_model = 'claude-opus-4-7'
                assert rpc({'method': 'models', 'agent': 'claude'})['default_model'] == 'claude-sonnet-4-6'
            prompt = 'Only reply PROVIDER_OK, do not use tools.' if turn else f'Use Write to create {target} with PROVIDER_OK then reply PROVIDER_OK.'
            before = len(requests)
            effort = ['high', 'low', None][turn]
            rpc({'method': 'send', 'session_id': sid, 'request_id': f'turn-{turn}', 'text': prompt, 'model': expected_model if turn else None, 'effort': effort})
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                result = rpc({'method': 'poll', 'session_id': sid, 'after': 0})
                for event in (e['event'] for e in result['events']):
                    if event['kind'] == 'approval' and event['request_id'] not in seen:
                        seen.add(event['request_id'])
                        allow = event['tool'] == 'Write' and Path(event['input'].get('file_path', '')).resolve() == target.resolve()
                        rpc({'method': 'approve', 'session_id': sid, 'request_id': event['request_id'], 'allow': allow})
                        approvals += int(allow)
                if result['session']['status'] not in ('running', 'waiting'):
                    break
                time.sleep(.1)
            text = ''.join(e['event']['text'] for e in result['events'] if e['event']['kind'] == 'text')
            assert result['session']['status'] == 'completed' and 'PROVIDER_OK' in text, result
            assert target.read_text() == 'PROVIDER_OK' and approvals > 0
            assert len(requests) > before and requests[-1]['model'] == expected_model and not failures
            actual_effort = requests[-1].get('output_config', {}).get('effort')
            assert actual_effort == ['high', 'low', 'xhigh'][turn], actual_effort
            assert result['session']['effort'] == effort
            assert result['session']['model'] == (expected_model if turn else None)
            assert KEY not in json.dumps(result)
            print(json.dumps({'model': expected_model, 'resume': bool(turn), 'effort': effort, 'api_effort': actual_effort, 'verified': True}), flush=True)
        for protocol in ['openai_chat', 'openai_responses']:
            saved = rpc({'method': 'save_provider', 'provider': {**draft, 'name': protocol, 'protocol': protocol}})
            incompatible = saved['providers'][-1]['id']
            result = rpc({'method': 'bind_agent_provider', 'agent': 'claude', 'provider_id': incompatible, 'target': None}, allow_error=True)
            assert result['kind'] == 'error'
            print(json.dumps({'protocol': protocol, 'claude_binding_rejected': True}), flush=True)
        wire.close()
        connection.close()
    finally:
        server.send_signal(signal.SIGINT)
        try:
            server.wait(timeout=6)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        httpd.shutdown()
        httpd.server_close()
