#!/usr/bin/env python3
"""Deterministic ACP peer. The two 2.x command notification orders are deliberate."""
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time
import uuid

if sys.argv[1:] == ["--version"]:
    print(f"opencode v{os.environ.get('LATTE_TEST_OPENCODE_VERSION', '2.3.0')}")
    sys.exit(0)
if sys.argv[1:4] == ["session", "export", "--standalone"]:
    print(Path(sys.argv[4] + ".json").read_text())
    sys.exit(0)
assert sys.argv[1:] == ["acp"], sys.argv

session = None
model = "test/default"
effort = "default"
prompt_id = None
permission_id = None
rounds = 0
titles = {}
sideband_wire = None
sideband_lock = threading.Lock()
parent_finished = threading.Event()


def native_event(kind, **data):
    with sideband_lock:
        sideband_wire.write(json.dumps({"type": kind, "data": data}) + "\n")
        sideband_wire.flush()


def await_test_signal(name):
    deadline = time.monotonic() + 8
    while not Path(name).is_file():
        assert time.monotonic() < deadline, name
        time.sleep(0.01)


def sideband():
    global sideband_wire
    config = json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT", "{}"))
    entry = next((p for p in config.get("plugins", []) if isinstance(p, dict) and "socket" in p.get("options", {})), None)
    if not entry:
        return
    with socket.socket(socket.AF_UNIX) as conn:
        conn.connect(entry["options"]["socket"])
        with conn.makefile("rw") as wire:
            sideband_wire = wire
            wire.write('{"type":"ready"}\n')
            wire.flush()
            for line in wire:
                request = json.loads(line)
                native = request["sessionID"]
                action = request["action"]
                reply = {"type": "reply", "id": request["id"]}
                if action == "rename":
                    titles[native] = request["title"]
                elif action == "get":
                    reply["title"] = titles.get(native)
                elif action == "command":
                    assert request["name"] == "project:check"
                    Path(native).write_text("prompted")
                    if request["text"] == "child permission":
                        command_id = request["id"]
                        root = native
                        native_event("session.created", sessionID=root + "_child", parentID=root)
                        native_event("permission.asked", sessionID=root + "_child", id="native-ask",
                                     action="shell", source={"id": "shell-call"}, resources=["printf fixture"])
                        continue
                    event = {"type": "session.text.delta", "data": {"sessionID": native, "delta": "command reply"}}
                    wire.write(json.dumps(event) + "\n")
                elif action == "permission":
                    assert native == root + "_child" and request["requestID"] == "native-ask"
                    assert request["allow"]
                    native_event("session.tool.input.started", sessionID=native, id="skill-call", name="skill")
                    native_event("session.tool.called", sessionID=native, id="skill-call", input={"id": "fixture-skill"})
                    native_event("session.tool.success", sessionID=native, id="skill-call", content=[])
                    native_event("session.execution.succeeded", sessionID=native)
                    reply["id"] = command_id
                elif action == "answer":
                    assert request["questionID"] == "child-question"
                    assert request["answers"] == [["One"]]
                    assert parent_finished.is_set()
                    native_event("session.text.delta", sessionID=native + "_child", delta="child answered")
                    native_event("session.execution.succeeded", sessionID=native + "_child")
                    native_event("session.inbox.enqueued", sessionID=native, inboxID="msg_answered", background=True)
                    native_event("session.inbox.delivered", sessionID=native, inboxID="msg_answered")
                    native_event("session.execution.succeeded", sessionID=native)
                    continue
                else:
                    raise AssertionError(request)
                wire.write(json.dumps(reply) + "\n")
                wire.flush()


threading.Thread(target=sideband, daemon=True).start()


def send(**message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)


def reply(id, **result):
    send(id=id, result=result)


def update(update_type, session_id=None, **content):
    send(method="session/update", params={
        "sessionId": session if session_id is None else session_id,
        "update": {"sessionUpdate": update_type, **content},
    })


