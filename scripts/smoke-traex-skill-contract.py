#!/usr/bin/env python3
"""Verify the installed Traex skill-injection protocol without a thread or model turn."""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile


async def read_config(binary):
    sentinel = 'LATTE_WORK_SKILL_CONTRACT_SENTINEL'
    process = await asyncio.create_subprocess_exec(
        binary, 'app-server', '--stdio', '-c', f'developer_instructions="{sentinel}"',
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, limit=4 * 1024 * 1024,
    )

    async def request(identity, method, params):
        process.stdin.write((json.dumps({'id': identity, 'method': method, 'params': params}) + '\n').encode())
        await process.stdin.drain()
        for _ in range(100):
            line = await asyncio.wait_for(process.stdout.readline(), 8)
            if not line:
                raise RuntimeError('Traex closed before its metadata response')
            response = json.loads(line)
            if response.get('id') == identity:
                if 'error' in response:
                    raise RuntimeError('Traex rejected the metadata request')
                return response['result']
        raise RuntimeError('Traex metadata message limit exceeded')

    try:
        await request(1, 'initialize', {'clientInfo': {'name': 'latte-skill-contract', 'version': '1'}, 'capabilities': {'experimentalApi': True}})
        process.stdin.write(b'{"method":"initialized"}\n')
        await process.stdin.drain()
        result = await request(2, 'config/read', {'includeLayers': False})
        assert result['config']['developer_instructions'] == sentinel, 'configured developer instructions missing'
    finally:
        process.stdin.close()
        if process.returncode is None:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), 5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--traex', default=str(Path.home() / '.local/bin/traex'))
    parser.add_argument('--output', default='target/traex-skill-contract.json')
    args = parser.parse_args()
    binary = str(Path(args.traex).resolve(strict=True))
    version = subprocess.check_output([binary, '--version'], text=True, timeout=5).strip()
    schemas = {}
    with tempfile.TemporaryDirectory(prefix='latte-skill-schema-') as temporary:
        subprocess.run([binary, 'app-server', 'generate-json-schema', '--out', temporary], check=True,
                       timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for name in ['ThreadStartParams', 'ThreadResumeParams', 'ConfigReadResponse']:
            path = Path(temporary) / 'v2' / f'{name}.json'
            data = json.loads(path.read_text())
            if name == 'ConfigReadResponse':
                field = data['definitions']['Config']['properties']['developer_instructions']
            else:
                field = data['properties']['developerInstructions']
            assert 'string' in field['type'], f'{name} instruction type changed'
            schemas[name] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'instruction_field': field}
    asyncio.run(read_config(binary))
    report = {'cli_version': version, 'schemas': schemas, 'config_read_preserves_sentinel': True,
              'thread_started': False, 'prompts_sent': 0}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
