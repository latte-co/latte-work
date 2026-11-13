#!/usr/bin/env python3
"""Run the real OpenCode CLI through Latte Work, using a disposable loopback model."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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


class Model(BaseHTTPRequestHandler):
    calls = []

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.calls.append(request)
        last = request["messages"][-1]
        if last["role"] == "tool":
            delta = {"role": "assistant", "content": "TOOL_SMOKE_OK"}
            finish = "stop"
        elif "permission sentinel" in str(last["content"]) or "cancel sentinel" in str(last["content"]):
            marker = "smoke-cancelled.txt" if "cancel sentinel" in str(last["content"]) else "smoke-approved.txt"
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "id": "call_permission", "type": "function",
                "function": {"name": "shell", "arguments": json.dumps({
                    "command": f"printf OC_EXECUTED > {marker}", "description": "Write smoke marker",
                })},
            }]}
            finish = "tool_calls"
        else:
            delta = {"role": "assistant", "content": "OPEN_CODE_SMOKE_OK"}
            finish = "stop"
        chunks = [
            {"choices": [{"delta": delta, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": finish}]},
            {"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 6, "total_tokens": 26}},
        ]
        payload = "".join("data: " + json.dumps({
            "id": "fixture", "object": "chat.completion.chunk", "created": 0, "model": "test-model",
            **chunk,
        }) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload.encode())))
        self.end_headers()
        self.wfile.write(payload.encode())

    def log_message(self, *_):
        pass


def run(binary, cli, llm, root):
    state = root / "state"
    project = root / "workspace"
    project.mkdir()
    config = root / "config"
    config.mkdir()
    models = root / "models.json"
    models.write_text("{}")
    model = {
        "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
        "limit": {"context": 100_000, "output": 10_000},
        "variants": [{"id": "low"}, {"id": "high"}],
    }
    base_url = f"http://127.0.0.1:{llm.server_port}/v1"
    (config / "opencode.json").write_text(json.dumps({
        "update": "disable",
        "model": "test/test-model",
        "providers": {
            "test": {"name": "Smoke", "package": "aisdk:@ai-sdk/openai-compatible",
                     "settings": {"apiKey": "fixture", "baseURL": base_url},
                     "models": {"test-model": {**model, "name": "Smoke Model"}}},
        },
    }))
    (project / "opencode.json").write_text(json.dumps({"permission": {"shell": "ask", "bash": "ask"}}))
    env = {key: value for key, value in os.environ.items() if key in {"PATH", "USER", "LANG", "TMPDIR"}}
    env.update({
        "HOME": str(root),
        "XDG_CONFIG_HOME": str(root / "xdg-config"),
        "XDG_DATA_HOME": str(root / "xdg-data"),
        "XDG_CACHE_HOME": str(root / "xdg-cache"),
        "XDG_STATE_HOME": str(root / "xdg-state"),
        "OPENCODE_CONFIG": str(config / "opencode.json"),
        "OPENCODE_MODELS_PATH": str(models),
        "OPENCODE_DISABLE_AUTOUPDATE": "true",
        "LATTE_WORK_AGENT_ENV": "inherit",
        "LATTE_WORK_CLAUDE": "/nonexistent/claude",
        "LATTE_WORK_CODEX": "/nonexistent/codex",
        "LATTE_WORK_TRAEX": "/nonexistent/traex",
        "LATTE_WORK_OPENCODE": str(cli),
    })
    version = subprocess.check_output([cli, "--version"], env=env, timeout=5, text=True).strip()
    child = subprocess.Popen([binary, "serve", "--state-dir", str(state)], env=env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, start_new_session=True)
    try:
        deadline = time.monotonic() + 10
        sock = state / "control.sock"
        while not sock.exists():
            if child.poll() is not None or time.monotonic() >= deadline:
                raise TimeoutError("isolated Latte Work Server did not start")
            time.sleep(.05)
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(25)
            conn.connect(str(sock))
            with conn.makefile("rw") as wire:
                def rpc(method, **params):
                    wire.write(json.dumps({"method": method, **params}) + "\n")
                    wire.flush()
                    response = json.loads(wire.readline())
                    if response["kind"] == "error":
                        raise RuntimeError(response["message"])
                    return response

                hello = rpc("hello", version=1)
                assert any(a["id"] == "opencode" and a["available"] for a in hello["agents"]), hello
                pid = rpc("add_project", path=str(project))["project"]["id"]
                catalog = rpc("models_for_provider", agent="opencode", project_id=pid, provider=None)
                assert catalog["default_model"] == "test/test-model", catalog
                assert catalog["effort_levels"] == ["low", "high"], catalog
                commands = rpc("agent_commands", agent="opencode", project_id=pid)["commands"]
                assert all(command["name"] == "compact" for command in commands)
                sid = rpc("create_session", project_id=pid, agent="opencode")["session"]["id"]
                provider = {"kind": "cli"}
                rpc("open_agent_session", session_id=sid, provider=provider)
                assert rpc("session", session_id=sid)["session"]["native_id"] is None
                assert not Model.calls
                print(version + ": metadata and prompt-free open", flush=True)

                def send(request_id, text):
                    response = rpc("send_queued", session_id=sid, request_id=request_id, text=text,
                                   model="test/test-model", effort="high", provider=provider)
                    assert response["kind"] == "accepted" and not response["duplicate"], response

                def wait(expected):
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        result = rpc("poll", session_id=sid, after=0)
                        status = result["session"]["status"]
                        if status == expected:
                            return result
                        if status == "failed":
                            raise RuntimeError(result["events"][-5:])
                        time.sleep(.05)
                    raise TimeoutError(f"waiting for {expected}: {result}")

                def text(result):
                    return "".join(e["event"]["text"] for e in result["events"] if e["event"]["kind"] == "text")

                send("first", "First smoke turn.")
                first = wait("completed")
                assert "OPEN_CODE_SMOKE_OK" in text(first), first
                native = first["session"]["native_id"]
                assert native
                rpc("close_agent_session", session_id=sid, only_if_idle=True)
                rpc("open_agent_session", session_id=sid, provider=provider)
                send("second", "Second smoke turn after resume.")
                second = wait("completed")
                assert text(second).count("OPEN_CODE_SMOKE_OK") == 2, second
                assert second["session"]["native_id"] == native
                submitted = [
                    message.get("content")
                    for call in Model.calls for message in call["messages"][-1:]
                    if message["role"] == "user"
                ]
                # Some OpenCode versions make a second request for a native
                # title. Verify both submissions and that Latte replayed no text.
                assert "First smoke turn." in submitted
                assert "Second smoke turn after resume." in submitted
                print(version + ": streamed turns and native close/resume", flush=True)

                send("permission", "permission sentinel")
                pending = wait("waiting")
                approval = next(e["event"] for e in reversed(pending["events"]) if e["event"]["kind"] == "approval")
                marker = project / "smoke-approved.txt"
                assert not marker.exists()
                rpc("approve", session_id=sid, request_id=approval["request_id"], allow=True)
                final = wait("completed")
                assert "TOOL_SMOKE_OK" in text(final) and marker.read_text() == "OC_EXECUTED", final
                print(version + ": native permission gates an actual shell call", flush=True)
                send("cancel", "cancel sentinel")
                wait("waiting")
                rpc("cancel", session_id=sid)
                wait("stopped")
                assert not (project / "smoke-cancelled.txt").exists()
                print(version + ": cancellation rejects a pending native shell permission", flush=True)
                if commands:
                    send("compact", "/compact")
                    wait("completed")
                    print(version + ": advertised native compaction", flush=True)
                rpc("close_agent_session", session_id=sid, only_if_idle=True)
    finally:
        if child.poll() is None:
            child.send_signal(signal.SIGINT)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default="target/debug/latte-work-server", type=Path)
    parser.add_argument("--opencode", default=shutil.which("opencode"), type=Path)
    args = parser.parse_args()
    if args.opencode is None:
        parser.error("install OpenCode 2.x or provide --opencode")
    with tempfile.TemporaryDirectory(prefix="lw-opencode-", dir="/tmp") as temp, ThreadingHTTPServer(
        ("127.0.0.1", 0), Model
    ) as llm:
        thread = threading.Thread(target=llm.serve_forever, daemon=True)
        thread.start()
        try:
            run(args.binary.resolve(strict=True), args.opencode.absolute(), llm, Path(temp))
        finally:
            llm.shutdown()
            thread.join()


if __name__ == "__main__":
    main()
