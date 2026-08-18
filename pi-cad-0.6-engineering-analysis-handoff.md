# Pi-CAD 0.6 Handoff — Engineering Analysis & Differentiable Optimization

## 0. 任务定义

本次工作是 **subsystem-level refactor**，不是重写 Pi-CAD 核心架构。

目标：

1. 让 Pi package 安装后自动得到可用的 Python/CAD/仿真运行时，不要求用户手动 `pip install` 或寻找 package 安装目录。
2. 用一个现代、轻量、Python-native、可微的结构仿真后端替换当前 simulation stub。V1 选择 **torch-fem**。
3. 把仿真作为现有 CAD workflow 中的横向 engineering capability，而不是新增一个顶层 `simulation` workflow，也不要新增一串 `analysis_setup / analysis_run / analysis_review` phase。
4. 对高要求、明确带物理约束、engineering/release maturity 的设计，允许 Agent 显式声明“当前 candidate 需要 simulation evidence”，Harness 只负责强制 current-version evidence closure。
5. 增加可选的 differentiable optimization 能力。优化 inner loop 由 deterministic backend 执行，Agent 负责定义目标、约束、设计域以及解释结果。
6. 修复 Release Engineering 路径，使 Release 可以“发现工程问题 → 修改 candidate → 自动 build/inspect → simulate → 再 audit”，而不是只会 audit/package。

必须继续遵守 Pi-CAD 已冻结的五条原则：

> Tools expose reality.  
> Agent interprets reality.  
> Workflow defines process.  
> Harness enforces workflow.  
> Skills improve reasoning.

---

# 1. 当前架构基线

当前 Pi-CAD 已经完成以下正确抽象，本次不要推翻：

```text
Design Project
├── persistent Project Head
│   ├── source
│   ├── STEP artifact
│   ├── hashes
│   └── accepted evidence refs
│
└── Workflow Runs
    ├── greenfield
    ├── modify
    ├── analyze
    ├── release
    └── ...
```

正常稳定态：

```text
project.json.currentRunId = null
```

Agent 收到新请求后：

```text
User request
→ Agent semantic routing
→ cad_route(...)
→ Harness creates Workflow Run
```

不要重新引入“一个目录一个 task”或“用户管理 task id”的模型。

---

# 2. 现有 Analysis 概念必须保留原义

当前代码里已有三个名字容易混淆的概念。

## 2.1 `analyze` workflow

用户意图级 workflow：

```text
Requirements
→ Baseline
→ Investigate
→ Explain
→ Ready
```

含义：

> 用户要诊断、解释、测量、分析现有 CAD。

它是 read-only workflow。

未来允许在 `investigate` 中调用 `cad_simulate`，但仍然禁止 CAD mutation。

## 2.2 `domain_analysis` phase

Greenfield 的 pre-CAD reasoning phase：

```text
Concept
↔ Domain Analysis
→ Intent
→ Build
```

含义：

> 在正式建模前回答架构级工程问题、数量级、解析模型、物理可行性。

例如：

- 行星减速器齿数比例是否合理；
- 热负荷数量级；
- 喷管是否可能 choke；
- 机构自由度/运动学。

**不要把 torch-fem 塞进 `domain_analysis` 的定义里。**

`domain_analysis` 是 pre-CAD engineering reasoning。

## 2.3 Release 的 `engineering_analysis` workstream

这是 release completeness 的一个状态项，不是 phase。

它表示：

```text
engineering_analysis:
  open | complete | not_applicable | blocked_external
```

未来真实 simulation evidence 可以用于 Agent 将其判断为 `complete`。

Harness 不判断结果是否“安全”。

---

# 3. 核心设计结论

## 3.1 不新增顶层 Simulation Workflow

禁止新增：

```text
quick
modify
greenfield
release
simulation   # NO
```

仿真是横向 capability。

## 3.2 不新增 Analysis 子状态机

不要增加：

```text
analysis_setup
analysis_run
analysis_review
optimization
```

这些会把当前已经收敛的状态机重新搞厚。

正确方式：

```text
Review / Investigate / Audit / Gap Closure
        │
        ├── cad_simulate
        ├── cad_optimize
        ├── cad_measure
        └── cad_inspect_*
```

调用 capability 本身不触发 phase transition。

Agent 解释结果后再决定原 workflow 的下一步。

---

# 4. Workflow 集成

## 4.1 Greenfield

保持：

