# desktop 与 macOS 原生客户端功能对比

2026-10-10。对比代码：`ce59d7c6b2d74f0120b5680e470d8f5952295dc7`。desktop 为本分支中的现有 Electron 客户端；原生为 `apps/macos`。同时打开已登录真实云端的原生窗口，核实设置页。

这是初版对比，后续补齐进度见 [当前 87 项进度](PARITY-PROGRESS.zh-CN.md)，重新核查的行为差异、整页缺失及验收范围见 [全面复核](DESKTOP-COMPARISON-CURRENT.zh-CN.md)。下面的缺失数量描述初版，不代表后续代码。

**结论：原生版只实现基础云端流程，远未补齐 desktop。此前 E2E 通过不能代表完整交付。薄客户端应把计算放在云端，保留已有产品功能；不能据此删掉界面功能。**

对比以 desktop 的云端模式为主，沿着页面、控件、调用和云端实现核查。未重新运行 desktop 全套 E2E；“已有”表示原生存在对应实现，不表示行为、异常和所有环境都已验收。这里的功能项按表中粒度统计，不能当作完成百分比。

共 87 项：已有 11 项、部分 23 项、缺失 53 项。设置 16 项：已有 1 项、部分 5 项、缺失 10 项。表中“已有”不等于完整验收通过。

## 设置

desktop 设置是完整页面，包含项目、账户与模型、收藏、CAD 导出和高级配置。原生只有“模型设置”弹窗：服务商、模型、四个思考档位、可用模型菜单。

| 编号 | desktop 功能 | 原生 | 缺口 |
|---|---|---|---|
| S01 | 当前项目及切换入口 | 部分 | 项目页可切换，设置没有项目区 |
| S02 | 账户信息、退出登录 | 已有 | 在顶栏账户菜单，未并入设置 |
| S03 | 修改云端密码 | 缺失 | 没有界面和 API 调用 |
| S04 | 服务商列表、名称、连接状态 | 部分 | 只有可编辑 ID 和可用模型菜单，无完整服务商目录 |
| S05 | 模型列表、可用性、图片能力 | 部分 | 只保留已可用模型的 ID 和名称；未配置模型被过滤 |
| S06 | 凭据来源、状态、错误提示 | 缺失 | 没有读取和展示 |
| S07 | 保存、替换 API 密钥 | 缺失 | 依赖用户提前在别处配好云端账户 |
| S08 | 浏览器登录、手动回填登录结果 | 缺失 | 没有登录服务商的流程 |
| S09 | 移除服务商凭据 | 缺失 | 退出 Reify 不等于移除模型凭据 |
| S10 | 按模型支持范围选择思考档位 | 部分 | 写死 minimal/low/medium/high，缺 off/xhigh/max，丢弃目录的 thinkingLevels |
| S11 | 保存云端默认模型及思考档位 | 缺失 | 只保存本机偏好，没有调用云端 save-default |
| S12 | 独立审查模型：继承或另选 | 缺失 | 启动参数固定继承生成模型 |
| S13 | 搜索、收藏、移除收藏模型 | 缺失 | 没有收藏列表及保存功能 |
| S14 | 自定义服务商配置：读取、校验、保存 | 缺失 | 没有 models.json 编辑器及调用 |
| S15 | 设置草稿与明确保存 | 部分 | 字段直接绑定正在使用的值；关闭不会撤销内存中的修改 |
| S16 | 安装版本与渠道信息 | 缺失 | 设置没有版本信息 |

证据：[desktop 设置](../desktop/src/renderer/src/pages/Settings.tsx)、[云端账户](../desktop/src/renderer/src/components/CloudAccount.tsx)、[原生设置](Sources/Reify/Views.swift)、[原生模型目录](Sources/Reify/CloudModels.swift)、[原生设置保存](Sources/Reify/AppModel.swift)、[共享云端配置脚本](../../scripts/desktop-prime-config.mjs)。

## 云端与项目

