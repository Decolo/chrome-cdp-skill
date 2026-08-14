# Dropdowns

分类处理：

1. **原生 select**：`cdp eval <t> "(()=>{const s=document.querySelector('select#x');s.value='opt2';s.dispatchEvent(new Event('change',{bubbles:true}))})()"`——不要用 click 模拟。
2. **自定义 overlay（click 展开）**：`cdp click <t> "#trigger"` 展开 → `cdp wait <t> ".menu-item"` 等菜单渲染 → 再 click 选项。
3. **可搜索 combobox**：click 聚焦 → `cdp type <t> "关键字"` → wait 建议 → click。
4. **虚拟化长菜单**：选项可能未渲染，先 `cdp eval <t> "document.querySelectorAll('.opt').length"` 确认；必要时滚动容器。

规则：展开后**重新测量**（选项几何位置常延迟出现），优先用 CSS selector + click 而非坐标。
