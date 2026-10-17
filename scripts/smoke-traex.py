#!/usr/bin/env python3
"""Isolated real Traex/Server smoke. Metadata-only by default; --live sends two small model turns."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', default='target/debug/latte-work-server')
parser.add_argument('--traex', default=str(Path.home() / '.local/bin/traex'))
parser.add_argument('--output', default='target/traex-native-smoke.json')
parser.add_argument('--live', action='store_true')
parser.add_argument('--model')
parser.add_argument('--live-tools', action='store_true', help='also verify an actual model file write in the disposable project')
args = parser.parse_args()
binary = str(Path(args.binary).resolve())
traex = str(Path(args.traex).resolve())
report = {'cli_version': subprocess.check_output([traex, '--version'], text=True, timeout=5).strip(),
          'binary_sha256': hashlib.sha256(Path(binary).read_bytes()).hexdigest(),
          'live': args.live or args.live_tools, 'checks': []}
with tempfile.TemporaryDirectory(prefix='lw-traex-', dir='/tmp') as directory:
    root = Path(directory)
    project = root / 'project'
    project.mkdir()
    env = {**os.environ, 'LATTE_WORK_AGENT_ENV': 'inherit', 'LATTE_WORK_TRAEX': traex}
    server = subprocess.Popen([binary, 'serve', '--state-dir', str(root / 'state')], env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    connection = None
    try:
        deadline = time.monotonic() + 15
        while not (root / 'state/control.sock').exists():
            if time.monotonic() > deadline or server.poll() is not None:
                raise TimeoutError('isolated Server startup')
            time.sleep(.05)
        connection = socket.socket(socket.AF_UNIX)
        connection.settimeout(25)
        connection.connect(str(root / 'state/control.sock'))
        wire = connection.makefile('rw')

        def rpc(method, **params):
            wire.write(json.dumps({'method': method, **params}) + '\n')
            wire.flush()
            response = json.loads(wire.readline())
            if response['kind'] == 'error':
                raise RuntimeError(response['message'])
            return response

        hello = rpc('hello', version=1)
        assert any(a['id'] == 'traex' and a['available'] for a in hello['agents'])
        catalog = rpc('models_for_provider', agent='traex', model=None, project_id=None, provider=None)
        report['model_count'] = len(catalog['models'])
        if args.model:
            assert args.model in catalog['models'], 'model is not in the native catalog'
            report['selected_model'] = args.model
        report['checks'].append('native model catalog')
        modes = rpc('agent_permissions', agent='traex')['modes']
        assert any(m['id'] == 'default' for m in modes)
        report['checks'].append('native permission discovery')
        pid = rpc('add_project', path=str(project), name=None)['project']['id']
        sid = rpc('create_session', project_id=pid, agent='traex')['session']['id']
        commands = rpc('agent_commands', agent='traex', project_id=pid)
        assert commands['commands'] == []
        rpc('open_agent_session', session_id=sid, provider={'kind': 'cli'})

        def wait(status, timeout=90):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                result = rpc('poll', session_id=sid, after=0)
                if result['session']['status'] == status:
                    return result
                if result['session']['status'] == 'failed':
                    raise RuntimeError(json.dumps(result['events'][-4:], ensure_ascii=False))
                time.sleep(.1)
            raise TimeoutError('Traex ' + status)

        deadline = time.monotonic() + 20
        while True:
            current = rpc('session', session_id=sid)['session']
            if current.get('agent_session_open'):
                break
            if time.monotonic() > deadline:
                raise TimeoutError('native thread open')
            time.sleep(.1)
        assert not rpc('poll', session_id=sid, after=0)['events']
        native = current['native_id']
        report['checks'].append('prompt-free native open')
        if args.live:
            for index, marker in enumerate(['TRAEX_OK', 'TRAEX_RESUMED_OK']):
                receipt = rpc('send_queued', session_id=sid, request_id='smoke-' + str(index),
                              text='Do not use tools. Reply exactly ' + marker + '.', model=args.model,
                              effort=None, permission_mode='default', provider={'kind': 'cli'})
                assert receipt['kind'] in ('accepted', 'message_queued')
                result = wait('completed')
                text = ''.join(e['event']['text'] for e in result['events'] if e['event']['kind'] == 'text')
                assert marker in text, text
                if native is None:
                    native = result['session']['native_id']
                assert native and result['session']['native_id'] == native
                report['checks'].append('real model turn ' + str(index + 1))
                rpc('close_agent_session', session_id=sid, only_if_idle=True)
                rpc('open_agent_session', session_id=sid, provider={'kind': 'cli'})
            report['checks'].append('native close/resume preserves identity')
        if args.live_tools:
            marker = 'TRAEX_FILE_OK'
            rpc('send_queued', session_id=sid, request_id='smoke-file',
                text='Use a tool to create traex-smoke.txt in the current project with exactly TRAEX_FILE_OK. Then reply TRAEX_FILE_OK. Do not do anything else.',
                model=args.model, effort=None, permission_mode='default', provider={'kind': 'cli'})
            result = wait('completed')
            assert (project / 'traex-smoke.txt').read_text().strip() == marker
            assert any(e['event']['kind'] == 'tool' for e in result['events'])
            assert any(e['event']['kind'] == 'tool_result' and not e['event']['is_error'] for e in result['events'])
            report['checks'].append('real model tool writes the requested file')
        rpc('close_agent_session', session_id=sid, only_if_idle=True)
    finally:
        if connection:
            connection.close()
        server.send_signal(signal.SIGINT)
        try:
            server.wait(10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
Path(args.output).parent.mkdir(parents=True, exist_ok=True)
Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
