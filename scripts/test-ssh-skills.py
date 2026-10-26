#!/usr/bin/env python3
"""Run skill E2E through a disposable, host-key-pinned loopback OpenSSH daemon.

Requires ssh, ssh-keygen and sshd; changes no user SSH configuration or live host.
On Linux the system's /run/sshd privilege-separation directory must already exist.
"""
import os
from pathlib import Path
import pwd
import shlex
import shutil
import socket
import subprocess
import tempfile
import time


def config_path(path):
    value = str(path)
    if '\n' in value or '\r' in value:
        raise ValueError('OpenSSH paths cannot contain line breaks')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def main():
    ssh = shutil.which('ssh')
    keygen = shutil.which('ssh-keygen')
    sshd = shutil.which('sshd') or '/usr/sbin/sshd'
    if not ssh or not keygen or not Path(sshd).is_file():
        raise RuntimeError('OpenSSH client and server are required')
    # StrictModes checks every ancestor of authorized_keys; a shared /tmp is
    # rejected on Linux even though this invocation's child directory is private.
    with tempfile.TemporaryDirectory(prefix='latte ssh-', dir=Path.home()) as temporary:
        root = Path(temporary)
        for name in ('host', 'identity', 'wrong-host'):
            subprocess.run([keygen, '-q', '-t', 'ed25519', '-N', '', '-f', str(root / name)], check=True, timeout=10)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        (root / 'sshd_config').write_text(f'''ListenAddress 127.0.0.1
Port {port}
HostKey {config_path(root / 'host')}
PidFile {config_path(root / 'sshd.pid')}
AuthorizedKeysFile {config_path(root / 'identity.pub')}
StrictModes yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
AllowUsers {pwd.getpwuid(os.getuid()).pw_name}
LogLevel VERBOSE
''')
        for name, key in [('known_hosts', 'host'), ('wrong_hosts', 'wrong-host')]:
            (root / name).write_text(f'[127.0.0.1]:{port} ' + (root / f'{key}.pub').read_text())
        (root / 'ssh_config').write_text(f'''Host latte-skill-test latte-skill-badkey
  HostName 127.0.0.1
  Port {port}
  User {pwd.getpwuid(os.getuid()).pw_name}
  IdentityFile {config_path(root / 'identity')}
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  GlobalKnownHostsFile /dev/null
Host latte-skill-test
  UserKnownHostsFile {config_path(root / 'known_hosts')}
Host latte-skill-badkey
  UserKnownHostsFile {config_path(root / 'wrong_hosts')}
''')
        # The production Client still constructs all flags and remote commands.
        # This shim selects only the disposable config; it execs the real OpenSSH.
        tools = root / 'tools'
        tools.mkdir()
        wrapper = tools / 'ssh'
        wrapper.write_text(f'#!/bin/sh\nexec {shlex.quote(ssh)} -E {shlex.quote(str(root / "ssh-client.log"))} -vv -F {shlex.quote(str(root / "ssh_config"))} "$@"\n')
        wrapper.chmod(0o700)
        with (root / 'sshd.log').open('w+') as log:
            daemon = subprocess.Popen([sshd, '-D', '-e', '-f', str(root / 'sshd_config')], stdout=log, stderr=log)
            try:
                for _ in range(100):
                    if daemon.poll() is not None:
                        log.seek(0)
                        raise RuntimeError('disposable sshd failed: ' + log.read())
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=0.1):
                            break
                    except OSError:
                        time.sleep(0.05)
                else:
                    raise RuntimeError('disposable sshd readiness timeout')
                env = {**os.environ, 'PATH': str(tools) + os.pathsep + os.environ['PATH'], 'LATTE_WORK_TEST_SSH': '1'}
                subprocess.run([str(wrapper), '-T', '-o', 'BatchMode=yes', 'latte-skill-test', 'true'],
                               env=env, check=True, timeout=15)
                subprocess.run(['cargo', 'test', '-p', 'latte-work-server', '--test', 'e2e', '--locked',
                    'global_skills_over_real_ssh', '--', '--ignored', '--test-threads=1'], env=env, check=True, timeout=480)
            except Exception:
                log.seek(0)
                print(log.read())
                client_log = root / 'ssh-client.log'
                if client_log.exists():
                    print(client_log.read_text())
                raise
            finally:
                daemon.terminate()
                try:
                    daemon.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    daemon.kill()
                    daemon.wait()


if __name__ == '__main__':
    main()
