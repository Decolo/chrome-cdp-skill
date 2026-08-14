# Downloads

当前无专用命令（TODO）。两种方式：

1. **直接抓取**（纯 HTTP，不触发浏览器下载）：`curl -L -o file <url>`（需要登录态时先 `cdp cookies --save` → curl 带 cookie）。
2. **浏览器触发下载**（点击下载按钮等）：目前用 `cdp evalraw <t> "Browser.setDownloadBehavior" '{"behavior":"allow","downloadPath":"/tmp/dl"}'` 配置目录，点击后文件落入该目录。正式命令（download）待做。
