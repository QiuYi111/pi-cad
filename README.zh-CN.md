# Pi-CAD

**让模型搜索设计空间，让运行时守住工程事实。**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml/badge.svg)](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Pi-CAD 将 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)
变成一个自主机械设计 Agent。你给出产品需求，它可以澄清约束、探索概念、编写
确定性 CAD、渲染并检查结果、迭代修改、发起独立审查，最后发布被接受的源码和
STEP Artifact。

它与普通“文本生成 CAD”的区别很简单：一个看似合理的回答，甚至一个已经存在的
STEP 文件，都不等于完成。只有当需求、源码、几何、证据和审查结论仍然彼此一致，
设计才真正完成。

## 1. 设计哲学：自由搜索，受控推进

Agent 是一个逆解器。LLM 在语义空间里搜索——提出假设、编写代码、选择实验；它的
行动则在事物空间里推进真实项目，让 Artifact 逐步逼近可接受的解集。

Harness 位于两者的边界，职责只有两个：构建模型每轮看到的内容，以及解释模型返回
的行动。因此，更高效的专用 Agent，并不是把更多说明和更多 Tool Schema 塞进一个
越来越大的 Prompt，而是为上下文、行动与工程状态选择更合适的表达方式。

### 让语义搜索保持自由，只约束对现实的修改

Skill 可以传授最佳实践，但本质上只能劝诫。生产级 Workflow 还必须让义务和权限
真正可执行。Pi-CAD 的 Workflow 规定当前必须提交什么、允许产生哪些 Effect，以及
哪些出口合法。它约束的是项目如何向前推进，而不是模型私下如何推理，也不是模型在
当前问题里可以如何组合代码。

每次模型调用前，Pi-CAD 都会从当前状态生成一张短小、临时的 Phase Card：现在位于
哪里、还有什么必须完成、此刻可以做什么、下一步有哪些合法选择。Phase 变化时卡片
随之变化，不会把整套状态机永久混进上下文。Workflow Package 本身是普通、可发现的
文档，因此可以像 Skill 一样被选择、阅读、版本化和持续改进。

### 把上下文当作受管理的工作记忆

Generic Agent 往往把任务、领域知识、工具手册、参考文件和不断变化的状态压平到同一
段消息历史里。但这些信息拥有不同的生命周期，不应该争夺同一份注意力。

Prime 为 Agent 提供一个持久 IPython 工作台。Requirement、Spec、Artifact Handle、
Probe 结果和中间计算，都可以作为有类型的 Python 值跨轮次存在。大型文件和 Solver
原始输出留在 Prompt 之外，需要时再被召回或变换；Pi-CAD 只注入当前的操作边界与
最有价值的观察结果。

这不是另一个档案库，而是真正的工作记忆：Agent 可以直接用它计算，在有边界的子
Agent 之间传递，并把同一个值交给多个工具，而不必反复寻找路径、重新解释文件和
重建状态。

### 让工具在正确的抽象层上可编程

Bash 和原生 CAD Library 很有价值，因为它们可以自由组合；但它们本身并不是高效的
Agent Interface。机械工程 API 分散在不同 Library、文件格式、Solver 版本和 Backend
惯例中。如果让模型在每个任务里重新学习这些表面，不仅浪费上下文，也会产生不一致
的观察结果。

Pi-CAD 在这些 Backend 之上提供稳定的 Python Operation。Prime 仍然负责写代码，
也仍然可以在 IPython 中自由组合操作；但这些 Operation 会统一输入、Identity、失败
语义和返回值。一次 Build 会直接返回 Agent 必须看到的视图；一次 Simulation 可以把
巨大的数字流转换成有边界的图和 Typed Facts。因此，Managed Tooling 的主要价值并
不是隐藏 Library，而是控制一个 Effect 发生后，究竟什么信息进入上下文。

### 传递 Artifact Value，而不只是文件位置

文件路径只说明一串 Bytes 在哪里。它没有说明这些 Bytes 是什么、来自哪个 Build、
是否仍是当前版本，也没有说明哪些 Evidence 和 Review 正在引用它。`ArtifactRef`
在解析到真实 Project-local 文件的同时，还携带 Identity、Type、Provenance 和
Revision Semantics。

