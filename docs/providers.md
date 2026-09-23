# Provider 与 Code Agent

Provider 是本机统一管理的模型服务配置，包含名称、协议、Base URL、模型 ID 和凭据。
设置页的「连接与 Agent」和「Provider」是并列分类，切换 Tab 会保留未保存的 Provider 表单。
Provider 页面没有主机选择，也不会因为保存配置而自动关联 Agent。
支持保存 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三类配置。

Code Agent 是主机上的执行程序。在「设置 → 连接与 Agent」中选择运行主机，
为 Agent 关联一个协议兼容的 Provider。当前 Claude Code Adapter 只接受
Anthropic Messages；两种 OpenAI 配置可保存，当前没有能使用它们的 Agent Adapter。
不会自动把 OpenAI 转换成 Anthropic。前端过滤选项，server 与 Adapter 同时校验。
未关联 Provider 时沿用 Agent CLI 自己的配置。

## 使用

1. 在「设置 → Provider」添加模型服务。
2. 在「连接与 Agent」Tab 选择主机，再选择 Provider。
3. 本机点击「保存关联」；远程点击「同步并关联」。下次启动或继续任务生效，
   已在执行的进程持有旧快照，不会被修改。

Anthropic Base URL 通常为 `https://api.example.com`；Claude CLI 追加 `/v1/messages`。
OpenAI 配置按服务提供的 API base 填写，常见为 `https://api.example.com/v1`。
模型 ID 原样传入 CLI。Bearer Token 使用 `Authorization: Bearer …`；API Key 使用
`x-api-key`，标准 OpenAI 的 key 应使用 Bearer Token。

## 本机目录与远程同步

本机 `latte-work-server` 管理完整 Provider 目录。远程关联时，本机 server 经现有
OpenSSH 配置连接目标 server，只发送选中 Provider 的版本快照与 Agent ID；
不将明文凭据回传给 Desktop UI，不同步全部 Provider，不使用额外的模型转换进程。

远程 server 在一次原子保存中安装快照并建立关联，响应成功后 UI 才显示成功。
失败不会把 UI 标为已同步；通信超时可能已经在远端执行，重新打开设置可核对状态。
同步本身不调用模型，也不启动 Agent。相同快照可重复同步。

每次本机编辑产生新的 revision；Code Agent 页面比较 revision，提示远端「待同步」。
点击「同步并关联」更新。远端保留上次同步的配置，可独立执行任务；不需要每次启动
都连接本机，也不会因本机离线而丢失配置。当前采用显式同步，不做后台自动推送。

本机删除 Provider 不会自动清除离线远端；Code Agent 页面会提示旧副本仍存在，
可选择其他 Provider 或恢复 CLI 配置。解除远端关联时，会清理不再被任何 Agent
关联的同步副本。本机仍有关联的 Provider 不能删除，也不能改为不兼容的协议。

## 模块

- `providers.rs`：Provider 目录、版本、关联、兼容性校验、原子保存和启动快照。
- `agents/mod.rs`：Adapter 注册信息与支持的 Provider 协议。
- `agents/claude.rs`：将 Anthropic 配置转换成 `--model` 和临时 `--settings`。
  模型别名和子代理模型也指向所选 ID。保留 CLI 的权限流程与组织 managed policy。
- `main.rs`：本机管理请求和经 SSH 发出的远端同步请求；同一 server 程序用于本机与远端。
- `SettingsPage`：独立设置页和并列 Tab；`ProviderSettings` / `AgentSettings` 管理配置与关联；`Select` 提供深色、支持键盘的选项菜单。

## 凭据与迁移

每个 server 的状态目录默认为 `~/.local/share/latte-work`，权限 700。
Provider 配置及接收的副本保存在 `providers.json`，权限 600；内容未加密，
主机用户可读。列表响应只返回凭据是否存在，编辑时留空保留原值。
改变地址或认证方式要求重新填写凭据。凭据不会作为 CLI 参数明文出现。
正常执行结束后删除临时 settings 文件；server 被强制杀死可能遗留私有临时文件。

wire protocol 为 v6，旧版 server 会在握手时拒绝。升级应先等任务结束，再重启 daemon。
早期 schema 1 的 Provider 配置会保留；旧的全局选择只有协议兼容时才转成 Claude 关联，
不兼容的选择不建立关联。下一次保存写入 schema 2。

## 验证

`make ci` 包含目录与关联分离、协议拒绝、revision、迁移、私有文件、同步失败、
模拟 SSH 字节桥、实际 server 进程与 Agent fixture 续聊测试。模拟 SSH 不是实际
远程部署证据。可用真实 Claude CLI 和仅在 localhost 运行的模拟 Anthropic 服务验证：

```sh
python3 scripts/smoke-providers.py --binary target/debug/latte-work-server --claude /absolute/path/to/claude
```

