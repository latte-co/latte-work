import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { request, message } from "./api";
import type { TerminalInfo } from "./protocol";

export function TerminalPane({
  hostId,
  terminal,
  active,
  connected,
}: {
  hostId: string;
  terminal: TerminalInfo;
  active: boolean;
  connected: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const cursor = useRef(0);
  const polling = useRef(false);
  const exited = useRef(false);
  const writable = useRef(false);
  const pending = useRef(0);
  const chain = useRef(Promise.resolve());
  const [error, setError] = useState("");
  const [revision, retry] = useState(0);
  const [ready, setReady] = useState(false);
  const [finished, setFinished] = useState(false);
  const [lost, setLost] = useState(false);
  writable.current =
    connected && !error && ready && !finished && !terminal.exited;

  useEffect(
    () => () => {
      instance.current?.term.dispose();
      instance.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!active || !container.current) return;
    if (!instance.current) {
      const styles = getComputedStyle(container.current);
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"SFMono-Regular", Menlo, Monaco, monospace',
        scrollback: 5000,
        allowProposedApi: false,
        theme: {
          background: styles.getPropertyValue("--color-canvas").trim(),
          foreground: styles.getPropertyValue("--color-text").trim(),
          cursor: styles.getPropertyValue("--color-text").trim(),
          selectionBackground: "#9bb8c43d",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container.current);
      instance.current = { term, fit };
      // Each input is sent exactly once; transport failures never replay commands.
      const input = (data: Uint8Array) => {
        if (!writable.current) return;
        if (pending.current + data.length > 64 * 1024) {
          setError("输入过多，尚未发送的内容已丢弃。请检查终端后继续。");
          writable.current = false;
          return;
        }
        pending.current += data.length;
        chain.current = chain.current.then(async () => {
          try {
            if (!writable.current) return;
            for (let i = 0; i < data.length; i += 16 * 1024) {
              await request(hostId, {
                method: "write_terminal",
                terminal_id: terminal.id,
                data: Array.from(data.slice(i, i + 16 * 1024)),
              });
            }
          } catch (e) {
            writable.current = false;
            setError(`输入可能部分送达，未自动重发。${message(e)}`);
          } finally {
            pending.current -= data.length;
          }
        });
      };
      term.onData((data) => input(new TextEncoder().encode(data)));
      term.onBinary((data) =>
        input(Uint8Array.from(data, (c) => c.charCodeAt(0))),
      );
      // Let the WebView handle native copy/paste rather than interpreting Cmd as shell input.
      term.attachCustomKeyEventHandler(
        (e) => !(e.metaKey && ["c", "v", "a"].includes(e.key.toLowerCase())),
      );
      cursor.current = 0;
      setReady(true);
    }
    const { term, fit } = instance.current;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    let resizing = false;
    let last = "";
    const resize = async () => {
      if (
        disposed ||
        !container.current?.clientWidth ||
        !container.current?.clientHeight
      )
        return;
      if (resizing) {
        timer = setTimeout(() => void resize(), 80);
        return;
      }
      fit.fit();
      const dimensions = `${term.cols}:${term.rows}`;
      if (
        !connected ||
        exited.current ||
        terminal.exited ||
        dimensions === last
      )
        return;
      resizing = true;
      try {
        await request(hostId, {
          method: "resize_terminal",
          terminal_id: terminal.id,
          cols: Math.min(500, Math.max(2, term.cols)),
          rows: Math.min(300, Math.max(1, term.rows)),
        });
        last = dimensions;
      } catch (e) {
        if (!disposed) setError(message(e));
      } finally {
        resizing = false;
      }
      if (!disposed && dimensions !== `${term.cols}:${term.rows}`)
        void resize();
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void resize(), 80);
    });
    observer.observe(container.current);
    void resize();
    term.focus();
    return () => {
      disposed = true;
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [active, connected, hostId, terminal.id, terminal.exited]);

  useEffect(() => {
    if (instance.current)
      instance.current.term.options.disableStdin = !writable.current;
  }, [connected, error, ready, finished, terminal.exited]);
  useEffect(() => {
    if (!active || !connected || !ready || exited.current) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (polling.current) {
        timer = setTimeout(() => void poll(), 80);
        return;
      }
      polling.current = true;
      try {
        const response = await request(hostId, {
          method: "read_terminal",
          terminal_id: terminal.id,
          after: cursor.current,
        });
        if (disposed) return;
        if (response.kind !== "terminal_output")
          throw new Error("终端响应格式不匹配");
        if (response.truncated) {
          instance.current?.term.reset();
          setLost(true);
        }
        const term = instance.current?.term;
        if (term && response.data.length)
          await new Promise<void>((resolve) =>
            term.write(Uint8Array.from(response.data), resolve),
          );
        // Finish this batch even if the tab was hidden while xterm parsed it.
        cursor.current = response.next;
        if (response.terminal.exited && !response.has_more) {
          exited.current = true;
          setFinished(true);
        } else if (!disposed)
          timer = setTimeout(() => void poll(), response.has_more ? 0 : 80);
      } catch (e) {
        if (!disposed) setError(message(e));
      } finally {
        polling.current = false;
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active, connected, ready, hostId, terminal.id, revision]);
  return (
    <div className="terminal-pane">
      {!connected && (
        <div className="terminal-notice" role="status">
          连接已断开，重连后恢复输出。
        </div>
      )}
      {lost && (
        <div className="terminal-notice">
          较早的输出已超出缓存，只显示最近的内容。
        </div>
      )}
      {error && (
        <div className="terminal-notice" role="alert">
          <span>{error}</span>
          <button
            onClick={() => {
              setError("");
              retry((v) => v + 1);
            }}
          >
            重新连接
          </button>
        </div>
      )}
      <div
        className="terminal-screen"
        ref={container}
        aria-label="交互式终端"
      />
      {finished && (
        <div className="terminal-notice" role="status">
          Shell 已退出。可关闭此标签，或点击 ＋ 新建终端。
        </div>
      )}
    </div>
  );
}
