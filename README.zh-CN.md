# Pi-CAD

**会亮出证据的智能体机械 CAD。**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml/badge.svg)](https://github.com/QiuYi111/pi-cad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Pi-CAD 是为
[Pi 编码智能体](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
打造的机械 CAD harness。AI 智能体负责设计零件、跑数值、走完工程评审流程
——但它做出的每一个论断,背后都有你可以亲手打开的文件、亲眼查看的渲染图,
以及一旦被改动就会立刻报警的哈希。

整个系统建立在一个简单的职责划分上:

- **确定性工具负责几何与物理。** build123d/OCP 负责 CAD,gmsh 负责网格,
  torch-fem 负责线弹性,NLopt 负责拓扑优化。任何 LLM 都不决定尺寸,
  也不给应力图"盖章"。
- **智能体负责解读现实** —— 它读场数据、看视图、查几何事实,然后用自然语言
  为设计决策做论证。
- **状态机负责流程纪律。** 评审不可跳过,只读阶段无法改动项目,
  没有证据就无法验收——这是结构上不可能,不是口头承诺。
- **证据与哈希绑定。** Spec、结果、场数据、渲染视图都按 run 归档、计算哈希,
  并在每次验收时重新校验。被篡改或过期的证据会被拒绝,绝不静默复用。

> 原始设计理念见重构文档:[`refactor/pi-cad-refactoring-whitepaper.md`](refactor/pi-cad-refactoring-whitepaper.md)(愿景)与 [`refactor/pi-cad-engineering-design-v2.md`](refactor/pi-cad-engineering-design-v2.md)(实施计划,英文)。

---

## 快速开始

Pi-CAD 是一个 Pi 包。在无显示器的 Debian/Ubuntu 环境中，先安装 gmsh
依赖的 GLU 运行库，再让 Pi 克隆包、安装 Node 依赖，并通过包的
`postinstall` 脚本构建 Python CAD 运行时：

```bash
sudo apt-get install -y libglu1-mesa
pi install git:github.com/QiuYi111/pi-cad
pi list
```

`package.json` 中的 `pi` manifest 会在下次启动 Pi 时自动加载全部八个扩展
和随包 skills，无需传入任何 `-e` 参数。

若要使用开发工作区，先在工作区安装依赖，再把该目录注册为用户级 Pi 包：

```bash
git clone https://github.com/QiuYi111/pi-cad.git
cd pi-cad
npm install
pi install .
pi list
```

本地包安装会链接工作区而不是复制文件，因此源码修改会在下次启动 Pi 时直接
生效；只有依赖或 Python 运行时 bootstrap 变化时才需要重新运行
`npm install`。

若只想临时启动而不安装包，也可以显式加载全部扩展：

```bash
pi -e src/extensions/core/index.ts \
   -e src/extensions/probe/index.ts \
   -e src/extensions/geometry/index.ts \
   -e src/extensions/visual/index.ts \
   -e src/extensions/drawing/index.ts \
   -e src/extensions/simulation/index.ts \
   -e src/extensions/presentation/index.ts \
   -e src/extensions/ui/index.ts
```

## 第一个零件

在空目录里试试:

```text
/cad
"设计一块 100 x 80 x 5 mm 板,四个 6 mm 通孔,孔心距边缘 10 mm。"
```

智能体会路由 run、提交需求、构建 STEP——然后在它发表任何意见**之前**,
harness 已经自动渲染七张视图、提取几何事实作为证据,并绑定到确切的源码与
工件哈希。图片会直接回到对话里。审查、提修改意见、验收:

```text
"看起来不错——验收并结束。"
```

常用斜杠命令:

| 命令 | 作用 |
| --- | --- |
| `/cad` | 显示工作区:项目、设计头、当前 run |
| `/cad-status` | run 的权威状态、阶段与证据 |
| `/cad-abort` | 仅中止当前 run;项目设计头不受影响 |

## 路由,而非工作流

路由是一个层次化描述,智能体一次调用决定,harness 据此**编译**出流程——
不存在可选的捷径:

```
route = objective × lineage × structure × maturity
        analyze | convert | design
                        greenfield | legacy | hybrid
                                     part | assembly
                                          prototype | engineering | manufacturing | release
```

| 路由(示例) | 编译出的流程 |
| --- | --- |
| `design/greenfield/part/engineering` | requirements → part_design → build → review(快速路径是*推导*出来的) |
| `design/legacy/part/engineering` | requirements → baseline → plan → modify → review,带前后对比 |
| `design/greenfield/assembly/engineering` | requirements → system_concept → assembly_design → interface_design → part_design → build → integration_review |
| `design/*/release` | baseline(若有)→ audit → gap_closure → package → final_review,九个工作流 |
| `analyze` | baseline → investigate → explain(只读) |
| `convert` | source_baseline → transform_plan → convert → compare |

两条 0.8 规则比表格更重要:

- **Maturity 是现实底线,不是心情。** prototype 意味着 REAL / BUILDABLE /
  FUNCTIONAL。maturity 只*增加*义务(manufacturing 要求图纸证据;release
  增加工作流与演示交付物)——绝不会换来更短的流程。
- **义务无法被绕过。** assembly 路由必须提交生成合同声明的 assembly-design
  与 interface-contract records(它们是所处阶段的唯一出口),并持有当前版本的
  装配树与干涉 Evidence。过程中 route change 只增义务时自主
  生效并回到最早未满足的阶段;任何降级都需要 harness 签发的一次性授权
  token——而 token 只在你真实回复过智能体的提问后才签发,智能体自称
  "用户已同意"永远不算数。

## Agent Contract

安装包内含 schema-1 `AgentContract`,由 active tool catalog、route compiler、
phase contract、event 与 obligation 直接生成。同一过程生成架构/工作流 reference
与六类工具手册;CI 执行 `generate-agent-contract --check`,任何代码/文档漂移都会
失败。机器合同位于 `assets/agent-contract.json`;每个公开工具到 cookbook、
可执行 asset 与 qualification 的映射位于 `assets/cookbook-catalog.json`。

运行时每轮注入紧凑且权威的 **Current Action Card**:route/phase/status、阶段目的、
允许写入、当前可用工具、未满足 records/Evidence、artifact 绑定、合法事件、
guards、下一动作,以及只有真实 probe ready 的 managed runtime。正常使用只依赖
已安装 skills、实时 tool schema 与行动卡,不再读取 `src/**`;非法 transition 也会
以机器可读形式返回同一组恢复信息。

Probe 使用不可变完整快照。首屏有上下文预算,但没有不可恢复的语义硬上限:
faces、assembly occurrences、interference pairs、Python 数组/表格与完整失败日志
都进入压缩 collection,可按 filter/order/cursor 分页读完。超出存储 quota 会明确
失败,绝不静默丢数据。

## 仿真能力的诚实边界

Simulation V2 的正式链路是:

```text
编写 solver-native Recipe
→ managed compute
→ 可选 immutable re-observation
→ 显式 case-scoped Evidence commit
```

每个 Recipe 包含严格的 `pi-sim.toml`、可自由编程的 managed entrypoint、
observation program、显式项目输入,以及只使用
`image | scalar | timeseries | table | field | artifact` 的命名 exports。
visual Recipe 必须有 primary image 和 primary quantitative export;
nonvisual Recipe 必须有 primary quantitative export。省略 `outputs` 返回
primary floor;显式名字只能追加观察;`outputs=[]` 非法。

Harness 只快照 Recipe 与 declared inputs,在固定版本、默认断网的 runtime
中执行;完整日志和 raw state 留在上下文之外,图片先于受限的量化摘要返回。
只修改 observation files 会产生新的 immutable snapshot,不会重跑 Solver;
每个 Observation 都保存实际运行的 manifest/observer 文件、tree/file hash、
rendered plot hash 与 materialized exports。因此后续 re-observe 后,旧的精确
snapshot 仍可独立审计和提交。修改 compute 文件或输入则必须新建 run。
已物化的文件 export 会进入 run 级 `objects/sha256/` 存储;未变化的大型
field 通过硬链接复用同一个 immutable object,不支持硬链接时回退到
copy/reflink。

simulate 和 observe 都不创建 Evidence。commit 会复验精确的 run、observation、
runtime identity、declared inputs、当前 case obligation,以及 authoritative
artifact 或受验证 derivation。Evidence 表示溯源成立,不等于工程 PASS。

schema 2 runtime registry 数据驱动注册四个精确环境:

- `openfoam/openfoam-14`:固定 `openfoam14@20260724`;
- `su2/su2-8.5.0`:官方 archive 加固定 SHA256;
- `torch-fem/torch-fem-0.9-cu126`:正式 CUDA 结构求解与优化;
- `torch-fem/torch-fem-0.9-cpu`:只能显式选择,用于 CI、调试和小算例。

在 Linux/WSL 内分别运行 `scripts/bootstrap-openfoam14.sh`、
`scripts/bootstrap-su2-8.5.0.sh` 与 `scripts/bootstrap-torch-fem-runtimes.sh`
完成一次性安装。Windows Node host 一律通过 WSL 启动 Linux runtime,
Recipe Python 不在 Windows 上执行;entrypoint/observer 使用锁定项目的
`uv run --offline --frozen`。正式运行由 bubblewrap、user systemd scope、
断网、只读挂载、资源上限与 workspace quota 隔离。普通 CI 使用 stub runtime;
每个 uv runtime 的版本/accelerator probe 由 registry entry 声明,generic runner
不再硬编码 torch-fem/CuPy。trusted Solver health 会在默认 Observation context
中显示 requested/actual device、GPU 与 CUDA 版本,Recipe 自报不能覆盖。
真实 qualification Recipe 位于 `benchmarks/simulation-v2/openfoam14-box`。
仓库内的 `benchmarks/simulation-v2/spec04-template` 已包含 OpenFOAM case
generator、三阶段 solver runner、收敛/鲁棒性聚合和 Rev1 release gate。
制造 CAD、材料、surface mapping 与 Rev1 criteria 仍作为 ignored 权威输入;
缺失时明确返回 `blocked_external`,且不能产生 `SIMULATION_RELEASE_PASS`。

### 结构、热与流 Recipe

公开接口不再注册 typed physics wrapper。统一 Probe 是唯一探测入口;
所有新仿真都走 Recipe-native 链路。物理、单位、材料、载荷、约束、边界、
网格、求解控制和项目指标全部留在 Recipe,不进入 Core。

`structural-analysis` skill 提供 torch-fem 线弹性 Recipe。正式 CUDA runtime
固定 torch-fem 0.9.0、PyTorch 2.13.0+cu126、CuPy 14.1.1 和 Python 3.12,
启动前验证 PyTorch CUDA、CuPy device、compute capability 与一次真实 GPU
sparse solve。GPU、driver、CuPy 或架构不兼容时返回 `unavailable`,绝不
静默转 CPU。正式 Evidence 必须记录 `actualDevice=cuda`;显式 CPU 运行绑定
不同 runtime identity。

当前共享 workflow state schema 为 v6。Simulation V2 的 clean transition 最初
进入 v5;后续 immutable requirements revision 将总 workflow schema 升至 v6,
但 Recipe schema 1 与 Observation wire schema 1 没有变化。

`thermal-fluid-analysis` skill 提供 SU2 steady-flow 和 solid-thermal Recipe,
并说明何时应使用 OpenFOAM。SU2 只从 immutable
`/opt/pi-cad-runtime/su2/8.5.0` 启动,不接受宿主 PATH 或环境变量绕过。

optimization operation 默认在同一个 managed CUDA runtime 内运行二维 SIMP/MMA
可微优化。它只生成 optimization artifact,不是 CAD 或 Simulation Evidence。

Skill 分三层:`pi-cad` 负责 workflow/Evidence,`pi-cad-tools` 覆盖完整 active
public catalog,工程知识 skills 分别处理机械、参数化建模、装配、制造、
结构分析与热流分析。

#### SU2 Recipe 保留的模型契约

两个 SU2 Recipe 把显式 case 数据编译成 solver config,再把 native 结果翻译
为通用 Observation export。单位规则冻结且直接写在字段名里:
CAD 几何按 `geometryUnits` 解释(默认 mm),所有物理量用显式 SI
(`totalPressurePa`、`temperatureK`、`maxSizeMm`……)——求解器永远不会遇到
隐式 mm→m。

- **Steady-flow Recipe** —— 在显式水密流体域 STEP 上做稳态单区 CFD:
  可压缩 Euler、可压缩 RANS(SA/SST)、不可压缩 NS/RANS。每个边界面必须
  且只能分类一次(总条件进口、压力出口、壁面);结果含收敛历程、按面积的
  面加权均值、质量平衡、原始场与视图。收敛的喷管算例出口马赫数与等熵
  气动表相差百分之几。
- **不隐藏流体物性。** 粘性求解器必须显式声明 `fluid.viscosity`
  (常数 μ,或带你自己常数的 Sutherland);Reynolds 初始化尺度由声明的
  模型推导——没有任何空气默认值。
- **收敛性是执行有效性,不是工程判断。** 未声明或未达到
  `residualTarget` 的运行返回 `status=not_converged`:原始场仍会展示
  用于诊断,但该运行**不会**产生仿真证据,也关不掉 required case。
- **Solid-thermal Recipe** —— 稳态固体导热:定温与定热流边界、其余绝热、
  常导热系数。一维平板 fixture 在 CI 中与 `q = kAΔT/L` 解析解对比。
  边界热流率字段命名为 `reconstructedHeatRateW`,因为它由解的单元梯度
  重构积分而来,不是 SU2 自身的守恒面通量。
- Probe 的 surfaces preset —— 确定性的边界面事实(类型、面积、质心、包围盒、
  法向/轴线)加带标注的视图。面 ID 只是对当前工件哈希有效的几何选择器,
  绝不是语义标签:哪个面是进口,由智能体自己判断。

SU2 使用官方 8.5.0 "Harrier" archive 与固定 SHA256,显式 bootstrap 到
`/opt/pi-cad-runtime`。未安装时返回 `unavailable`;正式运行不搜索宿主 PATH。

Recipe 和 skill 必须明确与结论有关的非线性、多材料、CHT、燃烧或叶轮机械
假设。工具只返回观察与 provenance;工程判断不进入 Core。

## 为什么可以信任输出

- **验收需要证据。** 没有当前的视觉与几何证据,工件无法被验收;
  需求里要求仿真时,仿真证据同样不可或缺。
- **证据防篡改。** 每个证据工件都有 sha256 哈希,并在
  acceptance 与 finish 时重新校验。
  改写结果文件会直接校验失败。
- **仿真绑定求解前的工件哈希。** 求解期间 STEP 被改动,结果会被丢弃,
  而不是绑到错误的版本上。
- **证据输入同样会被重验。** 流/热证据携带哈希绑定的输入(canonical
  spec、产品工件、流体域),acceptance 与 finish
  会重新哈希;求解后改写流体域 STEP,和改写结果文件一样会使证据失效。
- **未收敛的运行不是证据。** 收敛性由 interpreter 判定:未达到声明的
  残差目标(或未声明目标)的运行以 `status=not_converged` 返回原始场,
  harness 不会从中记录任何证据。
- **声明的仿真工况必须真的跑过。** 需求里声明了按工况的义务
  (如通过 managed simulation 验证 `nozzle-outlet`)时,验收与收尾会被一直挡住,
  直到每个工况都用声明的工具产生了当前版本的证据——跑一次结构 FEA
  关不掉一个流场工况。harness 只比对不透明标识,绝不理解物理。
- **候选一变,旧证据自动过期。** 你无法拿上一版的仿真去验收新几何。
- **不可用的后端会明说。** Blender、PDF 图纸、GD&T 缺失都会如实报告
  unavailable——harness 绝不伪造一个假验证器。
- **与其他插件和平共处。** Pi-CAD 只以叠加层方式管理自己的 `cad_*`
  工具——绝不卸载或重新激活其他插件的工具;阶段策略在调用时强制执行,
  而不只是把工具藏起来。

## 配置

| 变量 | 作用 |
| --- | --- |
| `PI_CAD_UV` | 在原生 Linux 上覆盖 `uv` 可执行文件 |
| `PI_CAD_WSL_DISTRO` | Windows Node host 使用的 WSL 发行版(默认 `Ubuntu`) |
| `PI_CAD_ENABLE_DEV_RUNTIMES` | 显示 development-only runtime,包括显式 CPU (`1`) |
| `CUDA_VISIBLE_DEVICES` | 选择暴露给 managed runtime 的 CUDA 设备 |

运行时能力检查("doctor" 报告)是对**实际会用到的那份 Python** 的实时
探测,每个会话尊重一次——不是安装时刻的过期快照。

## 测试与 CI

```bash
npm test          # 或:bash scripts/test.sh
```

TypeScript 协议/harness 测试与 WSL/Linux 中通过 `uv run` 执行的 Python
测试覆盖 manifest/path closure、Observation、显式 commit、资源限制、CUDA
fail-closed、结构 refinement/平衡/梯度、SU2 解析导热与流动守恒以及 OpenFOAM
qualification。普通 CI 不伪造 GPU qualification。

## 磁盘上有什么

一个工作目录是一个长生命周期的**设计项目**;每次工作流活动是一个
短生命周期的 **run**:

```text
.pi-cad/
├── project.json      # 设计头:当前源码/STEP/哈希 + 已验收证据
└── runs/
    └── run-.../      # 状态、事件、记录、
                      └── evidence/<kind>/<id>/   # spec.json + 结果 + 视图
```

项目空闲时由生成合同声明的 route operation 创建 run;finish 与 `/cad-abort` 清除它。
中止 run 不影响设计头。旧的单状态布局会自动迁移。

## 仓库导航

| 区域 | 路径 |
| --- | --- |
| Harness 核心(状态机、策略、证据) | `src/core/` |
| 工具扩展(探测、几何、图纸、仿真、演示、UI) | `src/extensions/` |
| Skill 路由、工程参考与 Recipe assets | `skills/` |
| 工作流定义(全部七种) | `src/workflows/` |
| 分层提示词 | `src/prompts/` |
| 确定性 Python 后端 | `python/cadctl/` |
| Spec 模板 | `assets/templates/` |

## 已做过的验证

真实端到端运行(使用 `openai-codex/gpt-5.6-luna`,thinking=medium):
板件构建(快速路径)、只读板件分析、5→4 mm 板件修改(带对比证据)、greenfield
笔架、以及一次诚实地报告 closed/blocked 工作流的 release 交付——
全部到达 `done` 且证据完好。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
