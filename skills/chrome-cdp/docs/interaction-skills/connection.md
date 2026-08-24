# Connection & daemon

- `cdp` 命令统一走常驻 daemon（Unix socket）。daemon 未运行时自动拉起；Chrome 未运行时自动启动（最后使用的 profile）。
- Chrome 每个会话弹一次 "Allow debugging" 弹窗：daemon 保持单连接 + 后台重连，之后所有命令免弹。`cdp stop` 才断开。
- macOS 自动批准：CLI 等 daemon 连接期间自动用 System Events 点掉 "Allow remote debugging?" 弹窗（不激活 Chrome，对齐 browser-harness mac-approve；中英文弹窗都支持，中文 Chrome 为「要允许远程调试吗？」）。前提：终端 app（iTerm/Terminal）在 系统设置 > 隐私与安全性 > 辅助功能 里授权一次；`cdp mac-approve` 可手动触发/自检（`ready`/`not-found` 正常，`accessibility-required` = 缺授权，`setup-required` = 开关未勾）。`CDP_NO_MAC_APPROVE=1` 关闭自动批准。
- 连接状态用 `cdp stats` 看（daemon 健康、最近命令耗时）。
- 若 Chrome 未开远程调试：`cdp` 会自动打开 chrome://inspect 提示并退出（3 分钟限频）；勾选 "Allow remote debugging" 重启一次后永久生效。
- e2e 相关：测试永远用隔离 Chrome（临时 profile + 临时 daemon），不碰用户 Chrome。
