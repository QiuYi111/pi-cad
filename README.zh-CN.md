# Pi-CAD

**面向 Prime Agent、由证据约束的机械 CAD 运行时。**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml/badge.svg)](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Pi-CAD 把 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)
变成一个受工作流约束的机械工程 Agent。Prime 负责推理、编写确定性的
build123d 源码和组织工作；Pi-CAD 负责权威状态：现在允许做什么、哪份证据仍然
有效、独立审查是否可信，以及任务是否真的完成。

因此它不是“能导出 STEP 的大模型”。每个被接受的发布结果都可以追溯到固定的
工作流快照、确定性源码、哈希绑定的 Artifact、可视化结果、可编程 B-Rep Probe，
以及 Fresh Reviewer 的独立结论。

## 为什么切换到 Prime Agent

早期 Pi-CAD 以一组较宽的 Pi extensions 作为产品入口。当前版本把作者 Agent
切换到 Prime，同时保留 Pi extension API 作为底层兼容实现。

原因不是换一个 TUI，而是机械设计本质上是一项长时间、有状态的工程任务：

- **持久 IPython 是控制平面。** `ArtifactRef`、`Commit`、Probe 结果和普通
  Python 变量可以跨轮次保留。Agent 直接调用很小的 `cad` API，不需要通过 shell
  搬运状态或临时猜测调用方式。
- **原生 RLM fan-out。** 装配体可以使用 Prime 的普通子 Agent 做有边界的研究或
  零件工作，但根 Agent 始终对唯一的 canonical workflow 和 authoritative
  candidate 负责。
- **长任务不会依赖一段无限增长的对话。** Prime 已提供持久 session、compaction、
  goal、autonomous continuation 和事件触发的新轮次。Pi-CAD 无需再实现第二套会话
  和上下文运行时。
- **模型与 provider 仍由 Prime 管理。** Pi-CAD 不再造一个模型网关。作者和
  Fresh Reviewer 使用 Prime 选择的 provider/model，Reviewer 只拥有独立且受限的
  预算和权限。
- **Skill 是明确的操作契约。** Prime 加载仓库跟踪的 CAD 和 imagegen skills。
  公共 API 签名、严格的 handoff 顺序和禁止事项都直接提供，不需要读源码、
  `inspect.signature()` 或自行适配。
- **Headless 的成功有权威定义。** one-shot Prime 只有在 sidecar 确认 terminal
  workflow、有效的最终 PASS 和精确的 release commit 后才返回成功。Agent 在自然
  语言里说“完成了”不算完成。

这条边界是产品的核心：Prime 拥有推理、session、模型和子 Agent；Pi-CAD 拥有
工程状态、effect、证据与发布权威。

## 权威模型

当前运行时遵循一条简单规则：

> 文件只是数据。只有 State Engine 接受的 canonical state 才具有工作流效力。

任意 STEP、JSON、PNG，甚至被手工修改的 `.pi-cad/status.json`，都不能因为存在于
磁盘上就推进工作流。只有被接受的 commit、artifact、evidence、transition 和
review result 才有效。

```text
bwrap 中的 Prime 作者 Agent
  ├─ 持久 IPython + cad Python client
  ├─ project workspace（读写）
  └─ author-scoped Unix socket
                    │
                    ▼
             Authority sidecar
             ├─ pinned workflow snapshot
             ├─ 统一 authorize(operation, ...)
             ├─ project 外的 canonical CAS state
             ├─ artifact/evidence 失效传播
             ├─ reviewer admission 与事件
             └─ completion gate
                    │
                    ▼
       独立 bwrap 中的 Fresh Prime Reviewer
       immutable candidate + probe-only authority
```

作者 sandbox 看不到 Engine 源码、canonical storage、host credentials 或 reviewer
authority。Reviewer 使用另一条 socket，只能读取 immutable subject、执行受限 Probe
并提交结论。project 内的 `.pi-cad/status.json` 只是原子更新、无权威性的状态投影。

## 当前能力

### 可发现、可固定的工作流包

工作流像 Skill 一样被发现，启动时编译并固定为 immutable snapshot。一次运行开始
后，即使源 YAML 被修改，该运行也不会改变。

| Package | 用途 |
| --- | --- |
| `mechanical.one-shot` | 从零设计单个零件或装配体，并经过独立审查与发布 |
| `mechanical.modify` | 对现有设计做受控修改 |
| `mechanical.analysis` | 有边界的只读工程分析 |

`mechanical.one-shot` 的正式路径是：

```text
GRILL → SPEC → CONCEPT
                  ├─ 简单零件 → PARTS ──────────────────┐
                  └─ 装配体 → INTERFACE → BOM → PARTS → ASSEMBLY
                                                        │
                         FINAL_REVIEW → RELEASE → DONE ◀─┘
```

CONCEPT 完成前没有 detailed CAD 权限。装配体不能跳过接口、architecture/BOM、零件
工作或装配验证。Kernel 本身不认识这些机械 phase 名称，它只执行工作流包编译出的
通用 snapshot。

### Phase Card

每次 provider call 前，Prime 恰好收到一张 ephemeral card：

