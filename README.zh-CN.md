# Pi-CAD

**从一个想法，到有证据支撑的机械设计——让 Agent 不仅会画，还知道什么时候才算真正完成。**

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

## 1. 设计是一段过程，而不是一句 Prompt

生成 CAD 很容易做出惊艳的演示，却很难让人放心。模型可能画出漂亮的几何，同时
悄悄忘记一个尺寸；也可能检查了旧版本，或者根本没有验证 Artifact 就宣布成功。

Pi-CAD 围绕四个思想构建。

### Agent 可以自由思考，但不能自由改写工程事实

Prime 负责推理、模型、Session、工具和普通 RLM fan-out。Pi-CAD 负责工程权威：
此刻允许做什么、哪个 Artifact 是当前版本、哪些证据仍然有效，以及发布门槛是否
真的满足。

Agent 可以在当前阶段广泛探索；任何会改变设计的 Effect，都必须经过同一套状态机
和固定不变的 Workflow Snapshot。

### 文件只是输出，可追溯性才让它成为工程 Artifact

STEP、渲染图、JSON 报告，甚至被手工修改的状态文件，都不会因为存在于磁盘上就
获得权威。Pi-CAD 将被接受的 Artifact 绑定到确定性源码、Build Identity、
Workflow State 和 Evidence。模型一旦重建，依赖旧几何的观察与审查会自动失效。

### 看见是必要条件，测量才是判断依据

每次受控 Build 都返回可视化证据，而不只是一个文件路径。Prime 随后可以针对同一个
Artifact 执行有边界、可编程的 B-Rep Probe：尺寸、Solid 数量、拓扑、间隙，或任务
特有的几何断言。概念图可以帮助空间探索，但永远不能伪装成几何证明。

### 作者不能给自己的最终答案打分

最终审查由一个全新、隔离的 Prime Agent 执行。它只看到 Immutable Candidate，
只拥有 Probe 权限，不能修改设计，也不会继承作者的对话。没有证据的 PASS、崩溃、
超时、空回复或过期审查都会 Fail Closed。在 Headless 模式下，“完成”是 Runtime
执行的退出条件，而不是模型生成的一句话。

这也是 Pi-CAD 选择 Prime 的原因：持久 IPython 能让真实 Python 对象贯穿一段长程
设计；持久 Session 和事件触发的新轮次支持自主工作；RLM fan-out 可以帮助完成装配
体，同时无需再造第二套 Agent Runtime。Prime 提供智能，Pi-CAD 让智能产生的工程
Effect 可检查、可追溯、可问责。

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
