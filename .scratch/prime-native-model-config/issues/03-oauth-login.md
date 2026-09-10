# 03: 完成通用 OAuth 登录链路

**What to build:** 用户可对 Prime 注册的 OAuth 提供商完成登录、取消、重新登录和单提供商退出，界面只在 Prime 真正保存凭据后显示已连接。

**Blocked by:** 01: 接入 Prime 原生模型目录。

**Status:** ready-for-agent

- [ ] OAuth 提供商通过 Prime 注册表动态发现，包括扩展注册的 OAuth，不能写死为 ChatGPT。
- [ ] 登录支持打开浏览器、设备码、手工输入或回填 redirect URL、进度和取消。
- [ ] 浏览器成功页不能直接改变界面状态；必须等待 Prime 登录调用完成并保存凭据。
- [ ] OAuth token 由 Prime 保存和刷新，renderer 不接触 access token 或 refresh token。
- [ ] 重新登录替换当前提供商凭据；退出只清除当前提供商。
- [ ] ChatGPT、Claude 和 GitHub Copilot 的真实成功、取消、超时和恢复路径均有端到端验证。