```text
WHERE
GOAL
SOP
MUST
CAN
NEXT
STATE
WARNINGS
```

- `CAN` 严格等于统一 authorization engine 返回的有效能力。
- `MUST` 严格等于尚未关闭的 obligations。
- `NEXT` 只包含此刻真正可执行的 transition，而不是 YAML 中声明的所有出口。
- 卡片有固定大小；下一轮先删除旧卡，不会永久堆进 trajectory。

Denied operation 和 Phase Card 使用同一套 reason/legal-next-action 渲染，因此模型
看到的指导与工具真正执行的权限不会分叉。

### 确定性 CAD、图片和证据

- Agent 编写 project-local build123d 源码，并暴露一个 `result` shape。
- `cad.model.build()` 只有在 managed visual chain 已生成并返回强制视图后才导出
  STEP 和 `ArtifactRef`。
- 支持正常迭代重建。成功 rebuild 会原子替换 primitive build evidence，把旧证据
  标为 stale，使依赖它的 claims/reviews 失效，并禁止继续使用所有旧
  `ArtifactRef`。
- 面向 CadQuery 描述的 benchmark 会保留几何与尺寸语义，但通过受控 build123d
  backend 实现。
- concept image 只是空间假设。只有 concept commit 引用后它才进入工作流记录，
  永远不会成为 geometry authority。

### 任意 ArtifactRef 的可编程 Probe

Prime 可以对任意 project-local `ArtifactRef` 执行只读 B-Rep 计算，无需捕获函数
源码：

```python
checks = await cad.probe.run(
    subject=artifact,
    purpose="验证发布包络和 solid 数量",
    code="result = {'solids': len(shape.solids()), 'size': list(shape.bounding_box().size)}",
)
```

受限程序获得预绑定的 `shape` 和 `artifact_path`，必须给 `result` 赋一个可 JSON
序列化的值。unrestricted imports 不能越过 effect fence。

### Codex OAuth 图片生成

仓库跟踪的 `codex_generate_image` 是 MIT 许可
`@crazygit/pi-codex-image-gen` v0.2.2 的 Prime 兼容移植：

- 使用现有 `openai-codex` OAuth 和 `chatgpt_account_id`；
- 固定 `gpt-image-2`，没有 `OPENAI_API_KEY` fallback，也不启动 Codex CLI；
- 相对输出只能保存在当前 project，默认写入
  `.pi/generated-images/<session-id>/`；
- path traversal 和 symlink 在写入前重新校验；
- 上传 reference image 前必须交互确认，headless reference editing fail closed；
- 真实外部调用按需发生，不限制为“用户必须明确要求图片”。

Author sandbox 默认设置 `PI_OFFLINE=1`。只有明确允许本次运行调用外部 Codex
Images 服务时，才设置 `PI_OFFLINE=0`。

### 事件驱动的独立审查

Fresh Reviewer 是普通 Prime RLM template，不是特殊的高权限 Agent。Sidecar 负责：

- 以 workflow + contract + artifact identity 作为幂等键；
- 同一 candidate 最多启动一个 Reviewer；
- immutable subject 和 reviewer-scoped endpoint；
- probe-only 工程权限；
- `maxProbeCalls=12`、`maxTurns=16`、`wallTimeout=120s`、禁止 compaction；
- `pass | fail | unresolved` 三种 verdict；
- timeout、crash、空回复、无 evidence 的 PASS 全部 fail closed；
- 完成后向 parent Prime 发送事件并触发新一轮，不允许主 Agent polling。

candidate、spec 或 contract revision 会自动使旧 review stale。Completion gate 只有
在最终有效 PASS 和精确 release commit 同时存在时才放行。

### Recipe-native 工程计算

复杂确定性能力统一使用严格的 `pi-recipe.yaml` 协议。仓库当前提供或保留：

- OpenFOAM 14 有限体积工作流；
- SU2 8.5.0 稳态流动与固体传热工作流；
- torch-fem 0.9 CUDA 结构分析与优化；
- 确定性 drawing、presentation、observation 与 re-observation。

Recipe 固定声明过的 inputs 和 compute closure，在 pinned environment 中运行，把完整
raw output 留在模型上下文之外，并生成 typed observations。Observation 不是验收；
它仍需被明确提交给匹配的 workflow obligation 才能成为 Evidence。

## 公共 Python API

Prime 通常从 CAD skill 获得这些调用。作者侧核心 API 保持很小：

```python
import cad

await cad.workflow.list()
await cad.workflow.start("mechanical.one-shot")
await cad.workflow.current()
await cad.workflow.advance("specified")

commit = await cad.commit("spec", variables={"requirements": requirements})
artifact = await cad.model.build("part.py", "part.step")
checks = await cad.probe.run(subject=artifact, purpose="...", code="result = {...}")

final_commit = await cad.commit(
    "review-candidate",
    artifacts=[artifact, "part.py"],
    variables={"checks": checks.value},
)
handle = await cad.review.submit(final_commit)
# 等待 host review-complete event，之后：
verdict = await cad.review.current(handle)
```