| 编号 | desktop 功能 | 原生 | 缺口 |
|---|---|---|---|
| P01 | 真实云端登录、服务器地址 | 已有 | 真实账户已实测 |
| P02 | 保存登录、续期、退出 | 已有 | 钥匙串与令牌续期已实现 |
| P03 | 项目列表、创建、打开 | 已有 | 基础流程已实测 |
| P04 | 项目重命名 | 缺失 | 没有按钮和调用 |
| P05 | 项目删除及确认 | 缺失 | 没有按钮和调用 |
| P06 | 工作区启动、暂停、闲置提醒、继续使用 | 已有 | 基础流程已实现 |
| P07 | 排队、启动失败、重试状态 | 部分 | 有轮询和重连；没有 desktop 完整提示与状态展示，排队未做正式云端验收 |
| P08 | 自动重连及重连状态 | 部分 | 事件频道会重试；助手断线后要求手动重连，接回原进程已验证 |
| P09 | 登录被结束的原因提示 | 部分 | HTTP 续期失效会退回登录；未专门处理 session_ended 事件 |

证据：[desktop 项目](../desktop/src/renderer/src/pages/CloudProjects.tsx)、[desktop 云端提示](../desktop/src/renderer/src/components/CloudNotices.tsx)、[原生页面](Sources/Reify/WorkbenchViews.swift)、[原生 HTTP](Sources/ReifyCloud/CloudAPI.swift)、[原生状态处理](Sources/Reify/AppModel.swift)。

## 对话与输入

| 编号 | desktop 功能 | 原生 | 缺口 |
|---|---|---|---|
| H01 | 当前项目全部历史对话列表 | 缺失 | 侧栏只有当前对话 |
| H02 | 历史对话搜索 | 部分 | “搜索对话”只过滤当前对话的标题 |
| H03 | 切换指定历史对话 | 缺失 | 没有列表或 switchSession 调用 |
| H04 | 自动保存对话标题 | 部分 | 侧栏取第一条需求文本；没有保存会话名称 |
| H05 | 新对话 | 已有 | 能创建云端新会话 |
| H06 | 重启恢复选定对话 | 部分 | 能恢复最近日志或接回进程；没有选定历史会话的恢复机制 |
| H07 | 每个对话各自保存草稿 | 部分 | 草稿按项目保存，没有会话维度 |
| C01 | 文本发送与流式回复 | 已有 | 真实 GLM 已验证 |
| C02 | 停止当前任务 | 已有 | 有停止和超时兜底 |
| C03 | 图片附件、缩略图、移除附件 | 缺失 | 通用文件上传不能代替图片消息 |
| C04 | 把图片作为模型输入发送 | 缺失 | prompt 只有 message，没有 images |
| C05 | 任务进行中追加排队需求 | 缺失 | 运行中只有停止按钮 |
| C06 | 编辑、取消、恢复排队需求 | 缺失 | 没有队列 |
| C07 | 停止后修改需求、只存笔记 | 缺失 | 没有 desktop 的运行中发送选项 |
| C08 | 工作区/只读权限选择 | 缺失 | 只按项目角色固定权限；编辑者不能主动选只读 |
| C09 | 输入框内快速切换模型和思考档位 | 部分 | 两个按钮都打开设置；保存会重新连接，未使用即时切换调用 |
| C10 | 与实际运行模型和思考档位保持一致 | 部分 | 启动传参数，但 get_state 不更新实际模型/思考显示；接回旧进程时存在显示不一致风险，需 E2E 验证 |
| M01 | 复制消息、编辑并重发 | 部分 | 可选中文本；没有复制反馈和回填编辑按钮 |
| M02 | Markdown 表格、代码块、列表、链接 | 部分 | SwiftUI Text 只做有限格式显示，无完整 Markdown 组件 |
| M03 | 工具执行卡片、结果、指标、展开详情 | 缺失 | 工具调用只变成一句“正在制作模型” |
| M04 | 工具图片预览、引用具体结果 | 缺失 | 消息模型只保留文本 |
| M05 | 等待、重试、工具执行、超时、停止原因及计时 | 部分 | 只有生成布尔值、简短活动文字和错误；未还原详细阶段 |
| M06 | 阅读历史时控制自动滚动 | 部分 | 按消息数量滚到底，没有用户阅读位置判定 |

