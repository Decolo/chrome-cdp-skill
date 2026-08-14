# Screenshots

```bash
cdp shot <t> [file] [--selector ".card"]          # 元素级
cdp shot <t> [file] [--clip x y w h]              # CSS 像素区域
```

- 图片像素 = CSS 像素 × DPR（Retina 2× 时 2296×1143 视口 → 4592×2286 PNG）。
- **点击坐标是 CSS 像素**：从截图读到的坐标要先除以 devicePixelRatio 再给 clickxy。
- 模型上下文有限时优先 `cdp inspect` / `cdp html --text`，再考虑 shot。
- 整页截图（full）比视口截图大得多、慢得多，需要看折叠内容时才用。
