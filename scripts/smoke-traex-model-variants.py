#!/usr/bin/env python3
"""Real Traex backend-mode metadata and prompt-free thread checks; no model calls."""
import argparse
import json
import os
import pathlib
import selectors
import signal
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--traex', default=os.path.expanduser('~/.local/bin/traex'))
parser.add_argument('--output', required=True)
parser.add_argument('--model', help='optional native model ID')
args = parser.parse_args()
process = subprocess.Popen([args.traex, 'app-server', '--stdio'], stdin=subprocess.PIPE,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           start_new_session=True, text=True)
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ)
sequence = 0

def rpc(method, params):
    global sequence
    sequence += 1
    process.stdin.write(json.dumps({'id': sequence, 'method': method, 'params': params}) + '\n')
    process.stdin.flush()
    deadline = time.monotonic() + 12
    size = 0
    for _ in range(128):
        if not selector.select(max(0, deadline - time.monotonic())):
            raise TimeoutError(method)
        line = process.stdout.readline(1024 * 1024 + 1)
        size += len(line)
        assert line and size <= 1024 * 1024, 'bounded native output'
        message = json.loads(line)
        assert not ('id' in message and 'method' in message), 'unexpected native action'
        if message.get('id') == sequence:
            assert 'error' not in message, message.get('error')
            return message['result']
    raise RuntimeError('native message limit')

try:
    rpc('initialize', {'clientInfo': {'name': 'latte-work-mode-smoke', 'version': '0.1.0'}})
    process.stdin.write('{"method":"initialized"}\n')
    process.stdin.flush()
    entries = []
    cursor = None
    for _ in range(5):
        result = rpc('model/list', {'limit': 100, 'cursor': cursor})
        entries.extend(result['data'])
        assert len(entries) <= 256
        cursor = result.get('nextCursor')
        if cursor is None:
            break
    assert cursor is None, 'native page limit'
    model = next(entry for entry in entries if (not args.model or entry['id'] == args.model)
                 and not entry.get('hidden')
                 and entry.get('modelFamily') == 'gpt'
                 and entry.get('businessMetadata', {}).get('variants', {}).get('max_key'))
    variants = model['businessMetadata']['variants']
    report = {'model': model['id'], 'max_key': variants['max_key'], 'checks': [],
              'standard_context_window': variants.get('standard_context_window'),
              'max_context_window': variants.get('max_context_window'), 'model_calls': 0}
    with tempfile.TemporaryDirectory(prefix='latte-traex-modes-') as project:
        for mode in ['max', 'standard']:
            response = rpc('thread/start', {'model': model['id'], 'cwd': project,
                           'ephemeral': True, 'config': {'model_backend_variant': mode}})
            assert response.get('modelBackendVariant') == mode, response.get('modelBackendVariant')
            assert response['model'] == model['id']
            report['checks'].append('native thread acknowledges ' + mode)
    pathlib.Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
finally:
    selector.close()
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
