# Pi-CAD 与 text-to-cad 现状对照

## 基线

- Pi-CAD：`/home/jingyi/pi-cad-desktop` 当前工作树，分支 `codex/desktop-app`，HEAD `0a458d350c14d01f9dda2ac713e76f0e4ad43a37`。工作树有大量未提交产品改动，本文按当前文件评估。
- text-to-cad：`earthtojake/text-to-cad@0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6`。
- 运行版本并不统一：全局 `prime-cad` 固定指向 `/home/jingyi/pi-cad` 的 `master@28d2194`；桌面优先使用自己安装到 `~/.local/share/pi-cad-desktop/runtime` 的运行时。比较结论不能自动代表这两份已安装版本。

## 总结

两者不在同一层。

- Pi-CAD 是工程任务运行时：Prime、常驻 Python、可编译工作流、权威状态、产物身份、独立评审、仿真、桌面界面和轨迹学习。
- text-to-cad 是便携 CAD 技能和工具箱：建模手册、STEP 生成、局部选择、几何检查、截图、导出、制造检查。

因此，不应把 text-to-cad 的十步说明改造成第二套 Pi-CAD 工作流，也不应照着它扩张 Python 接口。应把它更成熟的 CAD 知识做成按需加载的 skill，把可复用检查做成通用 Probe 后面的 preset，把与任务语义无关的几何有效性并入构建底线。

本轮已落地这些差距：输入闭包缓存和并发输出锁、稳定的面与装配引用、逐实体有效性与自交检查、视觉 Probe 的对向视角/边线/聚焦/隐藏/爆炸图，以及按需加载的 build123d、机构、装配和制造资料。公开 Python 入口没有增加。

## Pi-CAD 的设计边界

Pi-CAD 的差异不是遗漏，而是刻意分层：

- **Workflow**：只表达当前阶段、允许做什么、应交什么、如何转移。它是可执行的过程记忆，不是领域百科。
- **Phase Card**：只投影当前最小状态、义务、权限和出口；每轮临时注入，不积累完整知识。
- **Skill**：回答“具体怎么做”。工程知识和 build123d/OCC 经验按任务渐进读取。
- **Python 工作台**：保存自由形式的任务理解、参数、检查逻辑和中间结果。
- **Commit / ArtifactRef**：冻结和证明身份、版本、来源与交接，不解释对象的工程语义。
- **Capability**：提供少量可组合的受控能力。任务特定判断由 Agent 编程完成。
- **Preset**：通用能力的可发现配置或实现，不应扩张成一组同名专用方法。

这解释了两边许多看似“不一致”的地方：text-to-cad 面向普通 Agent，只能把流程、知识和许多细操作装进 skill/CLI；Pi-CAD 依靠 Prime 的持久 Python 和自己的权威工作流，故意把这些层拆开。

## Pi-CAD 已经更好的部分

### 1. 上下文和工作记忆