```text
Requirements
→ Concept
↔ Domain Analysis
→ Intent
→ Build
→ Review
→ Ready
```

增强 `Review`：

```text
Review
├── inspect_visual
├── inspect_geometry
├── measure
├── cad_simulate
├── cad_optimize        # optional
│
├── revise              → Build
├── interface issue     → Intent
├── architecture issue  → Concept
└── accepted            → Ready
```

示例：

```text
Build candidate
→ cad_commit_candidate
→ Harness auto build + visual + geometry
→ Review
→ Agent decides structural evidence required
→ cad_simulate
→ Agent interprets fields
→ cad_optimize (optional)
→ revise
→ Build
→ cad_commit_candidate
→ Review
→ cad_simulate again
→ accepted
```

## 4.2 Modify

保持：

```text
Requirements
→ Baseline
→ Plan
→ Modify
→ Review
```

Review 新增：

```text
cad_simulate
cad_optimize
```

如果用户只改 logo/chamfer：

```text
simulation obligation = not_applicable
```

如果用户说：

> 减薄 40%，但刚度/承载能力不能下降。

Agent 应显式提交：

```text
simulation obligation = required
```

新的 candidate 没有 current-version simulation evidence 时不能 accept。

## 4.3 Analyze

保持 read-only：

```text
Baseline
→ Investigate
→ Explain
```

`Investigate` 允许：

```text
cad_simulate
```

不允许：

```text
cad_optimize   # 默认不开放
write/edit
cad_commit_candidate
```

## 4.4 Release

这是本次必须同时修的 P0 workflow bug。

目标：

```text
Requirements
→ Audit
→ Gap Closure
→ Audit
→ Package
→ Final Review
→ Ready
```

### AUDIT

read-only：

```text
inspect
measure
cad_simulate
drawing/BOM/evidence inspection
cad_commit_plan(workstream status)
```

回答：

> 缺什么？

### GAP_CLOSURE

productive / writable：

```text
edit/write model source
cad_commit_candidate
cad_simulate
cad_optimize
generate drawing/BOM/etc.
```

回答：

> 把能补的工程缺口补掉。

### FINAL_REVIEW

read-only：

```text
artifact_issue     → Package
engineering_issue  → Gap Closure
accepted           → Ready
```

---

# 5. Release WorkflowSpec 修改要求

Release 至少应支持：

```ts
sourcePhases: ["gap_closure"]
candidateReviewPhase: "audit"
```

Mutation policy：

```ts
mutationPolicies: {
  gap_closure: "allowed",
  package: "allowed",
}
```

原因：Release gap closure 不只修改 `.py` CAD source，还可能补 drawing、BOM、inspection plan、simulation spec、risk/configuration records。

---

# 6. Release tool availability

## `audit`

```text
read
grep
find
ls
bash (non-mutating)
cad_inspect_visual
cad_inspect_geometry
cad_inspect_section
cad_measure
cad_compare_geometry
cad_assembly_tree
cad_simulate
cad_commit_plan
cad_transition
cad_wait_for_user
```

## `gap_closure`

```text
read
grep
find
ls
bash
edit
write

all relevant CAD capabilities
cad_commit_candidate
cad_simulate
cad_optimize

cad_commit_plan
cad_transition
cad_wait_for_user
```

---

# 7. Simulation backend V1

V1 只实现：

```text
TorchFemBackend
```

不要继续让 CalculiX 成为默认 runtime。

后续：

```text
SimulationBackend
├── TorchFemBackend   # V1 default
├── CalculixBackend   # future compatibility/cross-check
├── FeaxBackend       # future
└── WarpBackend       # future
```

---

# 8. Device abstraction

定义：

```text
auto
cpu
cuda
mps
```

V1 策略：

```text
auto:
  CUDA available → cuda
  else MPS available → mps
  else → cpu
```

禁止 silent fallback。

每次执行必须记录 backend、requestedDevice、actualDevice、dtype、fallbackReason。

MPS V1 定位：

```text
experimental acceleration
```

CPU/CUDA 为 first-class。

---

# 9. Package 安装与依赖管理

## 9.1 目标安装 UX

Fresh machine：

```bash
pi install <pi-cad-package>
```

然后直接：

```bash
cd any-project
pi
```

用户不应再手动：

```bash
pip install ...
bash scripts/bootstrap-python.sh
which gmsh
which ccx
```

## 9.2 安装路径

新增：

```text
scripts/postinstall.mjs
```

`package.json`：

