# Scrolling

```bash
cdp scroll <t> <x> <y> [--dy px] [--dx px]    # 在视口坐标 (x,y) 滚轮，dy 默认 -300
```

- 先确认**哪个容器**在消费滚轮：`cdp eval <t> "(()=>{const e=document.elementFromPoint(100,100);let n=e;while(n&&n.scrollHeight<=n.clientHeight)n=n.parentElement;return n?n.tagName+'.'+n.className:'<body>'})()"`——嵌套容器/虚拟列表要滚对元素。
- 虚拟化列表（无限滚动）滚到底会不断加载：`cdp loadall <t> <selector>` 或循环 scroll + wait。
- 下拉菜单内部滚动：先 click 展开再对菜单容器 scroll。
