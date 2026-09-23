#!/usr/bin/env python3
"""Optional live integration check using the host's Claude login, outside make ci.
Only approves Write to the exact disposable smoke-test file. No real project is read.
"""
import argparse
import json
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', default='target/debug/latte-work-server')
parser.add_argument('--approval', action='store_true')
args = parser.parse_args()
binary = str(Path(args.binary).resolve())
with tempfile.TemporaryDirectory(prefix='lw-live-', dir='/tmp') as state, tempfile.TemporaryDirectory(prefix='lw-proj-', dir='/tmp') as project:
    target = Path(project, 'approval.txt').resolve()
    if args.approval:
        settings = Path(project, '.claude')
        settings.mkdir()
        (settings / 'settings.json').write_text(json.dumps({'permissions': {'defaultMode': 'manual', 'ask': ['Write', 'Bash', 'Edit']}}))
    server = subprocess.Popen([binary, 'serve', '--state-dir', state], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 15
        while not Path(state, 'control.sock').exists():
            if time.monotonic() > deadline:
                raise RuntimeError('Server did not become ready')
            time.sleep(.1)
        connection = socket.socket(socket.AF_UNIX)
        connection.settimeout(10)
        connection.connect(state + '/control.sock')
        wire = connection.makefile('rw')
        def rpc(value):
            wire.write(json.dumps(value) + '\n')
            wire.flush()
            result = json.loads(wire.readline())
            if result.get('kind') == 'error':
                raise RuntimeError(result['message'])
            return result
        hello = rpc({'method': 'hello', 'version': 8})
        project_id = rpc({'method': 'add_project', 'path': project})['project']['id']
        session_id = rpc({'method': 'create_session', 'project_id': project_id, 'agent': 'claude'})['session']['id']
        prompt = f'Application integration test: use Write to create exactly {target} containing LATTE_APPROVAL_OK. Do not use other tools. Then reply done.' if args.approval else 'Only reply LATTE_WORK_SMOKE_OK. Do not read files or call tools.'
        rpc({'method': 'send', 'session_id': session_id, 'request_id': 'live-smoke', 'text': prompt})
        deadline = time.monotonic() + 120
        seen = set()
        approvals = 0
        while time.monotonic() < deadline:
            result = rpc({'method': 'poll', 'session_id': session_id, 'after': 0})
            for item in result['events']:
                event = item['event']
                if event['kind'] == 'approval' and event['request_id'] not in seen:
                    seen.add(event['request_id'])
                    path = Path(event['input'].get('file_path', ''))
                    if not path.is_absolute():
                        path = Path(project) / path
                    allow = args.approval and event['tool'] == 'Write' and path.resolve() == target
                    rpc({'method': 'approve', 'session_id': session_id, 'request_id': event['request_id'], 'allow': allow})
                    approvals += int(allow)
                    print(json.dumps({'tool': event['tool'], 'allowed': allow}), flush=True)
            if result['session']['status'] not in ('running', 'waiting'):
                text = ''.join(item['event']['text'] for item in result['events'] if item['event']['kind'] == 'text')
                verified = (approvals > 0 and target.exists() and target.read_text().strip() == 'LATTE_APPROVAL_OK') if args.approval else 'LATTE_WORK_SMOKE_OK' in text
                summary = {'status': result['session']['status'], 'verified': verified, 'approvals': approvals, 'agents': hello['agents']}
                print(json.dumps(summary, ensure_ascii=False), flush=True)
                if result['session']['status'] != 'completed' or not verified:
                    raise RuntimeError('Live smoke did not meet its assertions')
                break
            time.sleep(.3)
        else:
            rpc({'method': 'cancel', 'session_id': session_id})
            raise TimeoutError('Live Claude smoke exceeded 120 seconds')
        wire.close()
        connection.close()
    finally:
        server.send_signal(signal.SIGINT)
        try:
            server.wait(timeout=6)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
