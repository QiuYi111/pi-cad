# Reify for macOS

SwiftUI 云端客户端，macOS 14+。不在本地安装建模或模型运行环境。

仍未补齐 desktop。完整对比见 [初版记录](DESKTOP-PARITY.zh-CN.md)，后续改动见 [87 项进度](PARITY-PROGRESS.zh-CN.md)。新增设置、历史、队列、工作流、装配和工程参数代码已通过本地流程测试；窗口与正式云端验收待完成。记录、版本比较、概念画板、批准/发布和 Fusion 等仍缺失。

- 沿用 desktop 的标志、字标、应用图标、Geist 字体和暖白深绿配色。
- 大画布常驻；对话展开；同一个悬浮输入框，点击细线切换、拖动移动、双击复位。Cmd + \\ 切换，草稿和模型视角不丢失。
- 项目侧栏、流式聊天、新对话、停止生成、操作确认。
- 工作区启动、暂停、闲置提醒；断线或应用意外退出后重新接入原来的助手，避免重复进程和消息。正常退出会等待助手退出确认。
- 原生 SceneKit STEP / STL 预览（STEP 在云端转成网格）；其他文件保存到本地。
- 上传、下载，大小与 SHA-256 校验；上传不覆盖列表中已有的文件。每次传输最多 64 MB。
- 登录与续期存在钥匙串，不保存密码。只允许 HTTPS；本地测试可用 HTTP。
- 设置使用既有云端脚本：完整模型目录、思考档位、密钥、服务商登录、默认模型、收藏、自定义配置、独立审查模型。模型与权限先在草稿修改，保存后生效。
- 历史对话搜索与切换、各自草稿、图片输入、排队需求和笔记；工程结果按当前对话读取。
- 工作流库、源码编辑与原校验器；工程结果版本、装配对象、隐藏与引用保留对应文件身份。
- 尺寸和截面检查绑定文件版本；参数字段、预览、应用、恢复、失败保留原预览及修复入口。
- 工具卡片、图片、指标及详情；工具结果能从历史恢复。重试、思考、工具、失败分别显示，并区分阶段时间和总时间。
- Markdown 表格、代码、列表、链接；阅读历史暂停跟随，可手动回到最新消息。新增窗口行为待验。

## 构建

需安装 Apple Command Line Tools，Swift 5.10+、Node 22.13+。无第三方 Swift 依赖。

先运行 `npm ci --prefix apps/macos` 安装构建依赖。消息、工具卡片和任务状态复用 desktop 源码，Markdown 使用同一解析规则；构建时打包到应用，本机运行不需要 Node。

```sh
npm run macos:build
open apps/macos/dist/Reify.app
```

构建脚本用 `swiftc`，同时生成图标、应用、ZIP、DMG 和 E2E 程序。优先使用已安装的 macOS 26 SDK；可用 `REIFY_MACOS_SDK` 指定 SDK。也提供 `Package.swift`，支持 Xcode / Swift Package Manager 打开源码。

安装：打开 `dist/Reify-macOS-arm64.dmg`，把 Reify 拖入 Applications。已有应用可单独运行 `bash apps/macos/scripts/package-dmg.sh` 打包。

应用使用本机临时签名，未做发布签名或公证。计算仍在云端。

## E2E

```sh
npm ci --ignore-scripts
npm ci --prefix apps/macos
npm run macos:test:e2e
```

该命令启动独立本地 HTTP/WebSocket 服务，运行实际 Swift 网络、钥匙串和 AppModel 对话代码；工作流直接调用 desktop 校验器。测试数据与偏好独立，结束时关闭服务。无需正式账户。结果在 `test-results/`。窗口测试是另一步。

真实窗口测试用 Codex 的 `cua_repl` 跑 `tests/ui-e2e.cua.js`，通过系统辅助功能操作 SwiftUI。先运行 `npm --prefix apps/macos run fixture`，再在 `cua_repl` 用 `await import('file:///绝对路径/tests/ui-e2e.cua.js')` 载入并调用导出的 `runReifyUIE2E(cua, {appPath, baseURL})`。使用绝对应用路径，测试服务器地址为 `http://127.0.0.1:18765`。应用需处于退出登录状态。脚本不会修改正式账户。

断线与闲置场景由测试服务的 `/__test/drop`、`/__test/idle` 触发，再通过真实窗口点重连或继续使用。上传与保存通过系统文件窗口验证。见 [测试记录](E2E.md)。

本地测试服务模拟云端账户、工作区和助手。另已用正式账户和 GLM 实测建模、STEP/STL 原生预览、上传下载、几何检查、正常重启恢复和意外退出接回；结果见 [测试记录](E2E.md)。

正式云端窗口测试先在应用登录，再在 `cua_repl` 载入 `tests/real-cloud-e2e.cua.js`，调用 `realCloudE2E(cua, {appPath: 'app.reify.mac'})`。创建独立测试项目，选择云端可用模型，再执行生成、文件列表、预览和系统保存流程。下载后运行 `node tests/check-cloud-files.mjs <STEP路径> <STL路径>`，检查实际文件。此流程会在正式账户创建测试项目并调用模型。

## 目录

`ReifyCloud`：HTTP、续期、钥匙串、WebSocket、聊天与文件协议。

`Reify`：SwiftUI 界面、系统文件窗口、STL 预览。

`ReifyE2E`、`tests/`：E2E 程序、测试服务与真实窗口脚本。
