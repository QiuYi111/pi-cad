# 04: 支持高级与自定义提供商配置

**What to build:** 用户可完成非单一 API key 提供商及自定义端点的必要配置，并由 Prime 原生格式加载这些提供商和模型。

**Blocked by:** 01: 接入 Prime 原生模型目录；02: 完成 API key 配置链路。

**Status:** ready-for-agent

- [ ] Azure、Cloudflare、Bedrock 和 Vertex 按 Prime 要求显示对应的地址、账号、区域、项目或身份字段。
- [ ] 密钥与非敏感设置分开保存；密钥不得写入普通 Reify 设置。
- [ ] 用户可创建、修改和删除 Prime 原生自定义提供商、端点、请求协议和模型定义。
- [ ] 保存前使用 Prime 规则验证配置；错误指向具体字段，不能破坏已有可用配置。
- [ ] 保存后刷新 `ModelRegistry`，新增或覆盖的模型立即出现在完整目录中。
- [ ] 本地模型、OpenAI 兼容端点和至少一种云提供商完成真实连接验证。