这在长程任务与多 Agent 协作中尤其重要。同一个 Artifact 可以从建模流向网格、
Probe、Simulation 和 Review，而每个参与者都不必从文件名重新猜测它的意义。一旦
设计被 Rebuild，旧 Handle、Observation 和 Verdict 会作为同一条依赖链一起失效。

### 用作者之外的证据闭合回路

空间任务必须看见，工程判断必须测量，而最终评分不应该交给作者自己。Managed Build
强制返回视觉反馈，受限 B-Rep Probe 检查精确 Artifact，Fresh Prime Reviewer 则在
隔离环境里以 Probe-only 权限审查 Immutable Candidate。崩溃、超时、空回复、没有
Evidence 的 PASS 或过期 Review 都会 Fail Closed。

归根结底：Prime 拥有搜索过程与工作记忆；Pi-CAD 拥有合法 Effect、Managed
Observation、Artifact Truth 与完成条件。创造力有价值的地方让模型自由，工程事实
必须延续的地方让运行时严格。

## 2. Killer Demos

### A. 一段需求 → 通过测试的零件 → 正式发布

你可以这样说：

> 设计一块 100 × 80 × 5 mm 的安装板，四角开孔。孔边距至少 8 mm，边缘增加适合
> 打印的圆角，并发布 STEP 文件。

Pi-CAD 会引导 Prime 依次完成需求、概念、确定性 build123d 源码、渲染视图、几何
Probe、独立审查和发布。Agent 不需要读实现源码或临时猜 API；当前 Phase Card 会
准确告诉它还有哪些义务、现在允许做什么，以及哪些状态转换合法。

这个 Demo 展示了：

- 可复现的源码模型与 STEP Artifact，而不是困在聊天记录里的几何；
- Build 强制返回图片，而不是等 Agent 想起来才截图；
- 对真实 B-Rep 做测量，而不是从代码文字猜测结果；
- 每次 Rebuild 后自动使旧证据失效；
- 只有经过独立审查的 Release 才能通过机器执行的完成门槛。

当前针对 CADTestBench `00001817` 的验收结果为 CAD Tests 17/17、Rubric Score
9/9，并且同一 Candidate 只有一个 Reviewer，Workflow 最终到达 Terminal State。

### B. 产品想法 → 视觉概念 → 真实装配体

你可以这样说：

> 设计一个桌面可折叠手机支架。探索紧凑、现代的造型，同时支持横屏和竖屏，并让
> 转轴与限位结构适合打印。

在 Concept 阶段，Prime 可以通过现有 Codex OAuth 生成参考图，把它作为空间假设。
之后，它必须将概念落实为明确的接口、Architecture/BOM、独立零件和装配 Candidate。
Concept Commit 之前不能开始 Detailed CAD；真正的装配体也不能跳过接口和零件义务。

这个 Demo 展示了：

- 图片用于探索，但不会冒充 Geometry Authority；
- 简单零件和真实装配体会走不同的合法路径；
- 普通 Prime RLM fan-out 可以承担有边界的零件研究或编写工作；
- 即使多个 Agent 参与，最终仍只有一个 Canonical Assembly Candidate；
- Fresh Reviewer 审查的是不可变的真实装配 Artifact。

### C. 既有设计 → 受控修改或工程结论

你可以这样说：

> 把这个支架的安装孔从 4.2 mm 增大到 5.0 mm，但不要改变外部包络。验证结果并
> 发布一个新 Revision。

或者：

> 检查这个 STEP 模型，报告精确 Bounding Box、Solid 数量和最小壁厚风险区域，
> 不要修改它。

使用 `mechanical.modify` 完成可追溯的 Revision，使用 `mechanical.analysis` 完成
有边界的只读调查。Prime 可以 Probe 任意 Project-local `ArtifactRef`，不需要捕获
Decorator 源码，也不需要临时适配 API。更复杂的确定性工作可以封装为严格 Recipe，
包括受控的 OpenFOAM、SU2 和 torch-fem 路径。

这个 Demo 展示了：

