# Prime Agent 原生模型配置调研

调研日期：2026-09-10。依据 Prime Agent 官方仓库 `main` 的提交 [`81cd539`](https://github.com/PrimeIntellect-ai/prime-agent/tree/81cd5390dbc871afb87be0d2012d205dd633bae3)。下文的数量是该提交的快照，不能写死进 Reify。

## 结论

Reify 应把 Prime Agent 当成模型配置的唯一数据源：

- 用 Prime 的 `AuthStorage` 读写凭据、登录、登出和刷新 OAuth。
- 用 Prime 的 `ModelRegistry` 枚举提供商与模型、读取认证状态、合并 `models.json`。
- UI 只展示 Prime 返回的数据，不维护自己的提供商、模型或推理等级表。
- “全部模型”应展示 `ModelRegistry.getAll()`；“当前可用”应展示 `refreshAvailableModels()`。后者会按凭据与授权过滤。
- 保存 API key 后刷新 registry；OAuth 完成后也刷新。模型选择保存 `provider`、`modelId`、`thinkingLevel` 三项。
- 自定义端点和本地模型继续使用 Prime 原生的 `~/.prime/agent/models.json`，Reify 可提供表单编辑，但不能另造格式。

Prime 官方明确说明：外部提供商模型目录随 Prime Agent 版本打包；Prime Inference 才会从 `/models` 在线刷新，并用内置目录和磁盘缓存兜底。设置 `PI_OFFLINE=1` 会跳过刷新。[官方 providers 文档](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/docs/providers.md)

## 提供商和模型枚举

内置目录位于自动生成的 [`packages/ai/src/models.generated.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/ai/src/models.generated.ts)。`getProviders()` 和 `getModels(provider)` 从该目录读取；`getModel()` 按提供商和模型 ID 查询。[`models.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/ai/src/models.ts)

该提交共有 32 个内置提供商、1281 条模型记录：

| 提供商 ID | 模型数 | 常用认证 |
|---|---:|---|
| `amazon-bedrock` | 122 | AWS profile、IAM、Bearer、ECS/IRSA |
| `anthropic` | 14 | API key 或 Claude OAuth |
| `azure-openai-responses` | 42 | API key + Azure 地址/资源名 |
| `cerebras` | 2 | API key |
| `cloudflare-ai-gateway` | 32 | API key + account/gateway ID |
| `cloudflare-workers-ai` | 18 | API key + account ID |
| `deepseek` | 2 | API key |
| `fireworks` | 20 | API key |
| `github-copilot` | 28 | GitHub OAuth/token |
| `google` | 17 | Gemini API key |
| `google-vertex` | 13 | Google API key或 ADC |
| `groq` | 7 | API key |
| `huggingface` | 71 | API key |
| `kimi-coding` | 4 | API key |
| `minimax` | 2 | API key |
| `minimax-cn` | 2 | API key |
| `mistral` | 32 | API key |
| `moonshotai` | 10 | API key |
| `moonshotai-cn` | 10 | API key |
| `openai` | 42 | OpenAI API key |
| `openai-codex` | 14 | ChatGPT OAuth |
| `opencode` | 68 | API key |
| `opencode-go` | 27 | API key |
| `openrouter` | 297 | API key |
| `prime-inference` | 110 | Prime API key；目录在线刷新 |
| `vercel-ai-gateway` | 237 | API key |
| `xai` | 7 | API key |
| `xiaomi` | 6 | API key |
| `xiaomi-token-plan-ams` | 6 | API key |
| `xiaomi-token-plan-cn` | 6 | API key |
| `xiaomi-token-plan-sgp` | 6 | API key |
| `zai` | 7 | API key |

不要把这张表用于运行时枚举。它只证明当前官方目录范围。运行时应调用以下 Prime API：

```ts
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const allModels = modelRegistry.getAll();
const availableModels = await modelRegistry.refreshAvailableModels();
const status = authStorage.getAuthStatus(providerId);
const oauthProviders = authStorage.getOAuthProviders();
```

`getAll()`、`getAvailable()` 与 `refreshAvailableModels()` 的语义见 [`model-registry.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/src/core/model-registry.ts#L800-L840)。官方 CLI 的 `prime-agent model list` 本身也是调用 `refreshAvailableModels()`，再展示 provider、model、context、max-out、thinking、images。[`list-models.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/src/cli/list-models.ts)

### 动态发现的边界

Prime 没有对所有提供商逐个请求 `/models`。实际来源有四类：

1. 外部提供商：发布时生成的静态目录。
2. Prime Inference：后台刷新公共目录，并按账号查询私有模型授权；磁盘缓存避免启动被网络卡住。[目录刷新源码](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/src/core/prime-inference-model-catalog.ts)
3. `models.json`：本地自定义或覆盖模型；每次打开 `/model` 都会重读，不用重启。[官方 models 文档](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/docs/models.md)
4. 扩展注册：`pi.registerProvider()` 可在启动时添加/替换提供商，包括自定义 OAuth 和模型。[官方扩展文档](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/docs/custom-provider.md)

因此 Reify 的“刷新模型”应调用 Prime registry；不能承诺从 OpenAI、Anthropic、OpenRouter 等远端实时发现全部新模型。要获得它们的新内置目录，需要升级 Prime，或由用户在 `models.json` 增补。

## API key

原生持久文件是 `~/.prime/agent/auth.json`，权限为 `0600`。格式：

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "openai": { "type": "api_key", "key": "sk-..." }
}
```

`key` 可为明文、环境变量名或以 `!` 开头的取密钥命令。认证优先级为：运行时 `--api-key`、`auth.json`、环境变量、`models.json`。[官方 providers 文档](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/docs/providers.md#resolution-order)

主要环境变量由官方 [`env-api-keys.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/ai/src/env-api-keys.ts) 定义：

