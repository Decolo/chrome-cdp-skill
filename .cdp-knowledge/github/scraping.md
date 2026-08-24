# GitHub — 数据抓取
- 日期: 2026-08-24
- 来源: browser-harness agent-workspace/domain-skills/github/scraping.md(MIT,翻译为 CLI 语法)
- 环境: 公开数据,无需登录

## 先试 REST API,别用浏览器

repo 元数据/用户信息走 api.github.com,一次调用、免浏览器、免解析:

    curl -s https://api.github.com/repos/{owner}/{repo}
    # 关键字段: stargazers_count, forks_count, description, language,
    #           open_issues_count, created_at, pushed_at, default_branch

文件内容走 raw.githubusercontent.com(无限流、免 base64):

    curl -s https://raw.githubusercontent.com/{owner}/{repo}/main/README.md

## 只有 trending 页需要浏览器(JS 渲染)

- nav https://github.com/trending
- 等 React hydration:wait <target> --network-idle 或额外等 2 秒
- 选择器:article.Box-row 有效(默认 15 条)
- 一次 eval 取完所有字段:

    cdp eval <target> "JSON.stringify([...document.querySelectorAll('article.Box-row')].map(el => ({...})))"