- 修改和分析是正式 Workflow，而不是特殊 Prompt；
- 旧 Evidence 不能悄悄为新 Revision 背书；
- 可编程检查始终绑定到它实际测量的 Artifact；
- 原始计算可以留在模型上下文之外，只有 Typed Observation 进入证据记录。

## 3. 用户引导

Pi-CAD 当前支持 Ubuntu 和 WSL2。你需要 Node.js 22.19+、由 `uv` 管理的 Python
3.11/3.12、Bubblewrap，以及已配置 Provider 的 Prime Agent。

### 安装

将 Prime Agent 和 Pi-CAD 放在同一级目录：

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap libglu1-mesa

mkdir -p ~/work && cd ~/work
git clone https://github.com/QiuYi111/prime-agent.git
git clone https://github.com/QiuYi111/pi-cad.git

cd prime-agent && npm ci
cd ../pi-cad
npm install
npm run setup:python
PRIME_AGENT_REPO=~/work/prime-agent npm run prime:setup
```

在 Setup 打开的 Prime Session 中执行一次 `/login`，然后安装 Launcher：

```bash
mkdir -p ~/.local/bin
ln -sfn "$PWD/scripts/prime-cad-launcher.sh" ~/.local/bin/prime-cad
```

确认 `~/.local/bin` 已加入 `PATH`。

### 完成第一个设计

在独立的设计 Project 或 Git Worktree 中启动：

```bash
mkdir -p ~/designs/mounting-plate
cd ~/designs/mounting-plate
PRIME_AGENT_REPO=~/work/prime-agent prime-cad
```

然后告诉 Prime：

```text
使用 mechanical.one-shot 设计并发布一块 100 × 80 × 5 mm 的安装板，
四角各有一个 5 mm 孔，孔边距至少 8 mm。
```

三个主要 Workflow 入口是：

| Workflow | 适用场景 |
| --- | --- |
| `mechanical.one-shot` | 新零件或装配体，从需求直到审查和发布 |
| `mechanical.modify` | 对既有设计做受控修改 |
| `mechanical.analysis` | 只读的几何或工程调查 |

外部概念图生成默认关闭。只有本次 Run 确实需要访问 Codex Images 服务时才启用：

```bash
PI_OFFLINE=0 PRIME_AGENT_REPO=~/work/prime-agent prime-cad
```

### Headless 运行

```bash
PRIME_AGENT_REPO=~/work/prime-agent \
prime-cad --provider openai-codex --model gpt-5.6-luna \
  --thinking medium --no-session --mode json --print \
  "Use mechanical.one-shot to design and release a 100 × 80 × 5 mm plate."
```

除非 Canonical State 同时包含 Terminal Workflow、精确的 Release Commit 和有效的
最终 PASS，否则命令会以退出码 `42` 和 `WORKFLOW_INCOMPLETE` 结束。

### 验证 Checkout

```bash
npm run check:agent-contract
npm run test:ts

PYTHONPATH="$PWD/skills/cad/src" PYTHONDONTWRITEBYTECODE=1 \
uv run --offline --frozen --project python --extra simulation \
  python -m unittest discover -s tests -p 'test_*.py'

npm run check:prime-imagegen
npm run test:prime-imagegen
node tests/prime-cli-smoke.mjs
```

## 当前范围

Pi-CAD 当前提供确定性 build123d Authoring、Visual-first Build、绑定 Artifact 的
B-Rep Probe、通过 Codex OAuth 的概念图生成、Immutable Workflow Packages、事件
驱动的独立审查、隔离的 Author/Reviewer 权限，以及 Recipe-native 工程计算。

Authority Runtime 当前只支持 Linux/WSL，并跟随 Prime 源码 Checkout。它不替代
物理测试、制造审查或专业工程签字。未支持的仿真假设必须被明确说明，不能静默近似。

Canonical State 位于 Project 之外的
`~/.local/share/pi-cad/<sha256(realpath(project))>/`；Project 内的
`.pi-cad/status.json` 只是供人阅读的状态投影。

## License

[MIT](LICENSE)。图片生成兼容包在
[`packages/prime-codex-image-gen`](packages/prime-codex-image-gen)
中保留了上游 Attribution 和 License。