```text
ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN
OPENAI_API_KEY
AZURE_OPENAI_API_KEY
PRIME_API_KEY
DEEPSEEK_API_KEY
GEMINI_API_KEY
GOOGLE_CLOUD_API_KEY
MISTRAL_API_KEY
GROQ_API_KEY
CEREBRAS_API_KEY
CLOUDFLARE_API_KEY
XAI_API_KEY
FIREWORKS_API_KEY
OPENROUTER_API_KEY
AI_GATEWAY_API_KEY
ZAI_API_KEY
MINIMAX_API_KEY / MINIMAX_CN_API_KEY
MOONSHOT_API_KEY
HF_TOKEN
OPENCODE_API_KEY
KIMI_API_KEY
XIAOMI_API_KEY
XIAOMI_TOKEN_PLAN_CN_API_KEY
XIAOMI_TOKEN_PLAN_AMS_API_KEY
XIAOMI_TOKEN_PLAN_SGP_API_KEY
COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN
```

Azure、Cloudflare、Bedrock、Vertex 还需要地址、账号、区域或云端身份等配套字段，不能把所有提供商简化成一个 key 输入框。完整要求见[官方 providers 文档](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/docs/providers.md)。

程序内临时 key 可用 `authStorage.setRuntimeApiKey(provider, key)`，但不会持久化。持久设置应使用 `AuthStorage` 的存储方法，而不是 Reify 自己直接并发改 JSON；官方实现带文件锁、原子写入和跨进程刷新。[`auth-storage.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/src/core/auth-storage.ts)

## OAuth 与登录流程

Prime 当前原生 OAuth 提供商只有三种：

- `openai-codex`：ChatGPT Plus/Pro。
- `anthropic`：Claude Pro/Max。
- `github-copilot`：GitHub Copilot，支持 GitHub Enterprise 域名。

注册表源码见 [`utils/oauth/index.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/ai/src/utils/oauth/index.ts)。不要根据“提供商有模型”推断它支持 OAuth。例如 `openai` 是 API key，ChatGPT OAuth 对应另一个 provider ID：`openai-codex`。

统一调用形式：

```ts
await authStorage.login(providerId, {
  onAuth: ({ url, instructions }) => openExternal(url),
  onDeviceCode: ({ userCode, verificationUri }) => showDeviceCode(userCode, verificationUri),
  onPrompt: async ({ message }) => await promptUser(message),
  onProgress: (message) => updateStatus(message),
});

authStorage.logout(providerId);
```

