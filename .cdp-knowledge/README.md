# .cdp-knowledge — 站点经验笔记(公共层种子)

Self-improving 认知层:每个站点一个目录,自由 markdown(标题 + 日期 + 内容)。

## 格式

```markdown
# <笔记名>
- 日期: 2026-08-24        # 最近一次实测/更新的日期
- 环境: 需要登录 / 公开     # 可选

内容:自然语言,steps 用列表,{占位符} 参数化,命令写 CLI 形式。
```

## 规则(agent 遵守,见 SKILL.md「Self-Improving」章节)

- 读:nav 命令会提示该站笔记,`cdp knowledge <site>` 查看
- 写:踩坑/失败当场记;首次成功(该站无笔记)写第一条;顺利执行不写
- 更新:笔记过时(步骤失败)就改,标注新日期
- 本目录是**共享种子**,仅人工挑选复制;agent 自动沉淀只进 ~/.cdp/knowledge/

## 来源

部分笔记从 browser-harness(https://github.com/browser-use/browser-harness)
agent-workspace/domain-skills 移植(MIT),helper 调用已翻译为 CLI 命令,标注于各文件头部。
