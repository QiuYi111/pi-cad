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

> 原始设计理念见 [`pi-cad-whitepaper.md`](pi-cad-whitepaper.md)(英文)。

---

## 快速开始

```bash
git clone https://github.com/QiuYi111/pi-cad.git
cd pi-cad
npm install
```

`npm install` 会一并构建 Python CAD 运行时(包内 venv,含 build123d、gmsh、
torch-fem 等)。无显示器的 Linux 服务器还需要 gmsh 依赖的 GLU 运行库:

```bash
sudo apt-get install -y libglu1-mesa
```

然后加载全部七个扩展启动 Pi:

```bash
pi -e src/extensions/core/index.ts \
   -e src/extensions/geometry/index.ts \
   -e src/extensions/visual/index.ts \
   -e src/extensions/drawing/index.ts \
   -e src/extensions/simulation/index.ts \
   -e src/extensions/presentation/index.ts \
   -e src/extensions/ui/index.ts
```

(若以 Pi 包形式安装,`package.json` 的 `pi` 键会自动加载全部七个扩展,
无需任何参数。)

## 第一个零件

在空目录里试试:

```text
/cad
"路由一个 quick 工作流:100 x 80 x 5 mm 板,四个 6 mm 通孔,
孔心距边缘 10 mm。"
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

## 七种工作流

用自然语言路由("分析这个 STEP"、"发布当前设计头"),Pi-CAD 自动选择
工作流,你不需要管理 run ID。

| 工作流 | 适用场景 |
| --- | --- |
| `quick` | 零件已完全定义——直接建 |
| `analyze` | 已有 STEP,想做只读诊断 |
| `modify` | 对现有零件做受控再设计,带前后对比 |
| `greenfield` | 全新概念 → 意图 → 构建,可选领域分析 |
| `hybrid` | 旧基线与全新概念合并 |
| `convert` | 把源基线转换成其他格式(如 STEP → STL) |
| `release` | 审计 → 补缺口 → 打包 → 交付,含图纸/BOM 工作流 |

## 智能体到底能做什么

**流程控制** —— `cad_route`、`cad_commit_requirements`、`cad_commit_plan`、
`cad_commit_candidate`、`cad_transition`、`cad_wait_for_user`、`cad_finish`。
`cad_commit_candidate` 负责自动观测循环:构建 → 七张视图 → 几何事实 →
(modify/convert)确定性对比 → 按哈希绑定证据 → 进入评审。

**几何** —— `cad_build_step`、`cad_inspect_visual`、`cad_inspect_geometry`、
`cad_inspect_section`、`cad_measure`、`cad_compare_geometry`、
`cad_assembly_tree`、`cad_export`。

**工程分析** —— `cad_simulate`、`cad_optimize`、`cad_generate_drawing`、
`cad_render_scene`。

四个工程工具全部接收结构化参数(材料、载荷、约束、网格、视图、方向)。
你不需要指定 spec 文件或输出目录——harness 自己把 spec 规范化写入 run 级
证据存储。正因如此,即使是只读的评审阶段也能跑仿真而不碰你的项目目录。
未知的物理类型、载荷类型、约束类型、区域、或第二份材料,都会报错拒绝,
绝不靠猜。

## 仿真能力的诚实边界

V1 做得好的:

- **线弹性 FEA**:torch-fem 求解,gmsh 对 STEP 划分四面体网格,或参数化
  盒式网格。单位固定:mm / N / MPa。
- **可推理的边界条件**:集中力载荷重叠时*相加*,固定约束重叠时*取并集*。
  区域选择轴向极值节点层,或显式节点编号。
- **可读的结果**:七张渲染视图(位移、von Mises、变形形状……)、NPZ
  完整场数据、含反力平衡/网格溯源/设备回退原因的结果 JSON。
- **多工况并存**:同一零件的常规、峰值、冲击载荷工况按 spec 哈希并排保存,
  互不覆盖。
- **设备诚实**:CPU 是一等公民;有匹配 CuPy 时用 CUDA;Metal 明确回退
  CPU。没有任何伪装。

V1 刻意不做的:非线性材料、压力/牵引载荷、任意 CAD 面边界条件(确定性的
网格边界检查器是下一步计划)、多材料零件。工具只返回原始确定性场——
它永远不说"安全"或"合格";这个判断属于智能体,也属于你。

`cad_optimize` 是标注清晰的走通骨架:可微分 SIMP 拓扑优化(二维矩形域、
MMA 内环),输出是密度/曲面证据,永远不是 CAD 候选。

## 为什么可以信任输出

- **验收需要证据。** 没有当前的视觉与几何证据,工件无法被验收;
  需求里要求仿真时,仿真证据同样不可或缺。
- **证据防篡改。** 每个证据工件都有 sha256 哈希,并在
  `cad_transition(accepted)` 与 `cad_finish` 时重新校验。
  改写结果文件会直接校验失败。
- **仿真绑定求解前的工件哈希。** 求解期间 STEP 被改动,结果会被丢弃,
  而不是绑到错误的版本上。
- **候选一变,旧证据自动过期。** 你无法拿上一版的仿真去验收新几何。
- **不可用的后端会明说。** Blender、PDF 图纸、GD&T 缺失都会如实报告
  unavailable——harness 绝不伪造一个假验证器。

## 配置

| 变量 | 作用 |
| --- | --- |
| `PI_CAD_PYTHON` | 所有 cadctl 调用使用此 Python 二进制 |
| `PI_CAD_VENV` | 安装器与运行时共同指向一个已有 virtualenv |
| `PI_CAD_SKIP_CUPY` | 跳过尽力而为的 CuPy 安装(设为 `1` 关闭) |

运行时能力检查("doctor" 报告)是对**实际会用到的那份 Python** 的实时
探测,每个会话尊重一次——不是安装时刻的过期快照。

## 测试与 CI

```bash
npm test          # 或:bash scripts/test.sh
```

31 个 TypeScript harness 测试 + 19 个 Python 后端测试,包括悬臂梁网格
收敛对梁理论的校验、载荷/约束重叠语义、负向验证矩阵、证据篡改、
工件中途变更竞态。CI 在每次 push 时于全新安装(Linux CPU)上跑全量套件。

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

项目空闲时 `cad_route` 创建 run;`cad_finish` 与 `/cad-abort` 清除它。
中止 run 不影响设计头。旧的单状态布局会自动迁移。

## 仓库导航

| 区域 | 路径 |
| --- | --- |
| Harness 核心(状态机、策略、证据) | `src/core/` |
| 工具扩展(几何、视觉、图纸、仿真、演示、UI) | `src/extensions/` |
| 工作流定义(全部七种) | `src/workflows/` |
| 分层提示词 | `src/prompts/` |
| 确定性 Python 后端 | `python/cadctl/` |
| Spec 模板 | `assets/templates/` |

## 已做过的验证

真实端到端运行(使用 `openai-codex/gpt-5.6-luna`,thinking=medium):
quick 板件构建、只读板件分析、5→4 mm 板件修改(带对比证据)、greenfield
笔架、以及一次诚实地报告 closed/blocked 工作流的 release 交付——
全部到达 `done` 且证据完好。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
