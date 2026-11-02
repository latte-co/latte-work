# Codex 集成验证（2026-11-02）

实现位于 `codex/codex-integration`，基线为
`0652b6a9b82fde65535a84326079d3a000d71b12`。验证时实现为独立功能 worktree 中的
未提交修改；下列版本和源码指纹记录当时的验证对象。

Codex 与 Traex 共用 app-server 会话状态机，各自保留模型、Provider 与权限能力。
Codex 通过执行主机的 `codex app-server --stdio` 运行，支持无提示打开、原生恢复、
流式回复、工具事件、单次审批、结构化提问、停止、队列补充输入与 Responses Provider。
Codex 的独立子任务活动也参与后台状态与 Undo 保护，不将主任务完成当作子任务完成。

## 完整本地门禁

`make ci` 的格式、生成类型一致性、actionlint/ShellCheck、workspace Clippy、
Rust 单元/E2E/文档测试、前端测试/构建及 macOS native 边界检查均完成：

- Server 单元测试：212 通过；其余 Rust crate 单元测试也通过。
- 最终二进制 E2E：106 通过，0 失败，1 忽略。忽略项是项目既有的、要求单独启动
  隔离 OpenSSH daemon 的 Skills 测试，不属于 Codex 真实 SSH 验收。
- 前端：90 个测试文件、799 项测试通过；TypeScript 与 Vite 构建通过。
- macOS：WebKit site-data、favicon transport、DMG 工具隔离检查通过。
- 格式、类型生成一致性、workflow/shell lint、Clippy（拒绝 warnings）通过。

该轮 `make ci` 最后仅在 Rustdoc 的一处裸 URL 格式上退出。将注释链接改为自动链接后，
单独重跑相同的 `RUSTDOCFLAGS='-D warnings' cargo doc --workspace --no-deps --locked`
通过，并再次通过 `make fmt-check lint`。这项注释修正不改变运行行为，未重复全套 E2E。

## 已执行的针对性验证

- 共用状态机 22 项单元测试通过，覆盖初始化、消息归属、提前完成、停止、审批、
  后台命令、技能注入、队列确认和 Codex 子任务的延迟完成归属。
- Codex 模型目录与 Provider 凭据配置单元测试通过：发送原生模型 slug，拒绝损坏条目，
  不继承 Traex 模式；凭据不进入 argv。
- 4 项 Codex 最终二进制 E2E 通过，使用真实 Server/socket/bridge 和确定性 CLI fixture。
  覆盖模型/权限目录、无提示打开、流式与工具记录、重连去重、关闭/恢复、审批的跨会话
  拒绝与单次使用、问题回答、队列 steering、停止、失败、EOF、Provider 协议边界与脱敏。
- 真实 Codex CLI 0.162.0：原生模型目录、权限发现与无提示打开通过。
- 真实 CLI + 本地 Responses SSE 测试服务：Bearer、API Key、无认证，Provider/模型切换，
  显式关闭后恢复与自动进程重配置，恢复 CLI 配置与默认模型均通过。
- 同一真实 CLI 根据本地测试服务返回的函数调用，在临时项目执行 shell 写入；实际文件
  内容、工具事件与结果均已确认。凭据未出现在命令行及被检查的持久文件中。
- 另一次本地上游探针确认显式 high 与恢复 CLI 配置 low 的实际请求值。

版本、二进制/源码/schema 哈希和真实 CLI 检查项保存在
[Codex CLI contract evidence](../evidence/codex-cli-0.162.0-contract.json)。

## 复现

```sh
make ci
python3 scripts/smoke-codex.py
python3 scripts/smoke-codex-providers.py
```

两个 smoke 均使用隔离 Server 与临时项目，默认不调用付费模型。
`smoke-codex.py --live` 和 `--live-tools` 是另行显式选择的真实模型验证。

## 证据边界

确定性 CLI fixture 与真实 CLI 使用本地模拟上游的结果分别记录；它们不证明真实模型
服务可用、模型会自主作出这些工具决策，或原生桌面 UI/实际 SSH 主机已验证。
本次未调用付费模型、未执行桌面交互或实际 SSH 验收。既有原生 WebKit 边界测试不等同
于 Codex 原生 UI 验收。原生命令目录、关闭会话的标题编辑与专用 Codex 子任务全文读取
仍明确不支持；原生 stdout 的大记录内存边界沿用现有约定。