def commands():
    update("available_commands_update", availableCommands=[
        {"name": "project:check", "description": "Run project checks"},
        {"name": "compact", "description": "Compact the session"},
    ])


def options():
    levels = ["default", "low"] if model == "test/default" else ["default", "medium", "max", "native-extra"]
    return [
        {"id": "model", "type": "select", "currentValue": model,
         "options": [{"value": "test/default", "name": "Fixture default"},
                     {"value": "test/other", "name": os.environ.get("OPENCODE_FIXTURE_LABEL", "Other")}]},
        {"id": "effort", "type": "select", "currentValue": effort,
         "options": [{"value": value, "name": value} for value in levels]},
    ]


def complete(text):
    update("agent_thought_chunk", content={"type": "text", "text": "private reasoning"})
    update("agent_message_chunk", content={"type": "text", "text": "wrong session"}, session_id="other")
    for fragment in text.split("|"):
        update("agent_message_chunk", content={"type": "text", "text": fragment})
    update("usage_update", used=28, size=10000)
    reply(prompt_id, stopReason="end_turn", usage={"inputTokens": 25, "outputTokens": 3})


for line in sys.stdin:
    message = json.loads(line)
    assert message["jsonrpc"] == "2.0"
    method = message.get("method")
    id = message.get("id")
    params = message.get("params", {})
    if method == "initialize":
        assert params["protocolVersion"] == 1
        assert "fs" not in params["clientCapabilities"]
        assert params["clientCapabilities"]["_meta"]["opencode/child-session-updates"] is True
        reply(id, protocolVersion=1, agentInfo={"name": "OpenCode", "version": "2.3.0"},
              agentCapabilities={"sessionCapabilities": {"resume": {}, "close": {}, "delete": {}}})
    elif method in ("session/new", "session/resume"):
        assert Path(params["cwd"]) == Path.cwd()
        assert params["mcpServers"] == []
        if method == "session/new":
            session = "ses_" + uuid.uuid4().hex
            Path(session).write_text("unprompted")
            commands()
            reply(id, sessionId=session, configOptions=options())
        else:
            session = params["sessionId"]
            if not Path(session).exists():
                send(id=id, error={"code": -32602, "message": "Session not found"})
                continue
            assert Path(session).read_text() == "prompted"
            reply(id, configOptions=options())
            commands()
    elif method == "session/set_config_option":
        assert params["sessionId"] == session
        key, value = params["configId"], params["value"]
        assert value in [row["value"] for opt in options() if opt["id"] == key for row in opt["options"]]
        if key == "model":
            model = value
            effort = "default"
        else:
            assert key == "effort"
            effort = value
        reply(id, configOptions=options())
    elif method == "session/delete":
        assert params["sessionId"] == session
        assert Path(session).read_text() == "unprompted"
        Path(session).unlink()
        reply(id)
    elif method == "session/close":
        assert params["sessionId"] == session
        if Path(session).read_text() == "unprompted":
            Path(session).unlink()
        reply(id)
    elif method == "session/prompt":
        assert params["sessionId"] == session
        prompt_id = id
        text = params["prompt"][0]["text"]
        Path(session).write_text("prompted")
        with Path("prompts").open("a") as log:
            log.write(f"{session}:{model}:{effort}:{text}\n")
        rounds += 1
        if text.startswith("permission"):
            permission_id = f"permission:{rounds}" if text == "permission-deny" else -rounds
            update("tool_call", toolCallId=f"call-{rounds}", title="shell", kind="execute", status="pending")
            tool = {"toolCallId": f"call-{rounds}", "title": "printf fixture", "kind": "execute",
                    "rawInput": {"command": "printf fixture"}}
            update("tool_call_update", status="in_progress", **tool)
            send(id=permission_id, method="session/request_permission", params={
                "sessionId": session, "toolCall": tool,
                "options": [{"optionId": "permanent", "kind": "allow_always"},
                            {"optionId": "once", "kind": "allow_once"},
                            {"optionId": "no", "kind": "reject_once"}],
            })
        elif text == "unexpected-eof":
            sys.exit(0)
        elif text == "background":
            child = {"rootSessionId": session, "childSessionId": "ses_child", "parentSessionId": session, "depth": 1}
            send(method="opencode/session/child_update", params={**child, "type": "status", "status": "created"})
            send(method="opencode/session/child_update", params={**child, "type": "update", "update": {
                "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "child only"}
            }})
            complete("main only")
        elif text == "late-native":
            complete("ACP reply")
            await_test_signal("release-native")
            native_event("session.execution.started", sessionID=session)
            native_event("session.inbox.delivered", sessionID=session, inboxID="msg_acp")
            native_event("session.text.delta", sessionID=session, delta="duplicate native reply")
            native_event("session.execution.succeeded", sessionID=session)
            native_event("session.inbox.enqueued", sessionID=session, inboxID="msg_bg", background=True)
            native_event("session.execution.started", sessionID=session)
            native_event("session.inbox.delivered", sessionID=session, inboxID="msg_bg")
            native_event("session.text.delta", sessionID=session, delta="real follow-up")
            native_event("session.execution.succeeded", sessionID=session)
        elif text == "background-question":
            native_event("session.created", sessionID=session + "_child", parentID=session)
            native_event("question", sessionID=session + "_child", id="child-question",
                         prompts=[{"header": "Child", "question": "Which mode?",
                                   "options": [{"label": "One"}, {"label": "Two"}]}])
            await_test_signal("release-parent")
            parent_finished.set()
            complete("parent finished")
        elif text == "nested":
            for child, parent, depth in [
                ("ses_child", session, 1), ("ses_nested", "ses_child", 2),
                ("ses_unowned", "ses_child", 2), ("ses_other_project", "ses_child", 2),
            ]:
                update_data = {"rootSessionId": session, "childSessionId": child, "parentSessionId": parent, "depth": depth}
                send(method="opencode/session/child_update", params={**update_data, "type": "status", "status": "created"})
                send(method="opencode/session/child_update", params={**update_data, "type": "update", "update": {
                    "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "stream " + child}
                }})
                send(method="opencode/session/child_update", params={**update_data, "type": "status", "status": "completed"})
                Path(child + ".json").write_text(json.dumps({
                    "info": {"id": child, "parentID": "ses_foreign" if child == "ses_unowned" else parent,
                             "location": {"directory": str(Path.cwd().parent if child == "ses_other_project" else Path.cwd())}},
                    "messages": [{"type": "user", "id": "msg_child", "text": "native child instruction"},
                                 {"type": "assistant", "content": [
                                     {"type": "text", "text": "native " + child},
                                     {"type": "tool", "id": "tool_error", "name": "shell",
                                      "state": {"status": "error", "error": {"message": "native shell failure"}}},
                                     {"type": "tool", "id": "tool_unfinished", "name": "read",
                                      "state": {"status": "running", "input": {"path": "file.txt"}}},
                                 ]}],
                }))
            complete("main only")
        elif text != "await-cancel":
            complete("fixture |reply")
    elif method == "session/cancel":
        assert params["sessionId"] == session
        reply(prompt_id, stopReason="cancelled")
        prompt_id = None
    elif method is None and id == permission_id:
        outcome = message["result"]["outcome"]
        if prompt_id is None:
            assert outcome == {"outcome": "cancelled"}
            permission_id = None
            continue
        expected = "no" if isinstance(id, str) else "once"
        assert outcome == {"outcome": "selected", "optionId": expected}, outcome
        update("tool_call_update", toolCallId=f"call-{rounds}", status="completed" if expected == "once" else "failed",
               content=[{"type": "content", "content": {"type": "text", "text": "fixture output"}}])
        complete("decision:" + expected)
        permission_id = None
    else:
        raise AssertionError(message)
