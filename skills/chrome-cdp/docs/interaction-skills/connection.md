# Connection & daemon

- `cdp` 命令统一走常驻 daemon（Unix socket）。daemon 未运行时自动拉起；Chrome 未运行时自动启动（最后使用的 profile）。
- Chrome 每个会话弹一次 "Allow debugging" 弹窗：daemon 保持单连接 + 后台重连，点一次即可，之后所有命令免弹。`cdp stop` 才断开。
- 连接状态用 `cdp stats` 看（daemon 健康、最近命令耗时）。
- 若 Chrome 未开远程调试：`cdp` 会自动打开 chrome://inspect 提示并退出（3 分钟限频）；勾选 "Allow remote debugging" 重启一次后永久生效。
- e2e 相关：测试永远用隔离 Chrome（临时 profile + 临时 daemon），不碰用户 Chrome。
