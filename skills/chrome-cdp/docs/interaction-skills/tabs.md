# Tabs

```bash
cdp open <url> [--session <id>]      # 开 tab（复用空白 tab），成为该 session 当前 tab
cdp list [--session <id>]            # 列出 tabs；* = 该 session 当前 tab
cdp switch <t> [--session <id>]      # 激活 tab + 设为当前 tab
cdp current [--session <id>]         # 查询当前 tab {targetId,url,title,session}
cdp close <t>                        # 关 tab（不带 target：关当前 tab）
cdp ensure-real-tab [--session <id>] # 当前是内部页(chrome:// 等)时切到第一个真实 tab
```

- **session 模型**：每个 agent session（`CDP_SESSION` 环境变量或 `--session`）记住自己操作的 tab；多个 subagent 各设不同 session 即可并行操作不同 tab。
- 省略 target 的命令作用于 session 当前 tab（`cdp eval "js"`、`cdp wait --load`...）。
- CDP 擅长：attach、开/关/激活、读 URL/title、截图任意 tab。不擅长：tab 条可见顺序（要用 AppleScript）。
- 关闭的 tab 会从各 session 状态自动清理（daemon 监听 targetDestroyed）。
