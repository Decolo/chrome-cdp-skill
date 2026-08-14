# Shadow DOM

`querySelector` 不穿透 shadow root。穿透写法（一次 eval 收集全部）：

```bash
cdp eval <t> "(()=>{const walk=(r,d=0)=>{const out=[];for(const e of r.querySelectorAll('*')){const s=e.shadowRoot;out.push({tag:e.tagName,d,cls:e.className||''});if(s)out.push(...walk(s,d+1))}return out};return JSON.stringify(walk(document))})()"
```

- 深层嵌套组件树穿透很脆：**坐标点击常常更简单**——先 `cdp shot` 看组件位置，再 `cdp clickxy`。
- 在 shadow root 内查找：`cdp eval <t> "document.querySelector('x-host').shadowRoot.querySelector('...')"`（同源页面内有效）。