证据：[desktop 工作台](../desktop/src/renderer/src/pages/Workbench.tsx)、[desktop 输入框](../desktop/src/renderer/src/components/Composer.tsx)、[对话](../desktop/src/renderer/src/components/Conversation.tsx)、[工具卡片](../desktop/src/renderer/src/components/ActivityCard.tsx)、[Markdown](../desktop/src/renderer/src/components/MarkdownText.tsx)、[原生工作台](Sources/Reify/WorkbenchViews.swift)、[原生消息类型](Sources/ReifyCloud/Models.swift)、[原生事件处理](Sources/Reify/AppModel.swift)。

## 画布、模型与工程结果

| 编号 | desktop 功能 | 原生 | 缺口 |
|---|---|---|---|
| V01 | 同一输入框拖动、复位、对话/画布切换 | 已有 | 已沿用原方案并实测 |
| V02 | STEP 模型预览 | 部分 | 云端转网格后可旋转缩放，未保留完整模型对象信息 |
| V03 | 从本机导入 STEP 并登记到项目 | 部分 | 可上传后手动打开；没有 desktop 的 STEP 导入登记流程 |
| V04 | 导出当前 STEP 副本 | 部分 | 可以下载文件，但没有绑定用户选定版本的 expectedSha 校验流程 |
| V05 | 装配树、选零件、隐藏、隔离、显示全部 | 缺失 | 原生把所有 parts 合成一个几何对象 |
| V06 | 引用指定零件让模型修改 | 缺失 | 丢弃零件身份和对应版本信息 |
| V07 | X/Y/Z 尺寸测量、截面面积、引用检查 | 缺失 | 只有旋转缩放 |
| V08 | 参数字段、滑块、单位、范围 | 缺失 | 没有参数清单或界面 |
| V09 | 参数预览、应用、恢复、失败后修复入口 | 缺失 | 没有对应云端调用 |
| V10 | 当前结果、历史版本及分类筛选 | 缺失 | 普通文件列表不包含版本目录和结果身份 |
| V11 | 两个版本并排比较、参数差异、视图复位 | 缺失 | 只能看一个网格 |
| V12 | 概念图列表、缩放、局部框选、备注、过期标记 | 缺失 | 图片只会下载，没有概念画板 |
| V13 | 选定概念图/区域继续设计 | 缺失 | 没有图片与区域引用 |
| V14 | 工具生成图片与结果预览、引用 | 缺失 | 没有图片结果面板 |
| V15 | 新模型自动展示与“新结果”提醒 | 缺失 | 生成结束仅刷新文件列表，需要手动打开 |
| V16 | 工程检查、问题、版本及审查状态摘要 | 缺失 | 状态栏只显示模型、连接和“就绪” |

证据：[工程查看器](../desktop/src/renderer/src/components/EngineeringViewer.tsx)、[CAD 查看器](../desktop/src/renderer/src/components/CadViewer.tsx)、[参数面板](../desktop/src/renderer/src/components/ParameterPanel.tsx)、[概念画板](../desktop/src/renderer/src/components/ConceptBoard.tsx)、[原生网格显示](Sources/Reify/ModelPreview.swift)、[原生文件操作](Sources/Reify/AppModel.swift)。

## 工作流、审查与发布

| 编号 | desktop 功能 | 原生 | 缺口 |
|---|---|---|---|
| W01 | 工作流库、选择版本 | 缺失 | 整个工作流页面不存在 |
| W02 | 新建、编辑、校验、保存、删除工作流 | 缺失 | 没有对应界面与调用 |
| W03 | 阶段、允许动作、必需记录和证据 | 缺失 | 没有阶段图和详情 |
| W04 | 当前工作流阶段及固定版本展示 | 缺失 | 没有工作台阶段条 |
| R01 | 提交当前候选给独立机器审查 | 缺失 | 可以手写聊天要求，但没有绑定候选版本的操作 |
| R02 | 版本验收项、检查方法与证据查看 | 缺失 | 没有验收摘要和证据面板 |
| R03 | 人工批准、范围、理由、撤销 | 缺失 | 通用确认弹窗不等于工程版本批准 |
| R04 | 发布正式文件包并下载 | 缺失 | 单文件下载不等于正式发布包 |
| R05 | 管理员允许的 Git 标签发布 | 缺失 | desktop 需开启并允许相应远程库；原生没有入口 |
| R06 | 由历史源码重建候选、比较几何和字节 | 缺失 | 没有重建入口和结果 |

