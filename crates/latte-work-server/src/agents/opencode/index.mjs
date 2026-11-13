import { createConnection } from "node:net";

// Loaded by the same private OpenCode server that owns the ACP session.
// Only forward lifecycle evidence that ACP does not carry.
export default {
  id: "latte-work.session",
  async setup(ctx) {
    if (ctx.options.permissionMode) {
      await ctx.permission.hook("evaluate", (event) => {
        // A preceding native or managed denial is authoritative.
        if (event.effect !== "deny")
          event.effect =
            ctx.options.permissionMode === "default" ? "ask" : "allow";
      });
    }
    const socket = createConnection(ctx.options.socket);
    const abort = new AbortController();
    const questions = new Map();
    const legacy = Number(ctx.app.version.split(".")[1]) < 3;
    const bridgeQuestions = new Set();
    const cleanup = () => {
      abort.abort();
      for (const resolve of questions.values()) resolve(null);
      questions.clear();
      socket.destroy();
    };
    const events = new Set([
      "session.execution.started",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.inbox.delivered",
      "session.inbox.cancelled",
      "session.renamed",
      "session.created",
      "session.text.delta",
      "session.reasoning.delta",
      "session.tool.called",
      "session.tool.success",
      "session.tool.failed",
      "permission.asked",
      "shell.exited",
    ]);
    function send(message) {
      if (socket.destroyed) return;
      const line = JSON.stringify(message) + "\n";
      if (
        Buffer.byteLength(line) > 1024 * 1024 ||
        socket.writableLength > 1024 * 1024
      ) {
        socket.destroy();
        return;
      }
      socket.write(line);
    }
    socket.once("connect", () => {
      const stream = ctx.event.subscribe({ signal: abort.signal });
      void (async () => {
        send({ type: "ready" });
        for await (const { type, data } of stream) {
          if (type === "session.created") {
            const { sessionID, parentID, agent, title } = data;
            if (parentID)
              send({ type, data: { sessionID, parentID, agent, title } });
          } else if (events.has(type)) {
            if (
              type === "session.tool.success" ||
              type === "session.tool.failed"
            ) {
              let remaining = 384 * 1024;
              const content = [];
              for (const item of data.content ?? []) {
                const value = item.type === "text" ? item.text : item.uri;
                if (
                  typeof value !== "string" ||
                  (item.type !== "text" && !value.startsWith("data:image/"))
                )
                  continue;
                const size = Buffer.byteLength(value);
                if (size > remaining) continue;
                content.push(item);
                remaining -= size;
              }
              send({
                type,
                data: {
                  sessionID: data.sessionID,
                  id: data.id,
                  name: data.name,
                  content,
                  error: data.error?.message
                    ? { message: data.error.message.slice(0, 500) }
                    : undefined,
                  metadata: data.metadata && {
                    shellID: data.metadata.shellID,
                    status: data.metadata.status,
                  },
                },
              });
            } else {
              send({ type, data });
            }
          }
        }
      })().catch(() => socket.destroy());
    });
    async function handle(request) {
      const { id, sessionID, action } = request;
      try {
        if (action === "answer") {
          questions.get(request.questionID)?.(request.answers);
          return;
        }
        if (action === "rename") {
          if (ctx.session.update)
            await ctx.session.update({ sessionID, title: request.title });
          else await ctx.session.rename({ sessionID, title: request.title });
        } else if (action === "get") {
          const session = await ctx.session.get({ sessionID });
          send({
            type: "reply",
            id,
            title: session.title,
            directory: session.location.directory,
          });
          return;
        } else if (action === "steer") {
          await ctx.session.prompt({
            sessionID,
            id: request.messageID,
            text: request.text,
            delivery: "steer",
            resume: false,
          });
        } else if (action === "command") {
          if (legacy) {
            // 2.0 mixes command and Skill shortcuts in its ACP catalog. Only
            // the ACP entry point can activate a Skill directly in this version.
            const location = (await ctx.session.get({ sessionID })).location;
            const { data: commands } = await ctx.command.list({ location });
            if (!commands.some((command) => command.name === request.name)) {
              const { data: skills } = await ctx.skill.list({ location });
              if (
                !skills.some(
                  (skill) => skill.name === request.name && skill.slash !== false,
                )
              ) {
                throw new Error("Unknown native command");
              }
              send({ type: "reply", id, viaACP: true });
              return;
            }
          }
          bridgeQuestions.add(sessionID);
          try {
            await ctx.session.command({
              sessionID,
              name: request.name,
              command: request.name,
              text: request.text,
              delivery: "steer",
            });
            await ctx.session.wait({ sessionID });
          } finally {
            bridgeQuestions.delete(sessionID);
          }
        } else if (action === "permission" && ctx.permission.reply) {
          await ctx.permission.reply({
            sessionID,
            requestID: request.requestID,
            reply: request.allow ? "once" : "reject",
          });
        } else if (action === "interrupt") {
          await ctx.session.interrupt({ sessionID });
        } else {
          throw new Error("Unsupported request");
        }
        send({ type: "reply", id });
      } catch {
        send({ type: "reply", id, error: true });
      }
    }
    let buffered = "";
    let requests = 0;
    socket.setEncoding("utf8");
    socket.on("data", (data) => {
      buffered += data;
      if (buffered.length > 4 * 1024 * 1024) return socket.destroy();
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (++requests > 32) return socket.destroy();
        try {
          void handle(JSON.parse(line)).finally(() => {
            requests--;
          });
        } catch {
          socket.destroy();
          return;
        }
      }
    });
    socket.on("error", cleanup);
    socket.on("close", cleanup);
    await ctx.tool.transform((editor) => {
      editor.update("question", (tool) => {
        const native = tool.execute;
        tool.execute = async ({ questions: prompts }, context) => {
          const { sessionID, agent, messageID, id: toolCallId } = context;
          if (!legacy && !bridgeQuestions.has(sessionID))
            return native({ questions: prompts }, context);
          if (questions.size >= 32 || socket.destroyed)
            throw new Error("Latte Work cannot show questions");
          if (ctx.permission.assert) {
            await ctx.permission.assert({
              sessionID,
              agent,
              action: "question",
              resources: ["*"],
              source: { type: "tool", messageID, id: toolCallId },
            });
          } else {
            const selected = await ctx.agent.get({ agentID: agent });
            const session = await ctx.session.get({ sessionID });
            // The 2.0 plugin API has no permission assertion. Honor
            // configured denies conservatively before displaying the form.
            if (
              [
                ...(selected.data?.permissions ?? []),
                ...(session.permissions ?? []),
              ].some(
                (rule) =>
                  rule.effect === "deny" &&
                  (rule.action === "*" || rule.action === "question"),
              )
            ) {
              throw new Error("Permission denied: question");
            }
          }
          const id = crypto.randomUUID();
          const signal = context.signal;
          let cancel;
          let answers;
          try {
            answers = await new Promise((resolve) => {
              cancel = () => resolve(null);
              if (signal?.aborted) return cancel();
              signal?.addEventListener("abort", cancel, { once: true });
              questions.set(id, resolve);
              send({
                type: "question",
                data: { sessionID, id, toolCallId, prompts },
              });
            });
          } finally {
            questions.delete(id);
            signal?.removeEventListener("abort", cancel);
          }
          if (!answers) throw new Error("The user dismissed the question");
          const report = prompts
            .map(
              (prompt, index) =>
                `"${prompt.question}"="${answers[index].join(", ")}"`,
            )
            .join(", ");
          return {
            output: { answers },
            content: `User has answered your questions: ${report}`,
          };
        };
      });
    });
    return cleanup;
  },
};
