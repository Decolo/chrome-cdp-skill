# Cross-Origin Iframes

见 iframes.md。要点：

- 跨域 iframe = OOPIF = 独立 CDP target（`type=iframe`），用 `cdp iframe [url-substr]` 解析。
- 解析出的 targetId 与普通 tab id 用法完全一致：eval / click / fill / inspect / wait 全部可用。
- 这是读取/操作跨域 iframe 内容的唯一途径（host 页 eval `iframe.contentDocument` 恒为 null）。
- iframe 动态出现时先 `cdp wait <t> "iframe[src*='...']"` 等 DOM 就绪再解析。
