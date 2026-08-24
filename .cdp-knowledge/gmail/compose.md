# Gmail — 写邮件并发送
- 日期: 2026-08-24
- 来源: browser-harness agent-workspace/domain-skills/gmail/compose.md(MIT,翻译为 CLI 语法)
- 环境: 需要登录 + 开启键盘快捷键

## 打开写信

    cdp nav <target> https://mail.google.com
    cdp press <target> c          # Gmail 快捷键,打开写信框并聚焦收件人
    cdp wait <target> 'div[role="dialog"]' --visible

## 坑 1:多个写信框堆叠,要选可见的那个

Gmail 把草稿存在底部对话框。document.querySelectorAll('div[role="dialog"]')
返回全部(含最小化的)。最小化的高度 ≤ 40 且内部 input offsetParent === null。
**永远按尺寸选,不要按 index**:

    cdp eval <target> "(()=>{const ds=[...document.querySelectorAll('div[role="dialog"]')];return ds.findIndex(d=>d.getBoundingClientRect().height>200)})()"

之后所有查询都 scope 到 dialogs[idx]。

## 坑 2:Tab 会往收件人输入框里插入字面 \t

press c 后焦点在 [aria-label="To recipients"],此时 press Tab **不会**移焦点,
而是插入制表符。要么直接 click 下一个字段,要么先把收件人输入完整地址
(失焦后自动变 chip)。读 chip 用 [role="dialog"] [data-hovercard-id],不要读 input.value。

## 填字段

    # 主题
    cdp eval <target> "(function(){const d=[...document.querySelectorAll('div[role="dialog"]')].find(d=>d.getBoundingClientRect().height>200);const s=d.querySelector('input[name="subjectbox"]');const r=s.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()"
    cdp clickxy <target> <x> <y>
    cdp type <target> "主题内容"

正文同理,用 div[aria-label="Message Body"] 的中心点。

## 附件:直接设 file input,别点回形针

回形针打开原生文件选择器,驱动不了。用 DOM.setFileInputFiles 设 Gmail 隐藏的
文件输入。**坑**:每个写信框有一个 input[type="file"][name="Filedata"],
默认选到第一个(可能是旧草稿的),Gmail 会忽略。选可见写信框的那个
(通常最后一个就是最新的):

    # upload 命令按选择器设文件;多个 input 时用 evalraw DOM.querySelectorAll 挑最后一个
    cdp evalraw <target> DOM.querySelectorAll '{"selector":"input[type=\"file\"][name=\"Filedata\"]","depth":-1}'

上传后 input.files 读回为空是正常的(Gmail 立即消费了 FileList),
用截图或找文件名 chip(font: "文件名 (61K)")验证。

## 发送

    # 在可见写信框里找 aria-label 以 "Send" 开头的按钮,clickxy 其中心