```json
{
  "scripts": {
    "postinstall": "node scripts/postinstall.mjs"
  }
}
```

不要以 Bash-only script 作为唯一安装入口。

## 9.3 Python environment

优先：

```text
uv
```

fallback：

```text
python -m venv
pip
```

建议使用 package-local：

```text
<pi-cad-package>/.venv/
```

## 9.4 Requirements 分层

```text
python/
├── requirements-core.txt
├── requirements-simulation.txt
└── requirements-dev.txt
```

Core：

```text
build123d
numpy
pillow
```

Simulation：

```text
torch
torch-fem
gmsh
meshio
pyvista
```

如果默认注册 `cad_simulate`，其 runtime dependency 必须默认安装。

---

# 10. `cadctl doctor`

新增：

```bash
cadctl doctor --json
```

必须报告 Pi-CAD 实际执行环境。

示例：

```json
{
  "python": "/.../pi-cad/.venv/bin/python",
  "packageVersion": "0.6.0",
  "capabilities": {
    "geometry": { "status": "ready" },
    "simulation": {
      "status": "ready",
      "backend": "torch-fem",
      "devices": {
        "cpu": true,
        "cuda": true,
        "mps": false
      }
    },
    "differentiableOptimization": {
      "status": "ready",
      "modes": ["topology"]
    }
  }
}
```

Pi extension startup probe 一次，缓存 report。

禁止让 Agent 再通过 `which ...` / `python -c ...` 猜 capability。

---

# 11. `cad_simulate` Tool

替换当前 simulation stub。

输入建议：

```json
{
  "artifact": "build/bracket.step",
  "backend": "torch-fem",
  "device": "auto",
  "physics": {
    "type": "linear_elasticity"
  },
  "materials": [],
  "loads": [],
  "constraints": [],
  "mesh": {
    "element": "tet",
    "size": 2.0
  }
}
```

输出包含：

```text
backend
device
dtype
mesh stats
displacement/stress/strain/reaction fields
max scalar metrics
solver iterations/residual
result artifacts
```

禁止输出：

```text
safe = true
design_good = true
passes_requirement = true
```

Agent 负责解释。

---

# 12. Meshing

V1：

```text
STEP
→ gmsh Python API
→ tetrahedral mesh
→ torch-fem
```

Simulation result 必须记录 STEP hash、mesh spec、mesh hash、backend version、device、dtype、solver settings。

---

# 13. Evidence obligations

这是状态机唯一需要新增的核心机制。

V1 可只实现 simulation：

```ts
type EvidenceDisposition =
  | "required"
  | "optional"
  | "not_applicable"
  | "blocked_external";

interface EvidenceObligations {
  simulation?: {
    disposition: EvidenceDisposition;
    rationale?: string;
  };
}
```

Agent 在 Requirements / Plan / Audit 显式提交。

Harness 不自动判断。

---

# 14. Prompt policy

Requirements prompt 增加：

> Identify whether the requested maturity and explicit physics constraints require engineering simulation evidence.  
> Do not require simulation ceremonially.  
> If strength, stiffness, thermal, flow, dynamics, or another quantitative physical behavior materially determines acceptance, record the relevant evidence obligation as required.  
> If the decision can be made without simulation at the current maturity, use optional or not_applicable.  
> Missing external loads/materials/BCs should become blocked_external rather than invented.

---

# 15. Acceptance guard

如果：

```text
simulation.disposition == required
```

则 `cad_transition(accepted)` 必须检查 currentArtifactHash 对应的 current-version simulation evidence。

如果 CAD 改了：

```text
Candidate A
→ simulation A
→ edit source
→ Candidate B
→ simulation A stale
```

Candidate B 未重新仿真则不能 accepted。

Harness 只检查 evidence closure，不判断仿真数值是否满足要求。

---

# 16. Release `engineering_analysis` workstream

该 workstream 不应由 Harness 自动改成 complete。

Agent 在 Audit 看完 current simulation evidence 后决定：

```text
complete
not_applicable
blocked_external
```

---

# 17. Differentiable Optimization

## 17.1 定位

可微优化是 Review / Gap Closure 中的可选 capability。

不是必经步骤，也不是状态。

正常路径：

```text
simulate
→ Agent interprets
→ manually revise CAD
```

只有适合时：

```text
cad_optimize
```

## 17.2 重要边界：不要宣称 STEP 可微

禁止：

```text
STEP
→ autograd
→ ∂J/∂STEP
```

