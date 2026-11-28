# 源码来源与适配记录

插件：`media-parser`，版本 `0.4.2`，日期 2026-11-28。0.4.0 接入原生小黑盒运行时，0.4.1 增加原生 HTTP 兼容候选和有限进度诊断，0.4.2 修正已确认的扫码签名端口缺陷并保留冷却／预算分类修复；小黑盒私信已完成实验与用户真机验收，转为正式能力（`verified: true`，移除 `experimental` 标记）。均未整体复制许可证不明或未审阅的 heybox 实现。A 负责的适配代码随包附带 Apache-2.0 文本 `licenses/xiaoheihe-adapter-Apache-2.0.txt`。0.2 及更早来源记录保留于下文。

## 0.3 研究与来源边界

本次基于已验收的 0.2 本地代码增加平台薄适配、请求协调器和管理页调整。原始引擎、vendor 与引擎协议版本不随插件展示版本变化。

HTTP 等待时间语义参考 RFC 6585 第 4 节与 RFC 9110 第 10.2.3 节。实现参数 300 秒、5 秒、每分钟预算及逐级冷却属于本插件策略，不是平台官方安全阈值。

B 站业务拒绝参考 `moxingovo/dsh-bilibili` 的公开 README 对 `-101`、`-412`、`-403` 的处理说明。仅按平台和可信响应结构识别；不把所有 HTTP 403/412 当作 Cookie 失效、挑战或限流。

小黑盒参考固定为 `WenfuRainbow/heybox` 提交 `afbe8a5f0629aafcd7e17d1c56eeec84ff4dd1bf` 与 `advent259141/astrbot_plugin_xiaoheihe_adapter` 提交 `534b9479e9bebe4ef82d9ec959d0c11146c90078`。后者带 Apache-2.0，本包在 `licenses/xiaoheihe-adapter-Apache-2.0.txt` 保留其许可证文本；前者许可证尚未核实，未整体复制。0.4.0 的小黑盒客户端、登录、运行时、存储、投递与验收日志为按接口约定重新实现的本插件模块，不导入其框架或加入运行依赖；研究下载文件不进交付包。哪些字段、子能力和分页尚未逐项独立证实见 [协议记录](./docs/xiaoheihe-dm-contract.md)。

来源地址：

```text
https://www.rfc-editor.org/rfc/rfc6585.html#section-4
https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
https://github.com/moxingovo/dsh-bilibili
https://github.com/WenfuRainbow/heybox/tree/afbe8a5f0629aafcd7e17d1c56eeec84ff4dd1bf
https://github.com/advent259141/astrbot_plugin_xiaoheihe_adapter/tree/534b9479e9bebe4ef82d9ec959d0c11146c90078
```

## 原始来源

- 本次移植参考：原始 QQA media-parser `1.0.1` 归档。
- 引擎上游标识：`drdon1234/astrbot_plugin_media_parser`，随原始包保留其源代码和 GNU Affero General Public License v3.0 许可证。
- Roost 本机接口参考：`demo-x`、`echo`、`src/plugin/context.js`、`src/message.js`、`src/outbound.js`、`src/onebot/voice.js`。没有复制或修改宿主实现。
- 本次没有取得或声称上游 Git commit。来源以该原始归档及内容摘要为可复核基线，没有自动获取最新上游。

原始 `engine.tar.gz` 未修改，SHA-256：

```text
d75f10eba41d3c202696d3da7c5c5efce1135b39401fd4cf170075e37bba9c05
```

原包包含 119 个普通文件，其中 114 个 Python 源码文件。随包 `engine/vendor/core/` 和 `engine/vendor/astrbot_shim/` 保留原始内容，最终逐文件比对结果见测试报告。

## 新增 Roost 层

JS 入口、链接识别、队列、引擎托管、文件检查、有序发送、短语音兼容、管理页面及测试均位于插件目录。原 QQA `index.js`、`engine-host.js` 和 `plugin.json` 未作为 Roost 入口复用；本插件不实现 QQA 共用运行或配置迁移。

## 0.2.0 集成层与审核模块

本次在开发副本中更新了 `index.js`、`panel.js`、`page.html`、`settings.js`、`package.json`、`README.md`、`CHANGELOG.md`、`SOURCES.md`、`TEST-REPORT.md`、`MIGRATION-ROLLBACK.md`，新增集成测试 `test/bili-integration*.mjs`、`test/bili-panel*.mjs`、`test/bili-dm-groups.mjs`、`test/settings-lifecycle.mjs`。

