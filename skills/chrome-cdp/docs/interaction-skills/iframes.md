# Iframes

## 同源 iframe

直接穿透：`cdp eval <t> "document.querySelector('iframe').contentDocument.querySelector('...')"`。同源 iframe 无独立 target。

## 跨域 iframe（OOPIF）

同源穿透被浏览器隔离（`contentDocument` 为 null）。跨域 iframe 是独立 CDP target：

```bash
cdp iframe                # 列出所有跨域 iframe
cdp iframe <url-substr>   # 解析第一个匹配的 iframe → targetId
cdp eval <iframe-id> "document.title"     # 在 iframe 自己的 JS 上下文执行
cdp click <iframe-id> "#btn"              # 直接操作 iframe 内元素
```

注意：iframe 内坐标点击（clickxy）用的是**页面坐标**还是 iframe 坐标需实测；优先 selector 点击。
