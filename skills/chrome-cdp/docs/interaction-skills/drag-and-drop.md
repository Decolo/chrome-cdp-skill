# Drag And Drop

当前无专用命令。低层拖拽用 evalraw 派发鼠标序列：

```bash
cdp evalraw <t> "Input.dispatchMouseEvent" '{"type":"mousePressed","x":100,"y":100,"button":"left","clickCount":1}'
cdp evalraw <t> "Input.dispatchMouseEvent" '{"type":"mouseMoved","x":200,"y":200,"button":"left","buttons":1}'
cdp evalraw <t> "Input.dispatchMouseEvent" '{"type":"mouseReleased","x":200,"y":200,"button":"left","clickCount":1}'
```

注意：很多站点对 HTML5 拖拽（dragstart/drop 事件）用鼠标序列无效，需要 JS DataTransfer 方案（站点而定）。文件拖放请直接 `cdp upload`。