新增 `bili-dm-groups.js` 只使用宿主公开 `ctx` 接口：`ctx.ledger.stats()?.byChat` 的群类型行、普通群入站消息观察、`ctx.state` 有界缓存和 `ctx.getGroup` 校验。它不读取宿主存储路径、群正文、账本文件或其他插件源码；候选群 ID 不会进入公开聚合状态。群目标选择器按用户要求在专用认证路由中返回宿主允许的 `{id,name}` 选项。

B 站私信的独立实现模块 `bili-dm.js`、`bili-dm-store.js`、`bili-dm-delivery.js`、`bili-dm-content.js` 随插件交付，分别负责同步、原子状态、宿主投递和内容归一化。运行时通过插件内相对路径加载，私信模块加载失败时显示有限错误状态，不影响媒体解析入口。新增模块沿用本插件 AGPL-3.0-only 许可；实际文件 SHA-256 由交付包外的 `files-sha256.json` 记录。

原 `engine.tar.gz` 未修改，SHA-256 仍为：

```text
d75f10eba41d3c202696d3da7c5c5efce1135b39401fd4cf170075e37bba9c05
```

## B 站登录、二维码与私信接口来源

本次新增 Node 模块的接口契约参考 `pskdje/bilibili-API-collect`（master，获取日期 2026-11-25）的公开文档，摘要如下：

- 私信会话与消息：`private_msg.md`（会话列表、消息分页与字段说明）。
- 私信内容类型：`private_msg_content.md`（文字、图片、分享等内容类型）。
- 网页扫码登录：`QR.md`（二维码申请、轮询与状态码）。

扫码状态机和本地二维码实现参考 Roost `bili` 插件快照中的两份文件（AGPL-3.0-only，与本插件许可证兼容），保留文件名与摘要以便复核：

- `qr-login.mjs`（登录状态机）
  SHA-256 `466e4b81f8ffe482aca4f282689ada6ded67db72c538e6dfa75dad503ab3cb49`
- `qr-encode.mjs`（本地二维码编码）
  SHA-256 `c9cf28d9d973d7989af4c2bfd0f950afc6700009295900dedddf32608bf521e7`

本地 `bili-qr.js` 改编自上述 `qr-encode.mjs`，保留纯本地二维码位矩阵和 PNG 渲染，移除了可选共享 `qrcode` 依赖加载器。没有复制原实现向插件根目录写 `cookie.txt`、记录扫码密钥或启动浏览器的做法；二维码只以内存 PNG data URL 提供。`bili-client.js`、`bili-login.js` 按上述接口文档重新实现，未把示例凭据、UID 或正文写入配置。

## Python service 适配

运行时从原始包安全解包，再覆盖本插件可审阅的 `engine/service/*.py` 和 `engine/run_engine.py`。服务源码摘要同时覆盖原始静态内容和覆盖层，用于就绪检测、身份核对和热重载复用。

主要适配内容：

- 强制回环监听和本地认证；增加服务、实例、插件版本与源码摘要。
- 共享截止时间、请求取消和子进程归属跟踪，Windows 子进程隐藏窗口。
- 将缓存、解析记录、字体和运行状态置于独立数据目录。
- 按真实路径检查的删除操作、缓存大小及保留期上限、解析和发送租约。
- 配置覆盖、200 MiB 有效上限、关闭自动引用和默认关闭翻译。
- 网络请求、DNS 连接地址与每次重定向检查；显式代理目标 IP 固定；凭据和日志脱敏。
- 在 service 层运行时适配 TikTok 抓页及视频封面中继；保留 `vendor/core` 的原文件。
- 在 service 层约束 ffmpeg 输入的路径、协议与格式，防止媒体伪装成联网清单。

`engine/config.example.json` 仅规范化换行符为 LF，不改变原始示例内容。托管有效配置由 JS 层生成，不会沿用原示例中的 300 MB 上限。

完整的原始／当前文件摘要、修改列表与测试报告随最终交付生成，见 `ENGINE-PROVENANCE.json`、`CHANGED-FILES.md` 和 `TEST-REPORT.md`。