证据：[工作流编辑器](../desktop/src/renderer/src/pages/WorkflowEditor.tsx)、[阶段条](../desktop/src/renderer/src/components/WorkflowRail.tsx)、[工程查看器](../desktop/src/renderer/src/components/EngineeringViewer.tsx)、[desktop 云端发布实现](../desktop/electron/main/index.ts)、[查看器后端](../desktop/electron/main/viewer.ts)。这些调用使用 cloud/local 共用桥接，不要求把 CAD 计算搬到 Mac。

## 记录、评分与经验整理

| 编号 | desktop 功能 | 原生 | 缺口 |
|---|---|---|---|
| T01 | 记录列表、搜索、读取处理后的对话与工具结果 | 缺失 | 整个记录页面不存在 |
| T02 | 记录的模型、日期、用量、评分、工具次数 | 缺失 | 没有对应数据展示 |
| T03 | 当前对话评分；多选记录评分、难度和反馈 | 缺失 | 没有评分 |
| T04 | 整理经验、进度、候选规则、修改内容 | 缺失 | 没有对应调用和结果界面 |
| T05 | 候选规则重放验证 | 缺失 | 没有验证入口 |

证据：[记录页面](../desktop/src/renderer/src/pages/Traces.tsx)、[记录后端](../desktop/electron/main/traces.ts)。云端明确禁用的是“采纳经验”，不是整个记录、评分和整理功能。

## 弹窗、文件与交付

| 编号 | desktop 功能 | 原生 | 缺口 |
| D01 | 确认、选择、输入、取消 | 部分 | 基础界面存在；确认回答字段与 desktop 不一致，输入不使用 placeholder/prefill |
| D02 | 多行 editor 请求 | 缺失 | 被事件处理直接忽略，无法回答，可能阻塞任务 |
| D03 | 临时通知、状态提示 | 部分 | 只接 notify，忽略 setStatus；通知与工具活动共用字段 |
| F01 | 云端文件上传下载及校验 | 已有 | 原生另有通用文件列表；真实传输已实测 |
| F02 | 从结果定位文件/打开所在文件夹 | 缺失 | 只能下载，没有 desktop 的结果引用与定位流程 |
| B01 | Fusion 安装/更新插件、检测、测试导出、导出当前模型 | 缺失 | Mac 支持 Fusion；不是 Windows 专属功能，原生未包含插件或调用 |
| B02 | 原生 SwiftUI 构建、DMG | 已有 | Apple Silicon、当前系统已实测；只有临时签名 |
| B03 | 持续构建与 E2E 检查 | 缺失 | 现有 macOS 工作流构建的是 Electron；没有 apps/macos 的持续检查 |

证据：[desktop 弹窗](../desktop/src/renderer/src/components/ExtensionDialog.tsx)、[原生弹窗](Sources/Reify/Views.swift)、[原生桥接](Sources/ReifyCloud/WorkspaceBridge.swift)、[Fusion 设置](../desktop/src/renderer/src/components/CadExportsCard.tsx)、[平台检测](../desktop/electron/main/cad-transfer-detect.ts)、[desktop 持续检查](../../.github/workflows/desktop.yml)、[原生 E2E](E2E.md)。

## 不计入云端功能缺口的项目

