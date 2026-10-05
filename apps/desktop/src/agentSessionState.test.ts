import { expect, it } from "vitest";
import { agentSessionState } from "./agentSessionState";
import type { Session } from "./protocol";
const session = (open?: boolean) =>
  ({ agent_session_open: open, status: "completed" }) as Session;
it("keeps real process evidence separate from task completion and navigation", () => {
  expect(agentSessionState(session(true), true)).toBe("open");
  expect(agentSessionState(session(false), true)).toBe("closed");
  expect(agentSessionState(session(), true, undefined, true)).toBe("unknown");
  expect(agentSessionState(session(), true)).toBe("closed");
  expect(agentSessionState(session(false), true, { phase: "opening" })).toBe(
    "opening",
  );
  expect(agentSessionState(session(false), true, { phase: "restoring" })).toBe(
    "restoring",
  );
  expect(agentSessionState(session(true), false)).toBe("unknown");
  expect(agentSessionState(session(false), false, { phase: "restoring" })).toBe(
    "unknown",
  );
});
