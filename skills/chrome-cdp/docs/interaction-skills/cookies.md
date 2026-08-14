# Cookies

```bash
cdp cookies                       # 列出全部 cookie（JSON 数组）
cdp cookies --save <file>         # 保存快照（跨任务恢复登录态）
cdp cookies --load <file>         # 恢复快照
cdp cookie set <name> <value> --domain <host> [--path /] [--secure] [--httpOnly] [--expires ts]
cdp cookie delete <name> [--domain <host>]
```

- 页面级 cookie（当前页面 domain）用 `cdp eval <t> "document.cookie='k=v; path=/'"` 更直接。
- 快照文件是 JSON（`{"cookies":[...]}`），可版本化、跨机器复用。
- cookie 是浏览器级状态，与页面状态无关——恢复快照不会重载页面。