- 本地项目文件夹、WSL 安装、Windows 重启、本地 CAD 运行环境：纯云端客户端不需要照搬本机计算配置。
- Blender、ParaView：现有 desktop 云端后端明确拒绝这些操作，查看器也隐藏这两类来源。属于现有云端限制，不能说成只有原生漏做。
- 结构分析：desktop 有参数和确认界面；云端组件状态目前返回“阶段 1 不可用”，安装返回服务器管理状态。界面存在不等于完整云端求解与结果验收已通过。这是初版入口缺失记录；原生随后补齐入口与组件检查，最新状态见全面复核，真实云端求解仍待验。
- 采纳经验规则：desktop 云端明确禁用，原生无需开放绕过。
- SolidWorks：现有实现仅支持 Windows；Mac 不应承诺支持。Fusion 则支持 Mac，仍是明确缺口。
- desktop 状态栏的 Tokens 数字目前也是占位符，不能算原生漏掉了已有准确用量显示；记录页面的用量数据是另一回事。

证据：[云端限制](../desktop/electron/main/cloud-mode.ts)、[远程组件状态](../desktop/electron/main/remote-bridge.ts)、[记录采纳限制](../desktop/electron/main/traces.ts)、[CAD 平台检测](../desktop/electron/main/cad-transfer-detect.ts)、[状态栏](../desktop/src/renderer/src/components/StatusBar.tsx)。

## 已确认的问题与待验证风险

1. **设置只保存本机模型偏好。** `CloudModels.swift` 调用现有配置脚本时只用 catalog；保存默认、收藏、密钥和自定义服务商的已有云端能力完全没接。
2. **设置“关闭”没有放弃修改。** 字段直接绑定 AppModel；不按保存，值也已经影响后续打开项目。需改为草稿，成功后提交。
3. **模型显示可能与实际会话不同。** 接回助手后只从 get_state 取 isStreaming，没有读取实际模型和思考档位。这是源码确认的同步缺口，尚未用真实窗口验证错误场景。
4. **确认回答格式不一致。** desktop 发 `{value: true/false}`；原生发 `{confirmed: true/false}`。桥接不会转换。当前测试服务收到 extension_ui_response 后直接忽略，无法证明正式助手接受了回答；需真实协议 E2E。
5. **多行请求无人回答。** editor 是 desktop 支持的请求；原生没有显示或回答路径，可能阻塞等待输入的任务。input 的预填和占位文字也丢失。
6. **模型对象信息被丢掉。** 原生解码 parts 时仅保留 positions/indices，合成单个对象；装配、身份引用和工程检查不能靠加几个按钮完成。
7. **基础 E2E 无法发现整页缺失。** 现有用例主要检查登录、文本、简单几何、文件、重连和退出；没有从 desktop 功能表生成验收范围。脚本跑完，只能证明这些用例通过。

## 补齐顺序与 E2E 验收

1. **先补设置和协议问题。** 沿用 desktop 分区与文案关系，连接已有云端配置脚本和账户 API。覆盖密钥/登录、状态、默认、收藏、自定义配置、独立审查模型、动态思考档位、保存失败与关闭撤销；补 confirm/select/input/editor 的真实回答。密码和凭据用独立测试账户，不修改当前用户账户。
2. **再补日常工作台。** 历史列表、搜索和指定会话切换；图片、排队、编辑、只读选择；工具结果和阶段状态。E2E 至少覆盖两条会话之间的草稿、模型、历史与工作流隔离，以及运行中追加、取消、停止后修改。
3. **补完整工程画布。** 复用云端结果目录和网格对象数据，保留零件身份；补参数、装配、测量、剖面、版本比较、概念图与结果引用。E2E 用真实装配与参数模型，检查修改成功、修改失败保留原模型、指定零件与版本不串。
4. **补工作流、记录和发布。** 编辑校验、选择版本、阶段状态、评分、整理、重放验证、证据、人工批准、正式包下载及 Fusion。E2E 验证候选/版本对应关系，批准撤销后不能再发布；正式包内容与记录一致。
5. **最后做完整云端验收和持续检查。** 每项明确已有、缺失或受现有云端限制；不能用隐藏入口、聊天提示词或一个简单长方体代替原功能。给 SwiftUI 增加 macOS 构建与 E2E 检查，再重做 DMG 验收。

本轮为功能审计与实际设置窗口核查，没有补齐上述功能，也没有重跑或宣称新的完整 E2E 通过。PR #70 的基础流程测试仍有效，但当前不能按完整原生客户端验收。
