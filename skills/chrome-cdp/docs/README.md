# docs

- `interaction-skills/` — 浏览器机制场景手册（对齐 browser-harness interaction-skills，命令已适配 chrome-cdp）
- 站点级经验沉淀：repo 根 `.cdp-knowledge/<site>/`（公共种子）+ `~/.cdp/knowledge/<site>/`（私人自动沉淀）；`cdp knowledge` 读写，`nav` 自动提示
- SKILL.md 是主入口；遇到"某个浏览器机制怎么处理"先查这里。
- 观测：`~/.cdp/audit.jsonl`（CDP_AUDIT_FILE 可覆盖）记录每条命令（脱敏，不记参数值）；`node scripts/audit.mjs` 分析；`cdp stats` 看日志位置与条数。