`login()` 调用对应 provider 的 OAuth 实现并把 `refresh`、`access`、`expires` 写入 `auth.json`；请求时自动刷新过期 token。[OAuth 工具源码](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/ai/src/utils/oauth/index.ts)、[`AuthStorage.login`](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/src/core/auth-storage.ts#L780-L800)

Reify 必须完整转发四类回调：打开浏览器、显示设备码、请求手工输入、进度。OpenAI 回调页显示成功后，后端仍要收到并保存凭据，再刷新状态；浏览器成功页本身不能当成登录完成。Prime 交互端还支持 callback server 失败时粘贴 redirect URL。[官方登录流程源码](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/src/modes/interactive/auth-flows.ts#L799-L860)

扩展提供商可带自己的 OAuth；UI 应通过 `getOAuthProviders()` 判断是否显示“网页登录”，而不是硬编码三个按钮。[自定义 OAuth 文档](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/docs/custom-provider.md#oauth-support)

## 推理等级

每条模型记录包含 `reasoning` 和可选 `thinkingLevelMap`。Prime 的等级为：

```text
off, minimal, low, medium, high, xhigh, max
```

若 `reasoning=false`，只支持 `off`。在 `thinkingLevelMap` 中：缺省表示使用提供商默认映射；字符串表示发给提供商的实际值；`null` 表示不支持。`xhigh` 和 `max` 只有显式映射时才出现。Prime 提供 `getSupportedThinkingLevels(model)` 和 `clampThinkingLevel(model, requested)`，UI 应直接调用，不能固定显示 `low/medium/high`。[`models.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/ai/src/models.ts)、[配置说明](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/docs/models.md#thinking-level-map)

模型记录还包含 `input`、`contextWindow`、`maxTokens`、成本和 API 类型。至少应在 UI 中据此标明图像输入与推理支持；不能允许 CAD 图像任务无提示地选择 text-only 模型。

## 收藏模型、默认模型与快速切换

Prime 原生已经有对应机制：

- `defaultProvider` + `defaultModel`：新会话默认模型。
- `defaultThinkingLevel`：新会话默认推理等级。
- `enabledModels`：模型范围，也就是 Ctrl+P 快速轮换列表。
- 会话内 `scopedModels`：当前会话的临时轮换列表，可为每个模型带独立 `thinkingLevel`。

持久配置位于 `~/.prime/agent/settings.json`：

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "medium",
  "enabledModels": [
    "openai-codex/gpt-5.6-sol:medium",
    "anthropic/claude-opus-4-6:high"
  ]
}
```

`enabledModels` 支持精确的 `provider/model:thinkingLevel`，也支持 glob。Reify 的收藏界面应保存精确 ID，避免以后新增模型被通配符意外加入。Prime 的解析、去重、别名选择和推理等级解析应继续由 `resolveModelScopeFromModels()` 负责。[官方 settings 文档](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/docs/settings.md#model-cycling)、[模型范围解析源码](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/src/core/model-resolver.ts)

建议在产品文案中叫“收藏模型”，底层仍映射 Prime 的 `enabledModels/scopedModels`：

1. 完整目录：搜索全部 Prime 模型。
2. 收藏模型：用户勾选并排序的常用模型；顶部模型按钮只在这里快速切换。
3. 默认模型：收藏中的一个模型，用于新会话；允许同时保存该模型的默认推理等级。
4. 当前模型：当前会话实际使用的模型；切换立即调用 `set_model`，不改默认值。

应增加 RPC：

```ts
models.favorites.get()
models.favorites.save({ models: [{ provider, modelId, thinkingLevel }] })
models.favorites.reorder({ models })
models.default.get()
models.default.set({ provider, modelId, thinkingLevel })
models.current.set({ provider, modelId, thinkingLevel })
models.cycle({ direction: "forward" | "backward" })
```

保存收藏时写 Prime 原生 `enabledModels`，保存默认模型时写 Prime 原生三个 default 字段。会话已经运行时，再调用 Prime 的 `setScopedModels()` 同步收藏列表；只影响本次会话的临时修改可以不落盘。

界面规则：

- 默认模型必须已认证且当前可用。
- 收藏可以包含暂未认证的模型，但要标出“需要登录/API key”；切换时先进入认证流程。
- 删除正在使用的收藏不强制切换当前会话。
- 删除默认收藏时要求立即选新默认，或回退到 Prime 的首个可用模型。
- 恢复旧会话优先恢复该会话原模型，不能被新默认模型覆盖。
- Author 与 reviewer 各自保存默认模型；收藏目录和凭据共用。

Prime 的默认模型回退顺序是：恢复会话模型、已指定模型、范围内首个模型、全局默认模型、首个可用模型。Reify 不应另写一套不同的回退逻辑。[官方 SDK 文档](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/docs/sdk.md)、[模型选择源码](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/src/core/model-resolver.ts)

## Reify 实现建议

在运行 Prime 的同一 WSL 进程侧新增一组薄 RPC，桌面端不直接解析 Prime 私有文件：

```ts
type ProviderView = {
  id: string;
  name: string;
  auth: AuthStatus;
  oauth: boolean;
  models: ModelView[];
};

models.catalog({ includeUnavailable: true })
auth.status({ provider })
auth.setApiKey({ provider, key })
auth.logout({ provider })
auth.oauthStart({ provider })
auth.oauthInput({ flowId, value })
auth.oauthCancel({ flowId })
models.refresh()
models.validateSelection({ provider, modelId, thinkingLevel })
```

具体流程：

1. 启动后构造一个共享 `AuthStorage` 和 `ModelRegistry`。
2. `models.catalog` 用 `getAll()` 分组，并为每组附 `getAuthStatus()` 与 `getOAuthProviders()` 结果。
3. API key 保存走 `AuthStorage`，随后 `modelRegistry.refresh()`；返回脱敏状态，绝不把 key 回传 UI。
4. OAuth 用带 `flowId` 的事件流承接 Prime callbacks；只有 `authStorage.login()` resolve 后才显示已连接。
5. 每次打开模型选择器调用 `refreshAvailableModels()`；另显示未认证的 `getAll()` 模型，方便先选提供商再登录。
6. 推理下拉框由 `getSupportedThinkingLevels(model)` 生成；保存前再 clamp/校验。
7. 设置页增加“自定义提供商”，写 Prime 原生 `models.json`，保存后调用 `refresh()` 并把 `getError()` 原样显示。
8. 作者与 reviewer 都复用同一目录和认证能力，只分别保存选择。

### API key 完整链路

1. 用户选择 provider。界面显示该 provider 的认证要求；Azure、Cloudflare、Bedrock、Vertex 同时显示必要的配套字段。
2. 用户输入 key。前端只把它传给 WSL 后端，不写本地缓存、日志或错误信息。
3. 后端持久保存：

   ```ts
   authStorage.set(providerId, { type: "api_key", key });
   modelRegistry.refresh();
   ```

   `set()` 会替换该 provider 的旧凭据，并通过文件锁合并写入，其他 provider 不受影响。[`set/remove` 源码](https://github.com/PrimeIntellect-ai/prime-agent/blob/81cd5390dbc871afb87be0d2012d205dd633bae3/packages/coding-agent/src/core/auth-storage.ts#L674-L718)
4. 返回 `getAuthStatus(providerId)` 和过滤后的模型，不返回 key。建议显示来源：stored、environment、runtime、prime_cli、models_json 等。
5. “更换 key”走同一个 `set()`；成功后旧 key 被原子替换。请求失败则保留原状态并显示明确错误。
6. “退出/删除凭据”只处理当前 provider：OAuth 与普通 API key 都调用 `logout(providerId)`；如果需要把落盘删除失败当成硬错误，可在 RPC 内使用 `removeVerified(providerId)`。随后 `modelRegistry.refresh()`。
7. 环境变量认证不能由 `logout()` 删除。若状态来源是 `environment`，UI 应显示“由环境变量提供”，并说明需要修改对应环境变量；不能假装退出成功。

API key 表单要区分“凭据”和“提供商设置”。凭据进 `auth.json`；`baseUrl`、Azure deployment map、自定义 headers、模型定义等走 Prime 原生 `models.json` 或环境变量。不能把这些字段塞进 `auth.json`。

### OAuth 完整链路

1. UI 从 `authStorage.getOAuthProviders()` 判断当前 provider 是否支持 OAuth。
2. 点击登录后创建 `flowId`，后端开始 `authStorage.login(providerId, callbacks)`。
3. `onAuth`：桌面端打开系统浏览器，并显示 URL/说明；不能马上显示“已连接”。
4. `onDeviceCode`：显示验证码和验证地址，并提供复制、打开按钮。
5. `onPrompt`：把 Prime 请求的文本输入绑定到同一 `flowId`，由用户提交；callback server 不可达时可粘贴 redirect URL。
6. `onProgress`：持续更新同一条登录状态，避免重复创建登录任务。
7. 只有 `login()` 成功 resolve、凭据已写入后，才执行 `modelRegistry.refresh()`，再用 `getAuthStatus(providerId)` 显示已连接。失败与取消要显示 Prime 返回的原始异常。
8. token 到期后的刷新由 `AuthStorage` 在取 key 时自动完成，并在文件锁内保存新 token；Reify 不接管 refresh token。
9. 重新登录同一 provider 会替换该 provider 的 OAuth 凭据，不影响其他 provider。
10. 退出只调用 `authStorage.logout(providerId)`，随后刷新目录。按钮必须写明所退出的 provider，例如“退出 ChatGPT”；不能用一个全局退出按钮清空全部认证。

建议 RPC 明确区分操作结果：

```ts
type AuthMutationResult =
  | { ok: true; provider: string; status: AuthStatus }
  | { ok: false; provider: string; code: string; message: string };
```

这样 `fetch failed`、浏览器已授权但回调未到、保存失败、刷新失败不会都被压成同一个“未连接”。

当前截图中的主要逻辑错误是认证状态没有绑定所选 provider：选择 Z.AI 时仍显示 `ChatGPT connected`。修复后，状态必须来自 `authStorage.getAuthStatus("zai")`；ChatGPT 登录只属于 `openai-codex`。

## 不应实现

- 不写死提供商名单、模型名或默认模型。
- 不把模型字段做成自由文本作为主要选择方式。
- 不为所有提供商统一显示“使用 ChatGPT 登录”。
- 不自己实现 token 刷新或用浏览器成功页猜测登录成功。
- 不把 key 存在前端状态、项目文件或普通 settings JSON。
- 不声称支持所有提供商的 OAuth；原生能力和扩展能力应由 Prime 注册表决定。
- 不用远端 `/models` 结果替换 Prime 模型元数据；推理等级、图像输入、上下文和兼容参数仍应以 registry 为准。
