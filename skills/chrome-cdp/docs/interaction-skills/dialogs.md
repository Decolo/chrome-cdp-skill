# Dialogs（alert / confirm / prompt / beforeunload）

JS 弹窗会冻结页面 JS 线程。两个思路：

## 检测与处理（首选，CDP 层，不可被反爬检测）

```bash
cdp dialog                     # 查询 pending 弹窗 → {"dialog":{"type":"alert","message":"...","defaultPrompt":"..."}}；无弹窗 → {"dialog":null}
cdp dialog accept [--prompt-text <t>]   # 确定（prompt 时提供输入文本）
cdp dialog dismiss             # 取消
```

- 弹窗挂起期间，该 tab 上的页面命令（eval/click/...）会被阻塞并提示先处理弹窗。
- 覆盖 alert / confirm / prompt / beforeunload。
- 后台 tab 的弹窗会被 Chrome 自动抑制（不冻结 JS，confirm 返回 true、prompt 返回默认值）——检测不到属于正常，页面命令也不会被阻塞。

## Proactive：JS stub（预期连续多个弹窗时）

```bash
cdp eval <t> "window.__d=[];window.alert=m=>__d.push(String(m));window.confirm=m=>{__d.push(String(m));return true};window.prompt=(m,d)=>{__d.push(String(m));return d||''}"
cdp eval <t> "window.__d"     # 收集到的弹窗
```

注意：导航后 stub 失效；confirm 永远返回 true；可被反爬检测（alert.toString() 非原生）。

## beforeunload

离开有未保存内容的页面时触发。`cdp nav` 或 `cdp close` 后立刻 `cdp dialog accept`（"离开"）即可；无弹窗时该调用无害。
