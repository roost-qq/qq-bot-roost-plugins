# 小黑盒一对一私信协议记录

记录日期：2026-11-28。对应版本：`media-parser 0.4.2`。

## 状态分级

**当前产品能力：正式原生私信接入。** 小黑盒私信已完成实验与用户真机验收，能力声明为 `verified: true`，不再输出 `experimental` 标记；页面、命令和配置标签不再显示验收状态文案。功能仍默认关闭，只有用户显式保存启用后才会读取。检查、冷却和脱敏边界保持不变。

### 用户确认

用户于 2026-11-28 明确确认真机人工验收完成，并确认小黑盒已完成实验、转为正式能力。此前用户也确认 B 站文字群投递、重复扫描仍仅一条、重载后没有重复。这属于整体验收结论，本文的分项记录用于说明可复核范围。

### 日志独立证据

独立本地日志审查确认：

- 真实二维码申请和轮询 HTTP 200。
- 账号校验 HTTP 200。
- 凭据保存并 accepted。
- 会话／消息读取 HTTP 200。
- 一次内置测试通知投递为 `delivery`／`send`／`sent`，`hostSent: true`、`sent: 1`。

内置测试通知不是新私信正文端到端转发的独立证据，不能据此推断双账号收发或完整分页。

### 未逐项独立证实

多次基线结果仍为 `XHH_WATCHING_LIMITED`、`baselineComplete: false`。以下范围没有逐项独立实测记录：

| 核对项 | 当前状态 |
| --- | --- |
| 完整分页 | 未逐项独立证实 |
| 历史恢复 | 未逐项独立证实 |
| 未读副作用 | 未逐项独立证实 |
| 图片／分享子能力 | 未逐项独立证实 |
| 风控恢复 | 未逐项独立证实 |
| 双账号收发 | 未逐项独立证实 |

上述未证实范围不否定用户已确认的整体人工验收，也不要求用户重做已确认项目。

## 技术与来源边界

- 固定 HTTPS GET 路径的客户端、扫码登录、账号检查、会话和历史读取适配。
- 独立 `xiaoheihe` 凭据分区、共享 B 站 owner 绑定与 `reserveSendCall`/`rateInfo` 发送预算。
- 独立状态文件、首次历史窗口基线、受限发现和精确续拉位置；无法证明分页时保持 `limited/gap`。
- 脱敏验收日志与认证维护页只读快照；日志不写 Cookie、QR 密钥、完整 UID/目标/消息 ID、正文、完整 URL 或原始异常。
- 请求策略 `XHH_*` 分类、Retry-After、共享预算、扫码取消/停用/换号保护和页面平台隔离。
- 传输保持可选 Electron `net.request` 或标准 `node:https.request`，固定 HTTPS GET、无自动重定向、无自动切换、共享请求策略和 15 秒总截止。
- `0.4.2` 修正签名端口缺陷：JS `mixColumns` 遗漏 Python 参考 `_mix_columns` 保留的最后两个未变换校验字节；固定参考向量旧值为 `SPSPW16 / IZITX58 / VV10Y48`，正确值为 `SPSPW24 / IZITX11 / VV10Y50`。本地冷却或预算阻止请求时报告 `XHH_COOLDOWN`／`XHH_BUDGET` 和剩余等待，区别于真实网络超时。

## 固定来源

| 参考 | 固定提交 | 使用边界 |
| --- | --- | --- |
| `WenfuRainbow/heybox` | `afbe8a5f0629aafcd7e17d1c56eeec84ff4dd1bf` | 许可证未核实；未整体复制实现 |
| `advent259141/astrbot_plugin_xiaoheihe_adapter` | `534b9479e9bebe4ef82d9ec959d0c11146c90078` | Apache-2.0；接口与局限参考，许可证文本随包 |

```text
https://github.com/WenfuRainbow/heybox/tree/afbe8a5f0629aafcd7e17d1c56eeec84ff4dd1bf
https://github.com/WenfuRainbow/heybox/blob/afbe8a5f0629aafcd7e17d1c56eeec84ff4dd1bf/src/api/client.ts
https://github.com/advent259141/astrbot_plugin_xiaoheihe_adapter/tree/534b9479e9bebe4ef82d9ec959d0c11146c90078
https://github.com/advent259141/astrbot_plugin_xiaoheihe_adapter/blob/534b9479e9bebe4ef82d9ec959d0c11146c90078/xhh_client.py
https://github.com/advent259141/astrbot_plugin_xiaoheihe_adapter/blob/534b9479e9bebe4ef82d9ec959d0c11146c90078/LICENSE
```

## 可选后续回归指南

以下步骤不是本次待办，只在需要补充分项证据时可选执行：

1. 在机器人主人 QQ 私聊发送 `/解析 私信 绑定`，或确认已有主人绑定。
2. 发送 `/解析 私信 小黑盒 登录`，用小黑盒手机客户端扫码确认；二维码不会出现在群聊或公开状态。
3. 显式发送 `/解析 私信 小黑盒 开`。首次启用只建立历史窗口基线，不批量转发旧未读。
4. 用另一授权账号发送带唯一标记的新文字，核对 `/解析 私信 小黑盒 状态`、选定的 QQ 目标和验收记录。
5. 检查读取前后未读状态；不要调用已读、发送或回复 API，不要为提高覆盖制造 429。
6. 验证重复读取、跨页、长文字、图片/分享、断线恢复、换号和重载；无法证明完整性时保持 `limited/gap`，不宣称全部同步。
7. 核对脱敏日志与实际结果后补充协议记录；能力声明应与已核实的证据一致。

Mock、fake 网络与本地自动化只证明门禁、路由、调度、存储和页面行为，不计为真实协议验收通过。