不要猜 ID、读源码/签名、轮询 review，或在 rebuild 后保留旧 artifact handle。直接
使用 API 返回的 Python 对象，并且只执行当前 Phase Card `NEXT` 中出现的 transition。

## 运行要求

Authority runtime 当前仅支持 Linux/WSL：

- Ubuntu 或 WSL2 Ubuntu
- Node.js 22.19+
- 由 `uv` 管理的 Python 3.11/3.12
- Bubblewrap 0.11.1 或兼容版本
- gmsh/OCP 相关路径需要 `libglu1-mesa`
- Prime Agent 源码 checkout 和已配置的 provider

当前 launcher 跟随 Prime 的 extension、IPython、event 和 autonomous-gate API，
因此正式开发配置使用 Prime 源码 checkout。

## 开发安装

把两个仓库放在同一目录：

```text
~/work/
├── prime-agent/
└── pi-cad/
```

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap libglu1-mesa

mkdir -p ~/work
cd ~/work
git clone https://github.com/QiuYi111/prime-agent.git
git clone https://github.com/QiuYi111/pi-cad.git

cd prime-agent
npm ci

cd ../pi-cad
npm install
npm run setup:python
```

初始化隔离的 Prime configuration/kernel，并完成一次登录：

```bash
cd ~/work/pi-cad
PRIME_AGENT_REPO=~/work/prime-agent npm run prime:setup
# 在 Prime 中执行：/login
```

把 sandboxed launcher 安装到当前用户：

```bash
mkdir -p ~/.local/bin
ln -sfn "$PWD/scripts/prime-cad-launcher.sh" ~/.local/bin/prime-cad
```

确认 `~/.local/bin` 在 `PATH` 中。之后在需要设计的 project 目录启动：

```bash
cd /path/to/design-project
PRIME_AGENT_REPO=~/work/prime-agent prime-cad
# 本次运行允许外部图片生成：
PI_OFFLINE=0 PRIME_AGENT_REPO=~/work/prime-agent prime-cad
```

Launcher 会独占 `--cwd`、启动 authority sidecar、建立 author/reviewer sandbox，且只
加载仓库跟踪的 CAD/imagegen extension 与 skill。Canonical state 存储在：

```text
~/.local/share/pi-cad/<sha256(realpath(project))>/
```

Headless 示例：

```bash
PRIME_AGENT_REPO=~/work/prime-agent \
prime-cad --provider openai-codex --model gpt-5.6-luna \
  --thinking medium --no-session --mode json --print \
  "Use mechanical.one-shot to design and release a 100 x 80 x 5 mm plate."
```

如果 canonical completion gate 未满足，one-shot 会返回退出码 `42` 和
`WORKFLOW_INCOMPLETE`，不会把自然语言输出当成功。

## 验证

```bash
npm run check:agent-contract
npm run test:ts

PYTHONPATH="$PWD/skills/cad/src" PYTHONDONTWRITEBYTECODE=1 \
uv run --offline --frozen --project python --extra simulation \
  python -m unittest discover -s tests -p 'test_*.py'

npm run check:prime-imagegen
npm run test:prime-imagegen
node tests/prime-cli-smoke.mjs
git diff --check
```

当前 targeted Prime acceptance baseline 包含 CADTestBench `00001817`：CAD tests
`17/17`、RS `9/9`，且没有 probe source-capture error、tool/API adaptation error 或
polling；同一 candidate 只有一个 Reviewer，最终 workflow 为 terminal。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `src/authority/` | sidecar、bwrap launcher、canonical storage、completion gate |
| `src/harness/` | workflow compiler/state、authorization、Phase Card、commit/evidence |
| `src/agent-api/` | 小型、与 transport 无关的 Agent-facing operations |
| `src/integrations/prime/` | Prime Phase Card、图片授权和 review-event 薄适配层 |
| `skills/cad/` | Prime CAD 操作契约和 Python client |
| `workflow-packages/` | 可发现的 workflow package YAML |
| `packages/prime-codex-image-gen/` | Codex OAuth 图片生成 extension |
| `recipes/` | 严格的确定性 compute packages |
| `benchmarks/cadtestbench/` | targeted CADTestBench runner 与报告 |

更早的架构和重构历史保留在 [`refactor/`](refactor/)；本 README 描述的是当前发布的
Prime authority runtime。

## Trust model 与限制

- Author project 是可写的。请使用独立 project 目录或 Git worktree，并审查生成的
  源码和 artifacts。
- Authority sidecar 当前只支持 Linux/WSL。
- Prime 集成目前跟随源码 checkout，尚未提供独立的一键 Pi-CAD installer。
- Codex OAuth 的 `gpt-image-2` 是 provider-managed capability，可能在仓库之外发生
  变化。
- Reviewer 只证明配置的 evidence contract，不替代物理测试、制造审查或专业工程
  签字。
- Simulation scope 必须显式。非线性、多材料、共轭传热、燃烧或透平机械等未支持
  假设必须被说明，不能静默近似。

## License

[MIT](LICENSE)。图片生成兼容包保留了上游 attribution 和 license，位于
[`packages/prime-codex-image-gen`](packages/prime-codex-image-gen)。
