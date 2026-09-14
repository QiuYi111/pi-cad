# 01: 接入 Prime 原生模型目录

**What to build:** 用户在设置页浏览、搜索并选择 Prime Agent 当前版本提供的全部提供商和模型。列表、能力和认证状态均来自 Prime，不再由 Reify 写死。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 设置页从 Prime `ModelRegistry` 获取完整目录，并区分完整目录与当前可用模型。
- [ ] 每个模型显示提供商、名称、图像输入和可用推理等级；不能把模型 ID 当自由文本输入。
- [ ] 认证状态绑定当前提供商；选择 Z.AI 时不能显示 ChatGPT 登录状态。
- [ ] Prime 更新、自定义模型变化或刷新后，界面无需修改硬编码名单即可显示变化。
- [ ] 目录在尚未启动对话会话时也能加载；加载、空目录和错误状态可恢复。
