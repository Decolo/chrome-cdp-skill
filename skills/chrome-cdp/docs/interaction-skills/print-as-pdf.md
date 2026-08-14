# Print As PDF

```bash
cdp pdf <t> [file]        # 默认输出 ./<target前缀>.pdf
```

- 走 CDP `Page.printToPDF`（printBackground=true），不弹系统打印框。
- 返回 {file, size, targetId}。
- 站点只有可见 "Print" 按钮时：`cdp click` 它 → 若弹出系统打印对话框（不是 JS 弹窗），CDP 无法控制（TODO）。
