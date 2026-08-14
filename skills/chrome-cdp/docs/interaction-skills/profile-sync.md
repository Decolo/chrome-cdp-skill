# Profile 管理

- 默认：cdp 使用 Chrome 最后使用的 profile（`--profile-directory=<last used>`），保留登录态。
- 隔离实例：`CDP_USER_DATA_DIR=/tmp/xxx cdp ...` → 用命令行调试端口 + 独立 profile（测试/并行任务用）。
- 自定义 Chrome 二进制：`CDP_CHROME_PATH` / `CHROME_PATH`（macOS 还有 `CDP_CHROME_APP`）。
- e2e 永远用临时 profile（隔离 Chrome），不污染日常 profile。
