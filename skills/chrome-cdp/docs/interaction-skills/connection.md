# Connection & daemon

- `cdp` 命令统一走常驻 daemon（Unix socket）。daemon 未运行时自动拉起；Chrome 未运行时自动启动（最后使用的 profile）。
- Chrome 每个会话弹一次 "Allow debugging" 弹窗：daemon 保持单连接 + 后台重连，之后所有命令免弹。`cdp stop` 才断开。
- macOS 自动批准：CLI 等 daemon 连接期间自动用 System Events 点掉 "Allow remote debugging?" 弹窗（不激活 Chrome，对齐 browser-harness mac-approve；中英文弹窗都支持，中文 Chrome 为「要允许远程调试吗？」）。前提：终端 app（iTerm/Terminal）在 系统设置 > 隐私与安全性 > 辅助功能 里授权一次；`cdp mac-approve` 可手动触发/自检（`ready`/`not-found` 正常，`accessibility-required` = 缺授权，`setup-required` = 开关未勾，`no-match` = 弹窗在但认不出来 —— 八成是 Chrome 又改了弹窗结构，见下）。`CDP_NO_MAC_APPROVE=1` 关闭自动批准。
- **弹窗是靠内容识别的，不是靠结构**：Chrome 151+（实测 153.0.8010.50）改成自绘弹窗后，`AXSheet` 自身 `name = missing value`，标题「要允许远程调试吗？」沉到第 5 层的 `AXHeading` 上（中间套 4 层 `AXGroup`）。所以 `isApprovalPrompt` 递归扫子树找 "远程调试"/"remote debugging"，而不是读 sheet 的 name 或写死层数 —— 2026-09 之前的老写法读 sheet.name，两道匹配全落空，静默返回 `not-found`，表现为"弹窗弹了但没人点"，能连挂好几次不被发现。点按钮时**必须精确相等**匹配 `允许`/`Allow`：同一层还有「取消」和「在"设置"中关闭」，后者会**关掉**远程调试。
- 复现/排查这类问题的姿势：`CDP_NO_MAC_APPROVE=1` 让弹窗留在屏幕上，再用 System Events 递归 dump（`role`/`name`/`description` 都要用 `try` 包住，读不到会抛错；递归 handler 必须包在 `using terms from application "System Events"` 里，否则 `UI elements` 编译不过）。注意 daemon 60s 超时退出后，残留弹窗会变成点不动的僵尸（AXPress 和真实鼠标点击都无效），别拿它当"命中了但没生效"的证据。
- 连接状态用 `cdp stats` 看（daemon 健康、最近命令耗时）。
- 若 Chrome 未开远程调试：`cdp` 会自动打开 chrome://inspect 提示并退出（3 分钟限频）；勾选 "Allow remote debugging" 重启一次后永久生效。
- e2e 相关：测试永远用隔离 Chrome（临时 profile + 临时 daemon），不碰用户 Chrome。
