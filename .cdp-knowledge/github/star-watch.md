# GitHub — Star / Watch / Unwatch
- 日期: 2026-08-24
- 来源: browser-harness agent-workspace/domain-skills/github/repo-actions.md(MIT,翻译为 CLI 语法)
- 环境: 需要登录(先确认 meta[name=user-login] 存在)

## 核心坑:提交 HTML form,不要点按钮

Star/Unstar/Watch 是 HTML form(POST 回 GitHub,CSRF token 已在页面里)。
**点按钮会失败**,原因:

1. button[aria-label^="Star "] 有两个匹配,第一个是 sticky 表头里的
   隐藏副本(几何为 0),点它没反应
2. React 按钮的合成 .click() 不触发网络请求(事件被 React fiber 吞掉)

正确做法:直接 form.submit(),绕过 React:

    cdp eval <target> "(()=>{const f=document.querySelector('form[action$='/star']');if(!f)return 'missing';f.submit();return 'submitted'})()"
    cdp wait <target> --load

验证:star 后页面应出现 form[action$="/unstar"]:

    cdp eval <target> "!!document.querySelector('form[action$='/unstar']')"

## Watch/Unwatch

- watch: form[action$="/subscription"],隐藏 _method 字段已就位,直接 submit
- 反向(unstar/unwatch)用对应 form,同上
