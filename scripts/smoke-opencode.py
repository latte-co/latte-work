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
    auth = []
    paths = []
    steering_ready = threading.Event()
    steering_release = threading.Event()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path not in ("/v1/chat/completions", "/v1/messages", "/v1/responses"):
            self.send_error(404)
            return
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.calls.append(request)
        self.auth.append((self.headers.get("Authorization"), self.headers.get("x-api-key")))
        self.paths.append(path)
        if path == "/v1/messages":
            marker = {"id": "msg_fixture", "type": "message", "role": "assistant", "model": request["model"],
                      "content": [], "stop_reason": None, "stop_sequence": None,
                      "usage": {"input_tokens": 20, "output_tokens": 0}}
            return self.events([
                {"type": "message_start", "message": marker},
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0,
                 "delta": {"type": "text_delta", "text": "OPEN_CODE_SMOKE_OK"}},
                {"type": "content_block_stop", "index": 0},
                {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                 "usage": {"output_tokens": 6}},
                {"type": "message_stop"},
            ])
        if path == "/v1/responses":
            item = {"id": "msg_fixture", "type": "message", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": "OPEN_CODE_SMOKE_OK", "annotations": []}]}
            return self.events([
                {"type": "response.created", "response": {"id": "resp_fixture", "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "output_index": 0, "item": {**item, "content": []}},
                {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0,
                 "content_index": 0, "delta": "OPEN_CODE_SMOKE_OK"},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": {"id": "resp_fixture", "status": "completed",
                 "output": [item], "usage": {"input_tokens": 20, "output_tokens": 6, "total_tokens": 26}}},
            ])
        last = request["messages"][-1]
        if "steer start sentinel" in str(last["content"]):
            self.steering_ready.set()
            if not self.steering_release.wait(8):
                self.send_error(504)
                return
        if last["role"] == "user" and "subagent child sentinel" in str(last["content"]):
            time.sleep(.35)
            delta = {"role": "assistant", "content": "CHILD_SMOKE_OK"}
            finish = "stop"
        elif "<subagent" in str(last["content"]):
            delta = {"role": "assistant", "content": "PARENT_FOLLOWUP_OK"}
            finish = "stop"
        elif last["role"] == "tool":
            delta = {"role": "assistant", "content": "TOOL_SMOKE_OK"}
            finish = "stop"
        elif "launch subagent sentinel" in str(last["content"]):
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "id": "call_child", "type": "function",
                "function": {"name": "subagent", "arguments": json.dumps({
                    "agent": "general", "description": "Smoke child", "prompt": "subagent child sentinel",
                    "background": True,
                })},
            }]}
            finish = "tool_calls"
        elif "skill sentinel" in str(last["content"]):
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "id": "call_skill", "type": "function",
                "function": {"name": "skill", "arguments": '{"id":"smoke-latte-skill"}'},
            }]}
            finish = "tool_calls"
        elif "question sentinel" in str(last["content"]):
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "id": "call_question", "type": "function",
                "function": {"name": "question", "arguments": json.dumps({"questions": [{
                    "header": "Mode", "question": "Which mode?", "options": [
                        {"label": "One", "description": "First choice"},
                        {"label": "Two", "description": "Second choice"},
                    ],
                }]})},
            }]}
            finish = "tool_calls"
        elif any(sentinel in str(last["content"]) for sentinel in ("permission sentinel", "cancel sentinel", "background sentinel")):
            marker = "smoke-cancelled.txt" if "cancel sentinel" in str(last["content"]) else "smoke-approved.txt"
            background = "background sentinel" in str(last["content"])
            delta = {"role": "assistant", "tool_calls": [{
                "index": 0, "id": "call_permission", "type": "function",
                "function": {"name": "shell", "arguments": json.dumps({
                    "command": f"printf OC_EXECUTED > {marker}" if not background else "sleep 2; exit 7",
                    "description": "Write smoke marker" if not background else "Background smoke",
                    **({"background": True} if background else {}),
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
        self.write_sse(payload)

    def events(self, events):
        self.write_sse("".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events))

    def write_sse(self, payload):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload.encode())))
        self.end_headers()
        try:
            self.wfile.write(payload.encode())
        except (BrokenPipeError, ConnectionResetError):
            pass

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
    (project / "opencode.json").write_text(json.dumps({
        "permission": {"shell": "ask", "bash": "ask"},
        "commands": {"check": {"template": "Native slash smoke $ARGUMENTS", "description": "Smoke native command"}},
    }))
    skill = project / ".opencode/skills/smoke-latte-skill"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: smoke-latte-skill\ndescription: Smoke test instructions\n---\nSKILL_BODY_OK\n")
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
                assert any(command["name"] == "check" for command in commands)
                sid = rpc("create_session", project_id=pid, agent="opencode")["session"]["id"]
                provider = {"kind": "cli"}
                rpc("open_agent_session", session_id=sid, provider=provider)
                assert rpc("session", session_id=sid)["session"]["native_id"] is None
                assert not Model.calls
                print(version + ": metadata and prompt-free open", flush=True)

                def send(request_id, text, permission_mode=None, queued=False):
                    response = rpc("send_queued", session_id=sid, request_id=request_id, text=text,
                                   model="test/test-model", effort="high", provider=provider,
                                   permission_mode=permission_mode)
                    assert response["kind"] == ("message_queued" if queued else "accepted") and not response["duplicate"], response

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
                deadline = time.monotonic() + 5
                while rpc("session", session_id=sid)["session"]["title"] != "OPEN_CODE_SMOKE_OK":
                    if time.monotonic() >= deadline:
                        raise AssertionError("OpenCode native title did not arrive")
                    time.sleep(.05)
                assert rpc("rename_session", session_id=sid, title="Live OpenCode title",
                           provider=provider)["session"]["title"] == "Live OpenCode title"
                rpc("close_agent_session", session_id=sid, only_if_idle=True)
                assert rpc("rename_session", session_id=sid, title="Closed OpenCode title",
                           provider=provider)["session"]["title"] == "Closed OpenCode title"
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

                named = rpc("create_session", project_id=pid, agent="opencode")["session"]["id"]
                rpc("rename_session", session_id=named, title="Initial OpenCode title", provider=provider)
                before = len(Model.calls)
                rpc("open_agent_session", session_id=named, provider=provider)
                assert len(Model.calls) == before
                rpc("send_queued", session_id=named, request_id="named-first", text="First named turn.",
                    model="test/test-model", effort="high", provider=provider)
                deadline = time.monotonic() + 8
                while True:
                    named_session = rpc("session", session_id=named)["session"]
                    if named_session["status"] == "completed":
                        break
                    if time.monotonic() >= deadline:
                        raise AssertionError(named_session)
                    time.sleep(.05)
                assert len(Model.calls) == before + 1
                assert named_session["title"] == "Initial OpenCode title"
                rpc("close_agent_session", session_id=named, only_if_idle=True)
                exported = subprocess.run([cli, "session", "export", "--standalone", named_session["native_id"]],
                    cwd=project, env=env, capture_output=True, check=True, timeout=6)
                assert json.loads(exported.stdout)["info"]["title"] == "Initial OpenCode title"
                print(version + ": initial user title persisted natively without a naming prompt", flush=True)

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
                if any(command["name"] == "compact" for command in commands):
                    send("compact", "/compact")
                    wait("completed")
                    print(version + ": advertised native compaction", flush=True)
                send("question", "question sentinel")
                pending = wait("waiting")
                question = next(e["event"] for e in reversed(pending["events"]) if e["event"]["kind"] == "question")
                rpc("answer_question", session_id=sid, request_id=question["request_id"],
                    answers=[{"question_id": question["questions"][0]["id"], "option_indices": [1]}])
                wait("completed")
                assert "Two" in json.dumps(Model.calls[-1]["messages"][-1])
                print(version + ": native question and answer", flush=True)
                marker.unlink()
                send("bypass", "permission sentinel", "bypass_permissions")
                wait("completed")
                assert marker.read_text() == "OC_EXECUTED"
                assert any("Latte Work platform skill" in json.dumps(req) for req in Model.calls)
                send("steer-start", "steer start sentinel", "bypass_permissions")
                assert Model.steering_ready.wait(5)
                send("steered", "steer followup sentinel", "bypass_permissions", queued=True)
                queue = rpc("message_queue", session_id=sid)
                entry = next(item for item in queue["entries"] if item["request_id"] == "steered")
                try:
                    rpc("dispatch_queued_message", session_id=sid, request_id="steered",
                        revision=entry["revision"], interrupt=False, provider=provider)
                finally:
                    Model.steering_release.set()
                deadline = time.monotonic() + 8
                while not any("steer followup sentinel" in str(call["messages"][-1]["content"])
                              for call in Model.calls if "messages" in call):
                    if time.monotonic() >= deadline:
                        raise AssertionError("Steered input did not reach the model")
                    time.sleep(.05)
                wait("completed")
                assert not rpc("message_queue", session_id=sid)["entries"]
                print(version + ": confirmed mid-turn input delivery", flush=True)
                send("background", "background sentinel", "bypass_permissions")
                wait("completed")
                deadline = time.monotonic() + 10
                while True:
                    events = rpc("poll", session_id=sid, after=0)["events"]
                    if any("退出码 7" in json.dumps(e, ensure_ascii=False) for e in events):
                        break
                    if time.monotonic() >= deadline:
                        raise AssertionError("Background Shell exit did not arrive")
                    time.sleep(.05)
                wait("completed")
                print(version + ": confirmed background Shell exit", flush=True)
                deadline = time.monotonic() + 8
                while rpc("session", session_id=sid)["session"]["agent_session_busy"]:
                    if time.monotonic() >= deadline:
                        raise AssertionError("Native work did not settle after Shell exit")
                    time.sleep(.05)
                send("native-command", "/check example", "bypass_permissions")
                wait("completed")
                assert "Native slash smoke example" in json.dumps(Model.calls[-1]["messages"][-1])
                print(version + ": project slash command finished", flush=True)
                send("skill", "skill sentinel", "bypass_permissions")
                result = wait("completed")
                assert any(e["event"].get("name") == "Skill"
                           and e["event"]["input"]["skill"] == "smoke-latte-skill" for e in result["events"])
                assert "SKILL_BODY_OK" in json.dumps(Model.calls[-1]["messages"][-1])
                assert rpc("skill_info", session_id=sid, name="smoke-latte-skill")["skill"]["name"] == "smoke-latte-skill"
                print(version + ": project Skill execution and metadata", flush=True)
                if any(command["name"] == "smoke-latte-skill" for command in commands):
                    before = len(Model.calls)
                    send("slash-skill", "/smoke-latte-skill", "bypass_permissions")
                    wait("completed")
                    assert Model.calls[before:]
                    assert "SKILL_BODY_OK" in json.dumps(Model.calls[before:])
                    print(version + ": native Skill slash shortcut", flush=True)
                send("subagent", "launch subagent sentinel", "bypass_permissions")
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    result = rpc("poll", session_id=sid, after=0)
                    children = rpc("subagents", session_id=sid)["tasks"]
                    if ("PARENT_FOLLOWUP_OK" in text(result) and result["session"]["status"] == "completed"
                            and children and children[0]["status"] == "completed"):
                        break
                    time.sleep(.05)
                else:
                    raise AssertionError(result["events"][-8:])
                children = rpc("subagents", session_id=sid)["tasks"]
                assert children and children[0]["status"] == "completed", children
                history = rpc("subagent_history", session_id=sid, task_id=children[0]["id"])
                assert "CHILD_SMOKE_OK" in json.dumps(history)
                assert "CHILD_SMOKE_OK" not in text(result)
                print(version + ": child transcript and autonomous parent follow-up", flush=True)
                rpc("close_agent_session", session_id=sid, only_if_idle=True)
                before = len(Model.calls)
                other_context = {"kind": "configured", "snapshot": {
                    "provider": None, "environment": {"LATTE_SMOKE_OTHER_CONTEXT": "1"},
                }}
                other = rpc("subagent_history", session_id=sid, task_id=children[0]["id"], provider=other_context)
                assert other["source"] == "stream", other["source"]
                recovered = rpc("subagent_history", session_id=sid, task_id=children[0]["id"], provider=provider)
                assert recovered["source"] == "native" and "CHILD_SMOKE_OK" in json.dumps(recovered), recovered
                assert "subagent child sentinel" in recovered["prompt"]
                assert len(Model.calls) == before
                print(version + ": prompt-free native child history after close", flush=True)
                assert set(next(a for a in hello["agents"] if a["id"] == "opencode")["provider_protocols"]) == {
                    "openai_chat", "openai_responses", "anthropic_messages",
                }
                for protocol, endpoint in [
                    ("openai_chat", "/v1/chat/completions"), ("openai_responses", "/v1/responses"),
                    ("anthropic_messages", "/v1/messages"),
                ]:
                    for auth, expected in [
                        ("bearer", ("Bearer fixture-work-key", None)),
                        ("api_key", (None, "fixture-work-key")),
                        ("none", (None, None)),
                    ]:
                        metadata = {
                            "id": "smoke-work", "name": "Latte Provider", "protocol": protocol,
                            "base_url": base_url, "model": "gateway/work-model", "auth": auth,
                            "has_credential": auth != "none",
                        }
                        snapshot = {"kind": "snapshot", "snapshot": {"provider": metadata,
                                    "credential": "fixture-work-key" if auth != "none" else ""}}
                        catalog = rpc("models_for_provider", agent="opencode", project_id=pid, provider=metadata)
                        assert catalog["default_model"] == "gateway/work-model", catalog
                        before = len(Model.calls)
                        print(f"{version}: probing {protocol} {auth}", flush=True)
                        rpc("open_agent_session", session_id=sid, provider=snapshot)
                        assert len(Model.calls) == before
                        rpc("send_queued", session_id=sid, request_id=f"app-{protocol}-{auth}",
                            text="Latte Provider smoke " + auth, model=metadata["model"], provider=snapshot)
                        result = wait("completed")
                        assert result["session"]["native_id"] == native
                        assert Model.calls[before:]
                        assert all(req["model"] == "gateway/work-model" for req in Model.calls[before:])
                        assert all(path == endpoint for path in Model.paths[before:])
                        assert all(headers == expected for headers in Model.auth[before:]), (protocol, auth)
                        rpc("close_agent_session", session_id=sid, only_if_idle=True)
                before = len(Model.calls)
                rpc("open_agent_session", session_id=sid, provider=provider)
                rpc("send_queued", session_id=sid, request_id="return-to-cli",
                    text="Return to CLI defaults", provider=provider)
                assert wait("completed")["session"]["native_id"] == native
                assert all(req["model"] == "test-model" for req in Model.calls[before:])
                assert all(headers == ("Bearer fixture", None) for headers in Model.auth[before:])
                rpc("close_agent_session", session_id=sid, only_if_idle=True)
                print(version + ": App Provider auth and native resume across Provider switches", flush=True)
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
