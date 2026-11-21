# 第三方组件

本扩展沿用原 `voice-reply` 使用的 `silk-wasm` 编码器，分发锁定为 **3.7.1**，上游作者 **idranme**，许可证 **MIT**。

- 上游仓库：https://github.com/idranme/silk-wasm
- 对应 npm 版本：https://www.npmjs.com/package/silk-wasm/v/3.7.1
- 保留的许可证：`vendor/silk-wasm/LICENSE`
- 来源：原框架插件已安装的 npm `silk-wasm@3.7.1`，取其 `lib/index.mjs` 和 `lib/silk.wasm` 原字节复制到 `vendor/silk-wasm/`，没有修改编解码实现。
- 不附带 node_modules，不运行上游构建或安装脚本；运行时仅从同目录加载 WASM，无网络下载。

| 分发文件 | SHA-256 |
|---|---|
| `vendor/silk-wasm/index.mjs` | `1a95755169e70de059b47a7e7d81a2c3e4f0f0d2ac8d26a8d1d90eaeaac4f937` |
| `vendor/silk-wasm/silk.wasm` | `88152af59af535b8056ac806710824b2259a361027451b494f175f48fb39c807` |

本扩展其余代码按 ISC 许可分发；第三方 MIT 许可独立保留。模型权重、参考音频和 GPT-SoVITS 服务均不在分发包中，各自许可由相应提供方说明。
