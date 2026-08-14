# Uploads

```bash
cdp upload <t> <selector> <path>     # 对 <input type=file> 设置文件（DOM.setFileInputFiles）
```

- selector 必须命中 file input（可用 `cdp eval <t> "document.querySelectorAll('input[type=file]').length"` 确认）。
- 路径用绝对路径。
- 需要多个文件：setFileInputFiles 支持数组（后续扩展）。
- 拖拽上传（无 file input）的站点：目前无命令，见 drag-and-drop.md。
