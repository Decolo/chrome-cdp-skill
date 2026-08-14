# Viewport

- 视口大小/DPR：`cdp inspect <t>`（含 w/h/scroll 信息）；DPR 在 `cdp shot` 输出里。
- **点击/滚轮坐标一律是 CSS 像素**：截图坐标 ÷ DPR 后再用 clickxy/scroll。
- 视口大小影响布局与坐标：页面 resize（窗口变化）后重新测量。
- 设置视口尺寸（Emulation.setDeviceMetricsOverride）未做——移动端/响应式测试目前用真实窗口。
