import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";

// Loaded by the same private OpenCode server that owns the ACP session.
// Only forward lifecycle evidence that ACP does not carry.
export default {
  id: "latte-work.session",
  async setup(ctx) {
    const legacy = Number(ctx.app.version.split(".")[1]) < 3;
    if (legacy && ctx.options.instructions) {
      const text = await readFile(ctx.options.instructions, "utf8");
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text });
      });
    }
    if (ctx.options.permissionMode) {
      await ctx.permission.hook("evaluate", (event) => {
        // A preceding native or managed denial is authoritative.
        if (event.effect === "deny" || (legacy && event.action === "question"))
          return;
        event.effect =
          ctx.options.permissionMode === "default" ? "ask" : "allow";
      });
    }
    const socket = createConnection(ctx.options.socket);
    const abort = new AbortController();
    const questions = new Map();
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
      "session.skill.activated",
      "session.renamed",
      "session.text.delta",
      "session.reasoning.delta",
      "session.tool.called",
      "session.tool.input.started",
      "session.tool.success",
      "session.tool.failed",
      "permission.asked",
      "permission.replied",
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
          if (type === "session.inbox.enqueued") {
            const { sessionID, inboxID, item } = data;
            if (item.type === "synthetic")
              send({ type, data: { sessionID, inboxID, synthetic: true } });
          } else if (type === "session.created") {
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
          const decision = request.allow ? "once" : "reject";
          await ctx.permission.reply({
            sessionID,
            requestID: request.requestID,
            decision,
            reply: decision,
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
          if (!legacy && !bridgeQuestions.has(sessionID)) {
            const session = await ctx.session.get({ sessionID });
            if (!session.parentID) return native({ questions: prompts }, context);
          }
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
            // 2.0 has no public permission assertion API. Run the original
            // tool through the native rules and hooks, stopping just before
            // it would open a form that its ACP peer cannot answer.
            let evaluated;
            const registration = await ctx.permission.hook("evaluate", (event) => {
              if (
                event.action !== "question" ||
                event.sessionID !== sessionID ||
                event.source?.type !== "tool" ||
                event.source.messageID !== messageID ||
                event.source.id !== toolCallId
              )
                return;
              evaluated = event.effect;
              event.effect = "deny";
            });
            try {
              try {
                return await native({ questions: prompts }, context);
              } catch (error) {
                if (
                  (evaluated !== "allow" && evaluated !== "ask") ||
                  !String(error).includes("Permission denied: question") ||
                  context.signal?.aborted
                )
                  throw error;
              }
              if (evaluated === "ask")
                throw new Error(
                  "OpenCode 2.0 cannot bridge a question that requires a separate approval",
                );
            } finally {
              await registration.dispose();
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