V1 可微变量限制在 FE-native differentiable design variables。

优先：

```text
fixed mesh topology density field ρ
```

---

# 18. `cad_optimize` Tool

V1 先只做 topology optimization。

输入：

```json
{
  "simulationSpec": "...",
  "mode": "topology",
  "designDomain": {},
  "frozenRegions": [],
  "objective": {
    "type": "compliance",
    "sense": "minimize"
  },
  "constraints": [
    {
      "type": "volume_fraction",
      "max": 0.4
    }
  ],
  "optimizer": {
    "type": "mma",
    "maxIterations": 100
  }
}
```

输出：

```text
iterations
objective history
constraint history
best objective
density field
surface mesh
gradient field
```

Tool 不判断结果是不是“好设计”。

---

# 19. Optimization 结果绝不能直接更新 Project Head

Hard rule：

```text
cad_optimize
→ density / surface / gradients
→ Agent interprets
→ Agent reconstructs or modifies build123d CAD
→ cad_commit_candidate
→ Harness build + visual + geometry
→ cad_simulate current candidate
→ Review
→ accepted
→ Project Head update
```

只有 canonical candidate acceptance 可以修改 Project Head。

---

# 20. Evidence kinds

建议增加：

```text
optimization
```

作为 provenance evidence。

但 optimization evidence 不能替代 simulation evidence。

最终优化过的 CAD 必须重新 simulation。

---

# 21. Tool availability matrix

| Phase | cad_simulate | cad_optimize |
|---|---:|---:|
| requirements | no | no |
| concept | no | no |
| domain_analysis | optional only if explicit model exists | no |
| build | no | no |
| review | yes | yes |
| baseline | no | no |
| investigate | yes | no |
| explain | no | no |
| plan | no | no |
| modify | no | no |
| audit | yes | no |
| gap_closure | yes | yes |
| package | no | no |
| final_review | yes | no |
| ready | optional re-check | no |

---

# 22. `cad_commit_candidate` genericization

Tool prompt 不应再写：

```text
Only call from build, modify, or convert.
```

改为：

> Call only when the current workflow exposes `cad_commit_candidate` as an active control action.

是否合法由 WorkflowSpec `sourcePhases` 决定。

---

# 23. Release compare behavior

Release gap closure 修改 CAD 后必须有 deterministic regression comparison：

```text
Project Head / run baseline
vs
Release candidate
```

`cad_commit_candidate` auto-action 对 Release 也应：

```text
build
→ inspect_visual
→ inspect_geometry
→ compare baseline/head vs candidate
→ Audit
```

---

# 24. Project Head 更新

如果 Release 在 Gap Closure 真正修改并接受了新 engineering candidate：

```text
accepted release candidate
→ new Project Head
```

否则会出现 Project Head 仍是旧 prototype，而 release package 已是新 geometry。

---

# 25. 实现顺序

## Phase A — Installer / Doctor

```text
cross-platform postinstall
package-local Python runtime
torch-fem deps
cadctl doctor
device detection
```

验收：

```text
fresh install
→ no manual pip
→ simulation status ready
```

## Phase B — Real torch-fem Simulation

Walking skeleton：

```text
cantilever beam
→ mesh
→ torch-fem solve
→ displacement/stress
```

用解析解或可信 reference 校验误差。

## Phase C — `cad_simulate`

接入 Pi tool，产出 deterministic envelope 和 run-scoped simulation evidence。

## Phase D — Workflow / Evidence Obligation

实现 simulation obligation、current-version evidence guard、tool availability。

接入 Greenfield Review、Modify Review、Analyze Investigate、Release Audit/Gap Closure/Final Review。

## Phase E — Release engineering loop

```text
Audit
→ Gap Closure writable
→ cad_commit_candidate
→ auto build/inspect/compare
→ Audit
```

## Phase F — Differentiable topology optimization

```text
MBB beam
density field
SIMP
filter
autograd
MMA
```

验证 autograd gradient 与 finite difference spot-check 一致。

## Phase G — CAD reconstruction journey

证明 optimization result 不直接成为 Project Head，而是经 Agent 重建 CAD、commit、simulate、accept。

---

# 26. Walking Skeleton 1 — Simulation

输入：

> Build a cantilever beam 100×10×10 mm, one end fixed, 100 N tip load, isotropic linear elastic material.

必须证明：

```text
CAD
→ STEP
→ mesh
→ torch-fem
→ displacement
→ stress
→ current simulation evidence
```