此测试不调用付费模型；验证启动模型、工具审批、写文件、续聊换模型及 OpenAI 关联拒绝。
具体模型服务与真实 SSH 主机仍需各自联调。

CLI 参数依据 [Claude 网关配置](https://code.claude.com/docs/en/llm-gateway-connect) 和
[模型配置](https://code.claude.com/docs/en/model-config)。

## 会话模型选择

在 Provider 中填写默认模型 ID，以及可选模型 ID（每行一个，最多 64 个）。默认模型自动包含在列表中。
输入框底部的模型菜单读取项目主机上当前 Agent 关联的 Provider，不混用其他 Provider 的模型。
远端使用已同步的模型列表；本机修改后，需要在 Agent 设置中重新同步。

模型随下一条消息提交，服务端在启动前校验列表，并只覆盖本轮启动快照；不修改 Provider 默认值或其他会话。
选择记录保存在会话中，重连可恢复；重复请求 ID 也校验模型，避免换模型后错误复用已接受请求。
“默认”在绑定 Provider 时使用其默认模型；未绑定时沿用 CLI，新一轮恢复会话时显式清除上轮模型覆盖。
原有单模型 Provider 自动兼容，可选模型列表默认为空。

未关联 Provider 时提供 Claude 的模型别名，实际可用性仍由 CLI 和账号决定。启动传参依据
[Claude Code 官方模型配置文档](https://code.claude.com/docs/en/model-config)，通过 `--model` 选择，
不修改用户的 CLI 设置文件。

## 思考强度

思考档位属于 Code Agent 的能力，不属于 Provider 协议的通用属性。每个 Agent
适配器负责可选档位、模型限制、自动行为和原生参数映射；公共注册表只按 Agent
分发，未实现的 Agent 不继承 Claude 档位。前端只展示 Host 返回的 `effort_levels`，
发送时由服务端再次使用同一能力规则校验。当前只有 Claude 适配器已实现；下列
档位和自动行为仅描述 Claude，不代表其他 Code Agent 的能力。

模型选择器的 `Reasoning effort` 子菜单使用 Agent 原生英文档位；Claude 为 `auto / low / medium / high / xhigh / max`，按模型能力筛选。选择随下一条消息提交并保存在会话中，
不会修改 Provider 默认模型或用户的 Claude 配置文件。已知不支持 effort 的模型禁用调整，
已知模型版本只提供支持的档位；自定义模型 ID 的实际支持情况和组织限制由 CLI / 网关决定。

Claude adapter 在每轮启动时设置 `--effort` 和临时配置中的 `CLAUDE_CODE_EFFORT_LEVEL`。
“自动”用环境值 `auto` 清除之前的覆盖；不强制固定为 high。恢复会话时也重新应用本轮选择。
这不是关闭思考的开关，也不保证模型内部一定消耗某个 token 数。

依据 [Claude Code effort 配置](https://code.claude.com/docs/en/model-config#adjust-effort-level)。
`scripts/smoke-providers.py` 使用真实 CLI 和本地模拟 Anthropic 服务验证高、低及自动恢复，
检查实际发出的 `output_config.effort`，不调用付费模型接口。

## Claude 原生模型显示名称

未绑定 Latte Work Provider 时，模型目录额外返回按别名索引的 `model_labels`。
Claude 适配器读取执行 Host 的 `ANTHROPIC_DEFAULT_{FAMILY}_MODEL_NAME`；未设置名称时
回退到对应 `_MODEL`，没有覆盖时仍显示原生别名。菜单中自定义名称为主文字，别名
以浅灰色辅助显示；输入框只显示主名称。选择值仍是 `sonnet` 等原生别名，名称不会
写入会话模型参数，也不修改 Claude 配置或 Provider。

元数据读取范围：Host 进程模型变量、`CLAUDE_CONFIG_DIR/settings.json`（缺省为
`~/.claude/settings.json`）、已注册项目的 `.claude/settings.json` 和
`.claude/settings.local.json`、系统 `managed-settings.json`；按此顺序覆盖。
每个文件限 1 MiB，字段白名单只包含四个模型族的 ID 和显示名称。凭据与其他配置
不进入响应。无效或不可读文件跳过，名称最长 256 字符且不得包含控制字符。
MDM、云端托管策略、managed-settings.d 及自定义 modelPicker 行不在此显示元数据
读取范围内，执行行为和最终模型仍由 Claude 决定。绑定 Provider 时完全使用 Provider
模型列表，不叠加原生别名显示名称。

依据：[Claude 自定义模型显示名称](https://code.claude.com/docs/en/model-config#customize-pinned-model-display-and-capabilities)
与 [设置优先级](https://code.claude.com/docs/en/settings#settings-precedence)。
