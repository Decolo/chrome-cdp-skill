# Network Requests

```bash
cdp net <t> [--limit 10] [--type fetch] [--same-origin]   # 最慢资源条目
cdp wait <t> --network-idle [--timeout ms] [--idle ms]    # 等到网络安静（SPA 渲染完）
```

- 提交表单/SPA 动作后，页面无 DOM 变化但请求在跑：用 `wait --network-idle` 等请求落定再断言。
- 长连接（SSE/keepalive/streaming）会让 network-idle 永远不静——超时返回 `inflight: n`，属预期。
- 判断"下载是否开始"用 net 观察 responseReceived 事件（evalraw 可订阅），或直接看文件系统。