检查 CPU、CUDA、MPS/fallback、device/version provenance。

---

# 27. Walking Skeleton 2 — Workflow integration

用户：

> 设计一个承受 1000 N 的支架，要求安全系数 2，并尽量减轻重量。

预期：

```text
Greenfield
→ Requirements
  Agent marks simulation required
→ Concept
→ Intent
→ Build
→ Review
→ cad_simulate
→ Agent interprets
→ revise
→ Build
→ Review
→ cad_simulate
→ accepted
```

Harness 必须阻止 required simulation 未闭环时 accepted。

---

# 28. Walking Skeleton 3 — Differentiable optimization

第一版：

```text
MBB beam fixed FE domain
→ topology density ρ
→ torch-fem
→ compliance
→ autograd
→ MMA
→ optimized density
```

输出 objective/volume history、gradient、density、surface。

不自动更新 Project Head。

---

# 29. Cross-platform acceptance matrix

最低：

```text
Linux CPU       required
Windows CPU     required
macOS CPU       required

Linux CUDA      required when hardware available

macOS MPS       experimental:
                supported subset OR explicit CPU fallback
```

禁止 silent fallback。

---

# 30. Non-goals for 0.6

不要做：

- nonlinear contact；
- full plasticity validation suite；
- CFD；
- thermal-fluid coupling；
- Code_Aster integration；
- differentiable B-Rep；
- direct STEP gradients；
- automatic CAD reconstruction from topology result；
- universal physics verifier；
- Agent inside optimizer inner loop；
- new top-level simulation workflow；
- new analysis phase state machine。

---

# 31. File-level work plan

建议新增/修改：

```text
package.json
scripts/postinstall.mjs

python/
├── requirements-core.txt
├── requirements-simulation.txt
└── cadctl/
    ├── doctor.py
    ├── simulation/
    │   ├── base.py
    │   ├── torch_fem_backend.py
    │   ├── mesh.py
    │   ├── result.py
    │   └── topology.py
    └── cli.py

src/
├── shared/protocol.ts
├── extensions/simulation/
├── core/evidence.ts
├── core/policies.ts
├── core/controller.ts
├── workflows/greenfield.ts
├── workflows/modify.ts
├── workflows/release.ts
└── prompts/
    ├── requirements.md
    ├── review.md
    ├── investigate.md
    ├── audit.md
    └── gap_closure.md
```

---

# 32. Definition of Done

0.6 同时满足以下条件才算完成：

1. `pi install` 后无需用户手动 pip/venv/bootstrap。
2. `cadctl doctor` 能报告 Pi-CAD 真实 Python、torch-fem、设备和 capability。
3. 当前 simulation stub 被真实 `cad_simulate` 取代。
4. simulation tool 只返回事实，不判断设计安全。
5. Greenfield/Modify 可以将 simulation 声明为 required evidence。
6. current candidate 变更后旧 simulation evidence 自动 stale。
7. simulation required 时，没有 current-version simulation evidence 无法 accept。
8. Analyze workflow 可以 read-only 调 simulation。
9. Release Audit 可以运行 simulation。
10. Release Gap Closure 可以修改 CAD、commit candidate、simulate 并回 Audit。
11. Release engineering change 不再要求用户手动改 mutationPolicy。
12. `cad_optimize` 存在，并实现至少一个真实 differentiable topology optimization walking skeleton。
13. optimizer inner loop 不调用 LLM。
14. optimization result 不直接更新 Project Head。
15. 优化结果落实为 CAD 后必须重新走 canonical candidate + simulation。
16. CPU cross-platform 可运行；CUDA 正常；MPS 明确支持范围或明确 fallback。
17. backend/device/version/mesh/spec/artifact hash 都进入 evidence provenance。
18. 现有 Project + Workflow Run 架构保持不变。

---

# 33. 一句话目标

Pi-CAD 0.6 不应该变成：

> “又多了一个 FEA 工具。”

而应该变成：

> **Agent 能在现有工程 workflow 中主动获取真实物理证据，并在适合的连续设计空间内调用可微优化器；Harness 只负责确保这些证据属于当前设计版本并在需要时真正闭环。**

最终主循环：

```text
User intent
→ Agent design
→ CAD candidate
→ deterministic observation
→ optional deterministic simulation
→ optional differentiable optimization
→ Agent interpretation
→ CAD revision
→ current-version simulation
→ acceptance
→ Project Head
```
