---
title: 第十一批 — 认知层落地(Self-Improving knowledge)
date: 2026-08-24
status: done
scope: 一个知识目录 + 少量 CLI 命令;不涉及执行层插件(后置)
---

## 设计(经多轮讨论定稿)

### 核心思想
- 知识 = 站点级经验笔记,自由 markdown,一个统一目录(砍掉 recipes/memory 分层——内容形态的分层没有机制价值)
- 分层按机制分:原子命令(已有)/ 知识层(本批)/ 执行层插件(后置)
- 积累 = 从异常和从零到一中学,不从平凡成功中学

### 存储(两层)
```
公共层(repo 内,进 git):  .cdp-knowledge/<site>/<name>.md   ← 种子/共享,仅人工挑选复制
私人层(不进 git):        ~/.cdp/knowledge/<site>/<name>.md  ← agent 自动沉淀,本机私有
```
查找顺序:私人优先 → 公共兜底。

### 文件格式(最简)
标题 + 日期 + 内容(自然语言,steps 用列表,{占位符} 参数化)。

### 积累触发(三态)
| 情况 | 动作 |
|---|---|
| 失败/踩坑 | 当场写/更新笔记(最重要) |
| 首次成功(该站无笔记) | 写第一条 |
| 顺利成功 | 不写(零浪费) |

### 读触发(工具级,不靠自觉)
nav 返回该站知识提示:`knowledge: <site> — 2 条 (cdp knowledge <site> 查看)`;
无笔记时提示值得沉淀。agent 用 `cdp knowledge <site>` 读 → 进 audit 日志(可观测)。

### 写兜底(--review)
`cdp knowledge --review`:从 audit log 拉最近失败命令清单,任务结束跑一次,防漏沉淀。

### 评价(--report,按需)
`cdp knowledge --report`:按站统计知识读取次数、有笔记 vs 无笔记失败率对比。
audit 的 nav 记录补 host 字段(评价需要按站聚合)。

### 种子
从 browser-harness agent-workspace/domain-skills 移植 3-5 个常用站,
helper 调用翻译成 CLI 命令,标注出处(MIT,附来源)。

## 任务清单
- [ ] B1. repo 建 .cdp-knowledge/ 骨架(README 格式说明)
- [ ] B2. 私人层建 ~/.cdp/knowledge/(README)
- [ ] B3. cdp.mjs:`cdp knowledge <site>` 查询 + `--review` + `--report`;nav 提示行;audit 加 host
- [ ] B4. SKILL.md「Self-Improving」章节(读/写/触发规则)
- [ ] B5. 种子移植(browser-harness domain-skills → CLI 语法,3-5 站)
- [ ] B6. 测试(knowledge 命令单元测试)
- [ ] B7. 闭环验证:真实 Chrome 跑一个站点任务 → 沉淀 → 查→跑
- [ ] B8. commit + push(仅公共层;~/.cdp/ 不进 git)

## 已定决策(不再讨论)
- 不做 recipes/memory 分层(文字游戏)
- 积累不自动(笔记内容需 agent 现场写),靠规则 + --review 兜底
- 评价按需(--report),不持续跑
- 执行层插件(命令注册)后置,本批不做


## Addendum 1: 实现记录 (2026-08-24)

- 命令:`cdp knowledge [site|--review|--report]`,CLI 分支 + daemon 第一 switch case;
  nav 返回附加 knowledge 提示行;audit 记录 nav/knowledge 的 host 字段
- 种子:github(scraping + star-watch)、gmail(compose),从 browser-harness
  domain-skills 翻译(MIT,文件头标注来源);公共层 .cdp-knowledge/,私人层 ~/.cdp/knowledge/
- 闭环验证通过(见 todo Review 区)
- 已知边界:写入靠 agent 规则 + --review 兜底(工具无法判定任务成败);
  评价按需(--report);audit 旧行无 host 不影响新统计