Pi-CAD 通过 Prime 保存 Python 变量、会话和子 Agent。每次模型调用只追加当前阶段卡，并先移除旧卡；阶段卡来自真实工作流状态，包含阶段、义务、可用操作和合法跳转。[extension.ts](../../src/integrations/prime/extension.ts#L166-L214) [card.ts](../../src/harness/card.ts#L182-L242)

text-to-cad 主要依靠 CAD skill 和按需资料。它的渐进读取做得好，但没有与真实运行状态绑定的动态上下文。[CAD skill](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/SKILL.md#L78-L120)

结论：Pi-CAD 的上下文结构更先进。问题不是缺阶段卡，而是阶段卡和主 CAD skill 仍装了过多 API 补救说明。

### 2. 工作流、权限和完成条件

Pi-CAD 的 YAML 会被编译。编译器检查操作、权限、写入范围、义务关闭方式、评审、跳转、不可达阶段和终态，并固定哈希。[compiler.ts](../../src/harness/workflow/compiler.ts#L33-L178) 所有 Agent 写操作先经过同一个授权入口。[handlers.ts](../../src/agent-api/handlers.ts#L21-L33) [permissions.ts](../../src/harness/permissions.ts#L1-L105)

text-to-cad 的十步流程清楚，但仍是提示词。Agent 可以忽略，也没有独立的完成门。[CAD skill](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/SKILL.md#L78-L91)

结论：Pi-CAD 的工作流设计明显更强。text-to-cad 只能补阶段内 SOP，不能替换状态机。

通用工作流记录不校验 `variables` 的领域内容，这是既定边界，不是缺陷。`cad.commit()` 负责确定性序列化、哈希、父提交、阶段和产物身份；它不应理解 `spec`、零件或接口的具体数据结构。[workflow types](../../src/harness/workflow/types.ts#L3-L14) [commit.ts](../../src/harness/commit.ts#L84-L128)

结论：不能把 text-to-cad 的 CAD brief 升格成 Core 中的固定 `spec` schema。它应成为按需 skill/template，供 Agent 组织自由 Python 状态；内容质量继续由 Agent 和独立 reviewer 判断。

### 3. 产物、证据和失效

Pi-CAD 的 commit 绑定工作流哈希、父提交、变量和产物哈希；构建、截图和几何结果绑定候选版本。新构建会使旧证据失效。工作区内的状态 JSON 只是投影，不能伪造权威状态。[commit.ts](../../src/harness/commit.ts#L13-L106) [storage.ts](../../src/authority/storage.ts#L64-L123)

text-to-cad 有内容寻址渲染包和生成缓存，但主要解决文件生成与查看，不是整个工程任务的权威状态。[package_freshness.py](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad-viewer/scripts/viewer/packages/cadgen/src/cadgen/_internal/package_freshness.py#L1-L96)

结论：Pi-CAD 的工程追踪范围更完整。

### 4. 独立评审

Pi-CAD 把作者和 reviewer 放在不同 socket、不同权限和隔离目录中；review 绑定工作流、合同和不可变候选。作者不能提交 reviewer 结论。[sidecar.ts](../../src/authority/sidecar.ts#L30-L79) [review.py](../../skills/cad/src/cad/review.py#L35-L62)

text-to-cad 的视觉和几何检查由同一个 Agent 完成，没有独立权威边界。

结论：这里不要吸收 text-to-cad 的设计。Pi-CAD 的问题只是 reviewer 能否方便拿到足够检查能力。

### 5. 产品范围

Pi-CAD 已有工作台、项目与会话、工作流编辑、CAD/仿真查看、模型选择、OAuth、轨迹评分和蒸馏。text-to-cad 是跨 Agent 安装的技能库，没有同级产品层。[Pi-CAD README](../../README.md#L10-L39) [text-to-cad README](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/README.md#L35-L82)

结论：Pi-CAD 更完整；text-to-cad 更轻、更便携。

## text-to-cad 已经更好的部分

### 1. CAD 实战知识密度

Pi-CAD 的机械设计、装配、参数化建模和制造资料方向正确，但目前只有 107 行参考资料，主要是原则。text-to-cad 的 CAD 与 DfAM 参考资料约 1926 行，覆盖：

- build123d/OCC 放样、布尔、圆角、倒角、旋转面和定位故障；
- 零件坐标、装配基准、关节和导入件定位；
- 选择符、测量、对齐、坐标系、差异检查；
- 截图包、剖视、透明、隐藏线、局部聚焦；
- 常见失败的最小修复方式。

证据：[build123d modeling](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/build123d-modeling.md) [positioning](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/positioning.md) [repair loop](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/repair-loop.md)

结论：Pi-CAD 的上层工程思想更强；text-to-cad 的 CAD 内核经验更具体。这里最值得吸收。

### 2. 几何有效性检查

text-to-cad 把拓扑、自由边、逐实体带符号容积和自相交拆成独立检查，并明确总容积会掩盖正负实体互相抵消。[validity.py](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/scripts/packages/cadgen/src/cadgen/validity.py#L1-L229)

Pi-CAD 现已吸收这层无语义底线：几何结果同时报告拓扑、闭壳、正体积、逐实体原因和自交状态；受管构建不会把已确认无效的 B-Rep 记为工作流证据。[geometry.py](../../python/cadctl/geometry.py)

### 3. Preset 的可发现性

Pi-CAD 的 `visual / geometry / surfaces / measure / section / sections_scan / compare / assembly / interference` 预设现已统一进入 `cad.probe.run(subject=..., preset=..., args=...)`。[probe presets](../../src/modules/probe/presets/index.ts) 视觉不再需要第二个公开 Python 方法。

text-to-cad 直接暴露 `refs / validate / measure / align / frame / diff`，可发现性较好，但照搬会让 Pi-CAD 回到不断增加方法的浅接口。[inspection and validation](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/inspection-and-validation.md#L130-L242)

结论：不增加 `cad.probe.measure()`、`align()`、`section()` 等方法。注册 preset 可继续扩展，但不改变公开接口。

### 4. 局部引用与装配检查

旧的 `#p0/#c0/#f0/#e0/#s0` 仍适合一次性探查，但依赖遍历顺序。[geometry.py](../../python/cadctl/geometry.py) 现在 `surfaces` preset 会返回绑定产物哈希的 `surf-*`，可直接交给通用测量；装配树返回 `occ-*`、唯一别名和歧义列表。模型变化后旧引用拒绝使用，避免静默量错对象。

结论：`ArtifactRef` 继续解决文件版本，局部引用由 Probe 产生，不为每种实体增加公开方法。

### 5. CAD 进程性能

Pi-CAD 原先每个 build、inspect、render、measure 都重新执行 `uv run ... python -m cadctl`，只有限流，没有复用 OCP/build123d。

text-to-cad 有可选热进程：一次加载 OCP/build123d，串行执行 CAD 请求；任务后清理项目模块，客户端断开时停止孤儿任务。[daemon server](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/scripts/cadgen_daemon/server.py#L1-L27)

它还有同一模型的系统文件锁，以及 `built/current/skipped-peer/contended` 状态，防止重复构建互踩。[CAD skill](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/SKILL.md#L61-L74)

结论：现已用预热父进程和短命 fork 子进程复用导入成本，同时保持任务隔离；构建再按源码闭包、参数和运行版本缓存，并以输出锁防止并发互踩。[capability.ts](../../src/shared/capability.ts) [worker.py](../../python/cadctl/worker.py) [build_cache.py](../../python/cadctl/build_cache.py)

### 6. 截图诊断深度

Pi-CAD 已强制生成并返回带视角名和坐标提示的七视图；这比“Agent 自己决定看不看”可靠。[handlers.ts](../../src/agent-api/handlers.ts#L104-L174) text-to-cad 的优势不是是否截图，而是可按问题增加对向等轴图、剖视、透明、隐藏线、聚焦和隐藏零件，并要求把视觉疑点转成数值检查。[snapshot review](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/snapshot-review.md#L20-L83)

结论：保留构建后的强制七视图。视觉 preset 现支持对向等轴图、实体边、隐藏线、线框、零件聚焦/隐藏和爆炸图；剖视继续使用同一 Probe 的 section preset。作者和 reviewer 共用入口。

## 本轮实现结果

1. **知识留在 skill。** Workflow 和 Phase Card 未增加 CAD 百科；build123d、修复、机构、装配配合和制造检查写进独立资料，按需读取。
2. **一个 Probe。** visual、geometry、surfaces、measure、section、compare、assembly、interference 继续共用一个公开入口。
3. **只做无语义底线。** 自动检查只报告 B-Rep 事实，不解释设计需求。
4. **复用进程并缓存。** 热 worker、源码闭包哈希、参数哈希、运行版本、原子写入和输出锁共同避免重复工作与脏产物。
5. **视觉诊断更深。** 七视图仍默认强制返回，疑点再用局部视图、边线、隐藏和爆炸图检查。
6. **局部引用可交接。** 面和装配引用绑定不可变产物；改模后必须重新探查。

## 不应吸收

- 不把 shell/CLI 重新设为 Prime 的主要调用方式。
- 不把 skill 中的十步说明复制成第二套工作流。
- 不给通用 Commit 增加 `spec`、BOM 或接口内容 schema。
- 不让 build/probe 解释用户需求或判断设计语义。
- 不为 measure、align、section、render 等 preset 各建一个公开方法。
- 不用同一 Agent 的自检替代独立 reviewer。
- 不把通用壁厚、孔径、圆角或打印公差当用户需求或工程结论。
- 不整体搬 viewer、cadgen 或机器人技能；只抽取现有产品缺少的能力。

## 最终判断

Pi-CAD 继续用少量深接口解决“当前能做什么、结果属于哪个版本、如何交接、谁来审查”，同时把任务语义留给 Agent。text-to-cad 最成熟的知识、检查、局部引用、视觉诊断和执行优化已按这一边界吸收，没有搬入第二套工作流或扩张公开 API。
