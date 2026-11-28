# 0.4.2 相对已安装 0.4.1 的改动

小黑盒扫码签名修正、本地冷却／预算区分，以及人工验收确认。证据与边界见 TEST-REPORT.md 和 LIVE-VALIDATION.md。

## 0.4.2 相对 0.4.1

| 文件 | 变化 |
| --- | --- |
| `CHANGELOG.md` | 修改 |
| `ENGINE-PROVENANCE.json` | 修改 |
| `README.md` | 修改 |
| `TEST-REPORT.md` | 修改 |
| `docs/xiaoheihe-dm-contract.md` | 修改 |
| `index.js` | 修改 |
| `package.json` | 修改 |
| `page.html` | 修改 |
| `test/bili-integration.mjs` | 修改 |
| `test/bili-panel.mjs` | 修改 |
| `test/v03-integration.mjs` | 修改 |
| `test/v03-ui.mjs` | 修改 |
| `test/xhh-c-integration.mjs` | 修改 |
| `test/xhh-client.mjs` | 修改 |
| `test/xhh-login.mjs` | 修改 |
| `test/xhh-signature.mjs` | 新增 |
| `xiaoheihe-client.js` | 修改 |
| `xiaoheihe-login.js` | 修改 |
| `CHANGED-FILES.md` | 本次生成 |

## 本次市场整理

市场基准为 0.2.0；本次仅对未提交的 0.4.2 做文档与字面量元数据适配，不提升版本号，也不修改引擎、vendor、`package.json`、`ENGINE-PROVENANCE.json`、生产插件或宿主。

| 文件 | 变化 |
| --- | --- |
| `index.js` | 仅将 manifest 的 `version: VERSION` 改为字面量 `version: '0.4.2'`；`export const VERSION` 保留，其他代码不动 |
| `README.md` | 整理 0.4 能力、人工验收状态、日志证据与限制 |
| `TEST-REPORT.md` | 改为 0.4.2 发布说明，区分用户确认、日志确认、既有离线回归与未逐项证实范围 |
| `LIVE-VALIDATION.md` | 重写为脱敏聚合验收摘要 |
| `CHANGELOG.md` | 仅更新 0.4.2 段，并为历史条目加说明 |
| `SOURCES.md` | 版本更新到 0.4.2，去除本机路径依赖并说明签名修复 |
| `docs/xiaoheihe-dm-contract.md` | 区分已确认、日志证据与未逐项证实范围 |
| `CHANGED-FILES.md` | 更新本清单 |
| `test/xhh-c-integration.mjs` | 仅将离线测试夹具常量改为 `WEIBO_FAKE_OTHER_PROVIDER_SECRET`，明确标识占位值以避开硬编码凭据扫描；不影响运行时代码 |
| `test/xhh-c-integration.mjs` | EOF 空白规范化：末尾多个换行收敛为一个 LF，文件其余字节不动 |
| `test/xhh-signature.mjs` | EOF 空白规范化：末尾多个换行收敛为一个 LF，文件其余字节不动 |

## 小黑盒私信转正式能力

用户已完成小黑盒实验与真机验收，本次去除实验性标记，转为正式能力。仍默认关闭，检查、冷却、脱敏边界和 `limited/gap` 限制说明保持不变；不提升版本号。

| 文件 | 变化 |
| --- | --- |
| `private-message-providers.js` | 小黑盒 `verified: true`，移除 `experimental` 声明；公开能力不再输出小黑盒 `experimental` 标记，B站能力形状保持不变 |
| `index.js` | 移除小黑盒状态模型、平台摘要和复合模型中的 `experimental: true`；更新配置标签、状态回退、命令菜单/状态/启用提示，删除验收状态文案并保留限制说明 |
| `page.html` | 小黑盒初始能力改为 `verified: true` 且无 `experimental`；删除“原生接入验收中”，可见文案不再由 `experimental` 控制 |
| `settings.js` | 删除过时的 `experimental` 注释，逻辑与默认值不变 |
| `test/v03-integration.mjs` | 更新小黑盒能力、状态和命令文案断言为正式能力 |
| `test/v03-ui.mjs` | 更新页面文案断言，确认不再包含验收状态或 `experimental` |
| `test/xhh-c-integration.mjs` | 更新小黑盒路由能力断言为 `verified: true` 且无 `experimental` |
| `README.md` | 明确小黑盒已完成实验与真机验收并转正式，保留分页/未读边界 |
| `TEST-REPORT.md` | 记录正式能力状态，保留日志证据与未逐项证实范围 |
| `LIVE-VALIDATION.md` | 更新能力边界为正式能力，保留未逐项证实说明 |
| `CHANGELOG.md` | 0.4.2 段记录转正式；0.4.0/0.4.1 注明当时为实验接入 |
| `SOURCES.md` | 说明小黑盒已转正式能力 |
| `docs/xiaoheihe-dm-contract.md` | 状态改为正式原生私信接入，保留证据分级与限制 |
| `CHANGED-FILES.md` | 更新本清单 |
