# Pi-CAD Fresh Reviewer Gate 方案书

> 版本：v0.1  
> 目标：在不把 PROBE 做成 God Object、不破坏现有 CAD workflow/state architecture 的前提下，引入一个 **fresh、只读、visual-first、probe-enabled 的独立最终验收 Reviewer**，使 Pi-CAD 从“主 Agent 自审后声明完成”升级为“主 Agent 预注册验收意图 → 独立 Reviewer 黑盒验证 → Control Plane 决定是否允许完成”。

---

## 0. 执行摘要

Pi-CAD 当前已经具备四个重要基础能力：

1. **CAD-specific workflow / state control**：Route、Workflow Compiler、Phase、Obligation、Evidence Closure、Reroute Authority；
2. **Context Runtime**：Mission 重投影、Working Context、trajectory archive、compaction 与 continuation；
3. **Visual-first engineering observation 的雏形**：candidate commit 后自动生成视图，simulation/presentation 也能返回图像；
4. **逐步收敛的 capability surface**：MODEL / PROBE / SIMULATE，尤其 PROBE 已经证明可编程只读查询是有效能力。

最近两轮 regression 给出了一个很明确的信号：

- `probe-v1` 能被 Agent 正确使用，且没有明显滥用和回归；
- 但 Agent 即使拿到了正确的实测数据，仍可能把需求绑定到错误的几何 referent，或者直接把矛盾合理化；
- 因此当前最大的剩余问题已经不是“看不见”，而是“主 Agent 自己同时扮演设计者和验收者”。

典型失败模式：

```text
Must: final width = 0.52105
Measured bbox width = 0.260525

Main Agent:
"the reduction is consistent with the semicircular cut"
→ accepted
```

问题不在 Mission、不在 Context、不在 PROBE，也不在数字缺失；问题在于：

\[
	ext{Authoring Agent and Acceptance Judge are the same reasoning trajectory}
\]

本方案提出：

\[
	ext{Main Agent preregisters Assertions}
ightarrow
	ext{does design work}
ightarrow
	ext{claims completion}
ightarrow
	ext{Fresh Reviewer independently verifies}
ightarrow
	ext{Control Plane closes or rejects}
\]

核心边界：

- **Assertion 属于 Control / Specification**
- **Measurement strategy 属于 Reviewer**
- **Facts 属于 PROBE**
- **Pass / Fail 的流程效力属于 Harness**

Reviewer 不修改 CAD，不运行 MODEL，不修改 requirements，不使用 Bash，不继承主 Agent 的 reasoning trajectory，只能读取 canonical Mission / Assertions / current artifact / current evidence，并调用 `cad_probe` 做进一步测量。

这一设计带有明显的 TDD 味道，但不是传统“先写 executable unit test”，而是更适合 CAD 的：

> **Deferred-Execution CAD TDD**

即：

- 在建模前，定义**要验证什么**；
- 在建模后，由 fresh reviewer 根据真实 B-Rep 决定**怎么测**；
- 测量事实由 PROBE 提供；
- Harness 决定验证结果是否足以关闭 workflow。

---

# 1. 背景：为什么现在需要 Reviewer Gate

## 1.1 Pi-CAD 的优势从来不只是建模能力

Pi-CAD 相比普通 coding agent 的差异，不是“多几个 CAD API”。

真正有价值的是：

```text
用户意图
  ↓
Route
  ↓
Workflow Compiler
  ↓
Phase / State Machine
  ↓
Evidence / Artifact / Provenance
  ↓
Context Runtime
  ↓
Agent 在有限自由度下完成工程闭环
```

也就是说，Pi-CAD 的核心是：

> **把一个开放式机械设计任务变成一个受控、可追踪、可闭环的工程过程。**

MODEL、PROBE、SIMULATE 是执行能力。

Control Plane 决定：

- 什么时候允许写；
- 什么时候只能读；
- 什么 evidence 必须存在；
- 哪些记录必须完成；
- 哪些 reroute 可以自主发生；
- 什么条件下可以宣布任务完成。

Context Runtime 决定：

- Agent 每轮看到什么；
- 哪些任务事实长期保留；
- compaction 后如何恢复工程认知；
- 哪些视觉和证据仍然可追溯。

Reviewer Gate 应当成为 Control Plane 的自然延伸，而不是新的旁路系统。

---

## 1.2 `probe-v1` 已证明 observability 不再是唯一瓶颈

`probe-v1` mini-regression 的重要结论不是只翻正了 1 个样本，而是：

- 失败样本中多数真实使用了 probe；
- probe 被用于体积、shape factor、孔位、逐面分类、质量属性等复杂派生量；
- 对照样本没有无意义调用；
- 没有明显回归。

这说明：

> **programmable read-only PROBE 是正确的 deep module**

但同时出现了更深的问题：

```text
probe 输出：
hole center = -0.075
bbox center = 0

需求：
offset from bbox center = 0.15

主 Agent：
计算了 side clearance
→ 认为通过
```

也就是说：

```text
事实存在
≠
事实被绑定到正确 requirement
```

---

## 1.3 `refactor50` 暴露了更严重的“验收合理化”

`00006892` 的证据更加直接：

- Mission 没丢；
- compaction 没发生；
- bbox 实测值在 candidate digest 和 review observation 中都明确存在；
- 主 Agent 甚至在 acceptance note 中同时写出了目标值和错误实测值；
- 最后仍然合理化并接受。

因此不能再把 acceptance 设计为：

```text
Agent sees evidence
→ Agent writes note
→ Harness checks evidence exists
→ accepted
```

必须改成：

```text
Agent claims completion
→ Independent verification transaction
→ PASS 才能进入终态
```

---

# 2. 核心设计原则

## P1. Reviewer 是 Verifier，不是第二个 Designer

Reviewer 只回答：

> 当前 candidate 是否满足 preregistered Mission / Assertions？

Reviewer 不负责：

- 改 source；
- 重新建模；
- 调整 requirement；
- 修复问题；
- 生成新的工程方案。

FAIL 后，控制权回到主 Agent。

---

## P2. Fresh means intentionally forgetting the authoring trajectory

Reviewer 默认**不看**：

- 主 Agent 的完整对话；
- Working Context；
- acceptance note；
- 主 Agent 对几何的解释；
- 失败历史；
- source code。

Reviewer 只看：

- canonical Mission；
- Assertions；
- Assumptions / Open Unknowns；
- current candidate identity；
- primary visuals；
- deterministic digest；
- current evidence index；
- PROBE。

原因：

> Reviewer 应验证“最终零件是什么”，而不是理解“作者为什么这么做”。

---

## P3. Assertion 只描述测试意图，不描述 probe 实现

Assertion 不应该包含：

```text
selector = #c3
preset = measure
python = ...
```

这些是 candidate-specific 的。

在 CAD 中，一个孔最终是 `#c3` 还是 `#c7`，只有看到真实 B-Rep 后才知道。

Assertion 应描述：

```text
subject
reference
quantity
expected relation
```

例如：

```text
The primary mounting hole center shall be 0.15 mm from the overall body center along X.
```

Reviewer 再根据当前 artifact 用 PROBE 实现测量。

---

## P4. PROBE 永远只负责事实，不知道 pass/fail

PROBE 的职责保持极小：

> **Ask an arbitrary deterministic question about an immutable artifact**

它不理解：

- Mission；
- Assertion；
- Workflow；
- acceptance；
- pass/fail。

这样 PROBE 不会变成 God Object。

---

## P5. Harness 只做真正确定的 cheap deterministic checks

Harness 可以直接做：

- B-Rep validity；
- bbox；
- volume；
- surface area；
- solid count；
- occurrence count；
- cylinder count；
- 当前 artifact hash；
- evidence freshness。

Harness 不应该自己理解：

- “primary hole”；
- “appropriate edge”；
- “through hole”；
- “middle of the table leg”；
- “inset relative to hole edge”。

这些留给 Reviewer + PROBE。

---

## P6. Visual-first

机械设计 Reviewer 的初始认知顺序应该是：

```text
Mission + Assertions

[ISO]
[FRONT]
[TOP]
[RIGHT / SECTION if available]

Global Digest

Existing Evidence
```

不是先给 500 行 JSON。

对 simulation evidence 同样遵循：

```text
contour / deformation / field visual
→ convergence
→ statistics
→ full artifact refs
```

---

## P7. No evidence, no PASS

Reviewer 对每条 required Assertion 都必须给：

```text
verdict
evidence refs
finding
```

没有 evidence ref 的 PASS 是非法 ReviewResult。

---

# 3. 总体流程

```text
                      MAIN AGENT
                          │
                          ▼
                    REQUIREMENTS
                          │
                 Mission + Must[]
                          │
                 Assertions[] frozen
                          │
                          ▼
                       DESIGN
                          │
                   MODEL / PROBE
                          │
                          ▼
                      CANDIDATE
                          │
              auto visual + digest
                          │
                          ▼
                       REVIEW
                          │
           Main Agent认为任务已经完成
                          │
                          ▼
             cad_submit_for_review
                          │
             ┌────────────┴─────────────┐
             │ Harness Preflight        │
             │ - artifact current       │
             │ - required evidence      │
             │ - cheap global checks    │
             └────────────┬─────────────┘
                          │
                          ▼
              Fresh Reviewer Transaction
             ┌──────────────────────────┐
             │ Mission                  │
             │ Assertions               │
             │ Current visuals          │
             │ Digest                   │
             │ Existing evidence        │
             │                          │
             │ Allowed tool: cad_probe  │
             └────────────┬─────────────┘
                          │
                 ┌────────┴────────┐
                 │                 │
                PASS          FAIL/UNRESOLVED
                 │                 │
                 ▼                 ▼
               READY             REVIEW
                 │           reviewer report
                 ▼                 │
             cad_finish        Main Agent revises
                 │
                 ▼
                DONE
```

---

# 4. 是否新增 `verification` phase

## 推荐：MVP 不新增长期 phase

从 Control Plane 语义上，独立 verification 很像一个 phase。

但从现有仓库结构与实现成本看，第一版更适合做成：

> **bounded verification transaction inside `cad_submit_for_review`**

即：

- 调用前：state 仍在 `review` / `compare` / `final_review`；
- reviewer 运行期间：Main Agent 没有并发修改入口；
- PASS：Harness 执行原本进入 `ready` 的 transition；
- FAIL / UNRESOLVED：state 保持原 review phase；
- reviewer crash / timeout：state 不变，fail safe。

这样：

- 不需要马上扩充 `CadPhase`；
- 不需要增加 recovery phase；
- 不需要修改大量 workflow compiler tests；
- 不会破坏 release suffix；
- reviewer invocation 本身仍可 journal。

只有未来出现以下需求时，再升级为正式 `verification` phase：

- reviewer 异步运行；
- reviewer 需要跨进程恢复；
- reviewer 本身可能耗时数分钟以上；
- UI 需要显式展示 verification 状态；
- reviewer 需要多轮暂停/恢复。

---

# 5. Route / Workflow 集成

Reviewer Gate 不是每个 `accepted` 都触发。

它只守住：

> **进入 `ready` 的最终 closure edge**

## 5.1 Greenfield / Legacy / Hybrid Part

当前通常：

```text
review --accepted--> ready
```

改为：

```text
review --cad_submit_for_review--> reviewer
PASS → ready
FAIL → review
```

普通 `cad_transition(accepted)` 如果目标是 `ready`：

```text
BLOCK:
final acceptance requires cad_submit_for_review
```

---

## 5.2 Assembly

```text
integration_review → ready
```

同样由 Reviewer Gate 替代最终 accepted。

Reviewer initial context 应额外包含：

- assembly primary visual；
- assembly tree summary；
- interference evidence summary；
- 必要时 exploded / occurrence labels。

---

## 5.3 Release

Release 当前有：

```text
design review
→ audit
→ gap_closure
→ package
→ final_review
→ ready
```

只在：

```text
final_review → ready
```

这一条边上触发 Fresh Reviewer。

中间：

```text
review → audit
```

仍然属于工程流程内部 handoff，不触发最终 reviewer。

---

## 5.4 Manufacturing

如果最终 review 还要求 drawing evidence：

Harness preflight 继续先验证 drawing evidence 存在且 current。

Reviewer 可以读取：

- drawing preview；
- current candidate visual；
- assertion list。

但 Reviewer 不负责生成 drawing。

---

## 5.5 Convert

Convert：

```text
compare → ready
```

可以应用 Reviewer Gate。

Reviewer 输入：

- conversion requirements；
- baseline/current visuals；
- compare evidence；
- assertions；
- `cad_probe`。

---

## 5.6 Analyze

Analyze 不产生新的 CAD candidate。

第一版不接入 Fresh CAD Reviewer。

仍按现有：

```text
baseline → investigate → explain → ready
```

走 findings delivery closure。

---

# 6. Assertion 数据模型

## 6.1 目标

Assertion 是：

> **在开始实现之前，由主 Agent 对 hard requirement 做的结构化验收意图声明。**

不是 executable test。

不是 selector。

不是 Python。

不是 benchmark predicate。

---

## 6.2 推荐 schema

```ts
interface AcceptanceAssertion {
  id: string;

  /** 指向 CadRequirements.must 的稳定索引或 id */
  mustRef: string;

  /** 对用户要求的简洁重述 */
  statement: string;

  binding: {
    /** 被观察的工程对象，保持语义表达 */
    subject: string;

    /** 要测什么 */
    quantity: string;

    /** 可选：相对于什么 */
    reference?: string;

    /** 可选：方向/轴/局部方向 */
    direction?: string;
  };

  expectation:
    | {
        kind: "exact";
        value: number;
        unit?: string;
        tolerance?: number;
      }
    | {
        kind: "range";
        min?: number;
        max?: number;
        unit?: string;
      }
    | {
        kind: "boolean";
        expected: boolean;
      }
    | {
        kind: "relation";
        description: string;
      };

  /** 可选：允许 Harness 做 cheap deterministic preflight */
  canonicalCheck?: {
    field:
      | "bbox.x"
      | "bbox.y"
      | "bbox.z"
      | "volume"
      | "surfaceArea"
      | "solidCount"
      | "occurrenceCount"
      | "cylinderCount";
  };
}
```

---

## 6.3 为什么保留 `canonicalCheck`

Harness 不解析 `statement`。

只有主 Agent明确声明：

```text
这个 assertion 对应 bbox.y
```

Harness 才做 deterministic preflight。

例如：

```json
{
  "id": "A-width",
  "mustRef": "M2",
  "statement": "The final prism width is 0.52105 units.",
  "binding": {
    "subject": "final body",
    "quantity": "overall width",
    "direction": "Y"
  },
  "expectation": {
    "kind": "exact",
    "value": 0.52105,
    "tolerance": 0.0001
  },
  "canonicalCheck": {
    "field": "bbox.y"
  }
}
```

这样 `00006892` 在 reviewer 启动之前就会被免费挡住。

---

## 6.4 Assertion 必须 preregister

Assertion 必须与 requirements 一起 commit。

顺序：

```text
user requirement
→ cad_commit_requirements({
    must,
    assertions
  })
→ implementation
```

不能：

```text
candidate completed
→ write easy assertion
→ submit
```

---

## 6.5 Assertion 修订

如果 Reviewer 判断：

> Assertion 本身错误地解释了 Must。

它输出：

```text
binding_suspect
```

主 Agent 不能在 review 中直接偷偷改 Assertion。

需要一个显式 contract revision。

第一版推荐：

```text
Reviewer FAIL:
reason = assertion_binding_issue

→ 回到 requirements
→ re-commit requirements + assertions
```

更新 Assertion 后：

- requirements record hash 改变；
- 旧 reviewer report 自动 stale；
- 当前 candidate 可以保留为参考；
- 必须重新 submit。

不要允许“验收失败后只改测试不改流程”。

---

# 7. Harness Deterministic Preflight

在启动 Fresh Reviewer 前，Harness 先做所有它已经确定知道的事。

## 7.1 Artifact checks

复用现有：

```text
verifyCurrentArtifacts()
```

检查：

- source path；
- source hash；
- current artifact；
- artifact hash。

---

## 7.2 Evidence presence checks

复用现有：

```text
verifyEvidenceFilesForHash()
unmetSimulationCases()
presentation/drawing closure
```

Reviewer 不取代当前 EvidenceObligations。

如果当前 route 已经要求 simulation：

```text
simulation evidence missing
→ 不启动 reviewer
→ submit blocked
```

---

## 7.3 Canonical assertion checks

从当前 geometry digest 读取：

```text
bbox
volume
surfaceArea
solidCount
occurrenceCount
cylinderCount
```

对存在 `canonicalCheck` 的 Assertion 做 comparison。

输出：

```ts
interface PreflightAssertionResult {
  assertionId: string;
  field: string;
  expected: unknown;
  observed: unknown;
  pass: boolean;
  delta?: number;
}
```

若明确 FAIL：

```text
不启动 Reviewer
```

直接将 deterministic contradiction 返回给主 Agent。

原因：

> 能由 Harness 确定失败的东西，不需要花 reviewer token。

---

# 8. `cad_submit_for_review`

## 8.1 语义

工具含义：

> **主 Agent 声明：当前 candidate 已完成，申请独立最终验收。**

这不是：

```text
accept
```

而是：

```text
submit completion claim for independent verification
```

---

## 8.2 可用位置

工具只在：

```text
当前 phase 的 accepted target == ready
```

时显示。

例如：

```text
review
compare
integration_review
final_review
```

具体取决于 compiled workflow。

不需要在 `policies.ts` 重新 hardcode phase list。

未来应通过：

```text
compiledSpec.transitions[currentPhase].accepted === "ready"
```

动态判断。

---

## 8.3 参数

工具参数应该极少：

```ts
{
  summary?: string
}
```

甚至可以完全无参数。

不要要求主 Agent重新提交：

- checks；
- claimed values；
- justification。

因为这些正是我们希望移除的 author self-rationalization surface。

---

## 8.4 运行逻辑

```text
cad_submit_for_review
    ↓
load current state
    ↓
assert final-closure edge
    ↓
verify current artifacts
    ↓
verify evidence obligations
    ↓
run deterministic assertion preflight
    ↓
if fail:
    return structured contradiction
    keep state
    ↓
otherwise
    run FreshReviewer
    ↓
persist ReviewerReport
    ↓
PASS:
    execute original accepted transition
    ↓
FAIL/UNRESOLVED:
    stay in same phase
```

---

# 9. Fresh Reviewer Runtime

## 9.1 Reviewer 是一个 harness-owned bounded tool loop

不要把它做成：

- persistent second agent；
- nested workflow；
- context-memory agent；
- autonomous fixer。

它更像：

```text
fresh verifier invocation
+ restricted tool loop
+ strict final schema
```

---

## 9.2 输入内容

### System instruction

只描述 reviewer role：

```text
You are Pi-CAD's independent final verifier.

You did not author this design.
Do not defend the design.
Do not infer correctness from source intent.
Verify the final artifact against the canonical Mission and Assertions.

Resolve uncertainty by measurement using cad_probe.
Do not modify files, source, requirements, or state.

A PASS requires evidence.
If evidence is insufficient, return UNRESOLVED.
```

---

### Canonical Mission

来自：

```text
records/requirements.json
```

包含：

- goal；
- deliverables；
- Must；
- Assertions；
- assumptions；
- openUnknowns。

不要传 Working Context。

---

### Visuals

优先使用 candidate commit 已生成的 current visual evidence。

顺序推荐：

```text
iso
front
top
right
```

Assembly：

```text
iso
exploded/occurrence
front
top
```

不要默认重新 render，优先复用现有 hash-bound images。

---

### Digest

只给紧凑信息：

```text
bbox
volume
surface area
solid count
occurrence count
cylindrical face summary
current artifact hash prefix
```

---

### Existing Evidence Index

例如：

```text
visual current ✓
geometry current ✓
compare current ✓
simulation cases:
  load-case-1 ✓
drawing ✓
interference ✓
```

如果 simulation 有主要 visual：

优先附：

```text
stress contour
deformation
Mach
temperature
```

再给统计摘要。

---

## 9.3 Reviewer 不看什么

默认不传：

```text
models/*.py source
main agent conversation
working.md
main agent acceptance note
old reviewer argument
benchmark tests
```

如果 Reviewer 需要 source 才能理解设计：

原则上应该优先 PROBE 最终 artifact。

Source intent 不是 acceptance evidence。

---

# 10. Reviewer 工具权限

Reviewer 的唯一 CAD capability：

```text
cad_probe
```

不暴露：

```text
MODEL ❌
SIMULATE ❌
bash ❌
edit ❌
write ❌
cad_transition ❌
cad_commit_* ❌
cad_wait_for_user ❌
cad_finish ❌
```

Reviewer 不能改变世界。

---

# 11. 为什么 Reviewer 默认不能 SIMULATE

Simulation 是工程设计阶段应当生成的昂贵 evidence。

如果 requirement 需要：

```text
strength
temperature
flow
```

主 Agent 应在正式 submit 之前根据 `EvidenceObligation` 跑好。

Reviewer 只能：

- 看 simulation visual；
- 看 convergence/statistics；
- 检查现有 evidence；
- 用 PROBE 验证 geometry。

否则 Reviewer 会开始：

- 猜材料；
- 猜载荷；
- 猜边界条件；
- 建 analysis model。

这会从 verifier 重新变成 designer。

---

# 12. Reviewer 如何使用 PROBE

PROBE 仍然保持统一入口：

```text
cad_probe
```

支持：

```text
preset
programmable code
```

Reviewer 根据 Assertion 自己决定如何测。

例如 Assertion：

```text
A7:
primary mounting hole center shall be 0.15 mm from overall body center along X
```

Reviewer 可以：

```python
geom = preset("geometry")

# Inspect candidate-specific cylindrical surfaces
# Identify the primary mounting hole from geometry + visual context
# Compute body center and hole-axis center

result = {
    "body_center_x": ...,
    "hole_center_x": ...,
    "offset_x": ...
}
```

PROBE 返回 facts。

Reviewer 再判断：

```text
expected 0.150
observed 0.075
→ FAIL
```

PROBE 不需要知道 `A7`。

---

# 13. ReviewResult

## 13.1 Schema

```ts
interface FinalReviewResult {
  verdict: "pass" | "fail" | "unresolved";

  assertionChecks: Array<{
    assertionId: string;

    verdict:
      | "pass"
      | "fail"
      | "unresolved"
      | "binding_suspect";

    finding: string;

    evidenceRefs: string[];
  }>;

  semanticObjections: Array<{
    mustRef: string;
    type:
      | "contradiction"
      | "missing_evidence"
      | "binding_suspect"
      | "semantic_gap";

    finding: string;
    evidenceRefs: string[];

    suggestedProbe?: string;
  }>;

  summary: string;
}
```

---

## 13.2 Harness structural validation

Harness 不重新解释几何语义。

只验证：

### required Assertions 全出现

```text
assertion ids exact coverage
```

### PASS 必须有 evidence

```text
verdict=pass && evidenceRefs.length == 0
→ invalid reviewer output
```

### referenced probe observation 必须存在

```text
evidence ref unknown
→ invalid
```

### 任一 fail

```text
overall verdict cannot be pass
```

### 任一 unresolved

第一版：

```text
overall verdict = unresolved
```

不能默认为 pass。

---

# 14. Reviewer Budget

Reviewer 必须 bounded。

推荐初始配置：

```text
maxProbeCalls = 12
maxTurns = 16
wallTimeout = 120 s
noCompaction = true
```

模型：

```text
PI_CAD_REVIEWER_MODEL
PI_CAD_REVIEWER_REASONING
```

默认可以先与主模型相同，以减少模型差异变量。

之后再实验 luna low / medium 等更便宜 verifier。

---

# 15. PASS / FAIL / UNRESOLVED 行为

## PASS

要求：

```text
Harness preflight all pass
+
all Assertions reviewer PASS
+
no unresolved semantic objection
+
existing route closure satisfied
```

然后 Harness 执行原本：

```text
accepted → ready
```

保留当前 `cad_finish`：

```text
ready → done
```

第一版不要自动 finish，减少 state-machine 改动。

---

## FAIL

state 不变。

Reviewer report 写入：

```text
.pi-cad/runs/<runId>/reviews/
    review-001.json
```

主 Agent 下一轮收到：

```text
Independent final review FAILED

[relevant visuals if available]

A7 FAIL
expected ...
observed ...
evidence ...

A12 FAIL
...
```

然后自行 revise。

---

## UNRESOLVED

也不允许 ready。

例如：

```text
Requirement:
the bore shall be through

Reviewer:
current visual and geometry facts are insufficient;
section probe did not resolve because the B-Rep is ambiguous.
```

交回主 Agent。

主 Agent可以：

- 生成更好的 candidate；
- 通过 normal review 创建更多 evidence；
- 修正 assertion binding；
- 如果真的是 user-owned ambiguity，再 `cad_wait_for_user`。

Reviewer 自己不能 wait for user。

---

# 16. Reviewer Report 的版本绑定

每份 Reviewer Report 必须绑定：

```text
requirementsHash
assertionsHash
artifactHash
evidenceSnapshotHash
reviewerModel
reviewerPromptVersion
```

Candidate 一变：

```text
artifactHash changes
→ old PASS stale
```

Requirements / Assertion 一变：

```text
assertionsHash changes
→ old PASS stale
```

这样：

> **PASS 永远只属于一个明确的 contract × artifact version**

---

# 17. 与现有 Evidence 系统的关系

Reviewer Report 不应该直接伪装成：

```text
geometry evidence
simulation evidence
```

建议新增独立概念：

```text
FinalReviewRef
```

第一版推荐单独存：

```text
state.finalReview
```

避免把“原始 engineering evidence”和“对 evidence 的判断”混在一起。

推荐：

```ts
interface FinalReviewRef {
  path: string;
  sha256: string;
  artifactHash: string;
  requirementsHash: string;
  verdict: "pass" | "fail" | "unresolved";
  createdAt: string;
}
```

---

# 18. 对 Context Runtime 的要求

## 18.1 Reviewer 不使用 Working Context

这是刻意的 isolation boundary。

---

## 18.2 主 Agent 在 Reviewer FAIL 后必须看到 report

`before_agent_start` 的 task context 增加：

```text
## Latest independent review

status: FAIL
report: ...
blocking findings:
- ...
- ...
```

但只保留最近一次当前 candidate 对应的 report。

旧 reports 进入 archive/ref index。

---

## 18.3 Visual return

Reviewer FAIL 后，如果 report 引用某个关键 probe visual：

主 Agent下一轮应该优先看到：

```text
critical section / labeled visual
```

再看到文本 finding。

第一版可以直接把 reviewer tool result 中的相关 images 一起返回。

---

# 19. 与现有代码的落点

以下基于当前已检查的 `master` 代码结构以及 runtime-v2 regression 描述进行设计；`refactor/runtime-v2 @ 6d8612b` 尚未出现在远端仓库，因此落地时应以实际本地分支为准做路径微调。

## 19.1 `src/shared/protocol.ts`

新增：

```text
AcceptanceAssertion
AcceptanceContract
FinalReviewResult
FinalReviewRef
```

`CadRequirements` 增加：

```text
assertions
```

控制工具列表加入：

```text
cad_submit_for_review
```

不把 reviewer tool 作为普通 capability。

---

## 19.2 `src/core/controller.ts`

新增 control tool：

```text
cad_submit_for_review
```

负责：

```text
preflight
→ runFinalReviewer()
→ persist reviewer report
→ PASS 时执行 transition accepted
```

不要把 reviewer lifecycle 塞进 `state-machine.ts`。

---

## 19.3 `src/core/state-machine.ts`

尽量少改。

推荐：

```text
state-machine 仍是纯 process logic
controller enforce reviewer prerequisite
```

后续如果需要更强形式化，再把：

```text
finalReview required
```

升级成正式 closure guard。

---

## 19.4 `src/core/evidence.ts`

复用：

```text
verifyCurrentArtifacts
verifyEvidenceFilesForHash
```

可以新增：

```text
collectReviewerEvidenceIndex()
```

---

## 19.5 `src/core/auto-actions.ts`

无需重写 reviewer。

继续负责 candidate 的：

```text
build
visual
geometry
assembly/interference
compare
```

Reviewer 直接消费这些产物。

---

## 19.6 `src/core/context-memory.ts`

不参与 Reviewer 的 fresh context。

只增加：

```text
render latest current reviewer failure
```

Reviewer 本身不 compaction。

---

## 19.7 `src/core/policies.ts`

`cad_submit_for_review` 的 visibility 不 hardcode phase 名字。

新增类似：

```ts
finalSubmissionAllowed(state)
```

由 compiled transition target 判断。

---

## 19.8 PROBE implementation

不增加：

```text
assertion
requirement
pass/fail
```

PROBE 继续只提供：

```text
preset
program
facts
visual artifacts
```

这是最重要的架构边界之一。

---

# 20. Reviewer Runner 的实现方式

现有 `context-memory.ts` 已有 Harness 自己发起 fresh LLM invocation 的先例。

但 Reviewer 与 summarizer 不同：

> Reviewer 需要一个带 `cad_probe` 的 bounded tool loop。

因此应新增抽象：

```ts
interface ReviewerRunner {
  run(input: ReviewerInput): Promise<FinalReviewResult>;
}
```

先把 reviewer orchestration 与具体 Pi host API 隔离。

## 20.1 推荐实现优先级

### 方案 A：in-process fresh agent session

如果当前 `pi-coding-agent` host API 支持创建独立 session 并指定工具：

优先使用。

### 方案 B：Harness 自建 bounded model-tool loop

如果只有 `modelRegistry.complete()`：

```text
complete(messages, tools=[cad_probe schema])
→ tool call
→ execute probe
→ append result
→ complete
...
→ FinalReviewResult
```

### 方案 C：独立 pi subprocess

只在 host API 不支持工具型 fresh invocation 时使用。

不是首选。

---

# 21. Reviewer Prompt

建议单独版本化：

```text
src/prompts/final_verifier.md
```

核心内容：

```text
You are an independent CAD verifier.

You did not author this candidate.
Do not rationalize design intent.
Judge the final artifact, not the source plan.

For every preregistered Assertion:
1. identify what must be established;
2. use existing visual/evidence if sufficient;
3. otherwise use cad_probe to obtain deterministic facts;
4. return PASS only with concrete evidence;
5. return FAIL on contradiction;
6. return UNRESOLVED when evidence cannot establish the claim.

Do not modify the design.
Do not propose that an assertion is satisfied because the source intended it.
Do not accept prose as evidence.

If an Assertion appears to misrepresent its linked Must, mark binding_suspect.
```

---

# 22. Visual-first Observation Profile

Reviewer input profile：

```text
reviewer.final.default
```

Part：

```text
1. iso
2. front
3. top
4. right
5. compact geometry digest
```

Assembly：

```text
1. iso
2. occurrence/exploded
3. front
4. top
5. assembly/interference digest
```

Simulation-required：

```text
candidate visuals
+
primary simulation visual(s)
+
convergence summary
```

不要把所有 views 都一次塞进去。

Reviewer 可以再用 PROBE 请求 targeted view。

---

# 23. Anti-loop / Safety

Reviewer 不能死循环。

达到 budget：

```text
return UNRESOLVED
```

不要：

```text
cad_wait_for_user
```

不要自动 retry 第二个 reviewer。

Main Agent 修订后才能重新 submit。

---

# 24. 实验计划

## 24.1 第一阶段：机制 regression

### `00006892`

预期：

```text
Harness canonical preflight
bbox required 0.52105
observed 0.260525
→ BLOCK before reviewer
```

### `00670231`

预期：

```text
canonical preflight无法判断

Reviewer reads assertion:
offset from bbox center = 0.15

Reviewer PROBE:
body center
hole center
offset

observed 0.075
→ FAIL
```

这两个样本分别验证：

```text
cheap deterministic gate
fresh reviewer + probe referent binding
```

---

## 24.2 probe-regression-16

比较：

```text
before reviewer gate
vs
after reviewer gate
```

关注：

- exact flips；
- regressions；
- reviewer probe calls；
- false blocks；
- unresolved rate；
- wall time；
- token cost。

---

## 24.3 refactor50

等当前 50 样本完全结束并冻结结果后再进行。

不能在原运行过程中修改 `src/`。

---

## 24.4 新 hidden holdout

CADTestBench 当前 200 已经大量被用于开发分析。

最终泛化判断必须新建独立集。

---

# 25. Metrics

新增 Reviewer-specific metrics：

```text
submission_count
review_pass_rate
review_fail_rate
unresolved_rate

mean_probe_calls_per_review
median_reviewer_tokens
median_reviewer_wall_time

false_block_rate
regression_rate

fail_then_fix_rate
average_revision_cycles
```

特别关注：

> **Reviewer FAIL 后，主 Agent 是否能用 report 成功修复**

---

# 26. 测试计划

## 26.1 Control Tests

```text
1. final accepted edge cannot bypass cad_submit_for_review
2. intermediate accepted edge still works
3. PASS reviewer enables ready
4. FAIL reviewer keeps phase unchanged
5. UNRESOLVED keeps phase unchanged
6. reviewer crash keeps phase unchanged
7. artifact change stales previous PASS
8. requirements/assertion change stales previous PASS
9. release only gates final_review → ready
10. analyze route unaffected
```

---

## 26.2 Reviewer Output Validation

```text
1. every assertion must appear exactly once
2. PASS requires evidence ref
3. unknown evidence ref rejected
4. overall PASS impossible if any check FAIL
5. overall PASS impossible if any required check UNRESOLVED
6. malformed reviewer JSON rejected fail-closed
```

---

## 26.3 Probe Isolation

Reviewer 环境：

```text
cannot write source
cannot call bash
cannot call model
cannot simulate
cannot transition state
cannot read sibling benchmark files
```

---

## 26.4 Rationalization Regression

```text
Mission:
width = 10

Artifact digest:
width = 5

author note:
"the geometry is consistent"

Expected:
submission blocked
```

---

## 26.5 Wrong Referent Regression

```text
Assertion:
hole offset from body center = 10

candidate:
hole center offset = 5
side clearance = 10

Expected:
reviewer must not use side clearance as witness
```

---

# 27. 分阶段实施计划

## PR-1：Assertion Contract

改：

```text
protocol.ts
requirements schema
requirements prompt
tests
```

完成：

```text
Must → preregistered Assertions
```

不改 final acceptance。

---

## PR-2：Deterministic Preflight

新增：

```text
src/control/final-review/preflight.ts
```

支持 canonical global fields。

测试 `00006892` failure mechanism。

---

## PR-3：Reviewer Runner

新增：

```text
src/control/final-review/
  reviewer.ts
  types.ts
  prompt.ts
  evidence-index.ts
```

Fresh + visual-first + cad_probe-only。

---

## PR-4：`cad_submit_for_review`

接入 controller。

最终 `accepted → ready` 边改成 reviewer-gated。

---

## PR-5：Context / Observation Integration

Reviewer FAIL：

- persistence；
- latest report projection；
- relevant images；
- audit journal。

---

## PR-6：Regression

运行：

```text
mechanism tests
probe-regression-16
refactor50 paired regression
```

通过后才考虑默认开启。

---

# 28. Feature Flags

开发期：

```text
PI_CAD_FINAL_REVIEWER=1
PI_CAD_REVIEWER_MODEL=<model>
PI_CAD_REVIEWER_REASONING=medium
PI_CAD_REVIEWER_MAX_PROBES=12
PI_CAD_REVIEWER_TIMEOUT_MS=120000
```

稳定后：

```text
PI_CAD_FINAL_REVIEWER=1
```

变默认。

保留短期 rollback：

```text
PI_CAD_FINAL_REVIEWER=0
```

---

# 29. 明确不做什么

本轮不要：

```text
❌ 把 Assertion 编译成 probe selector
❌ 给 cad_probe 增加 requirement-aware API
❌ 做 universal geometry constraint DSL
❌ 让 reviewer 修改 CAD
❌ 让 reviewer 启动 simulation
❌ 让 reviewer继承 Working Context
❌ 让 reviewer看到主 Agent acceptance note
❌ 为 benchmark 特例硬编码规则
❌ 同时重构 MODEL backend
❌ 同时重写 entire state machine
```

这保证 reviewer gate 是一个清晰的 Control Plane 增量。

---

# 30. 成功标准

## Correctness

```text
明显矛盾不再被主 Agent合理化通过
```

## Independence

```text
Reviewer 不依赖 author trajectory
```

## Capability discipline

```text
Reviewer 只通过 PROBE 获得新的几何事实
```

## No God Object

```text
PROBE 不认识 Assertion / Mission / Pass / Fail
```

## Workflow integrity

```text
只有 Reviewer PASS 才能进入最终 ready
```

## Recoverability

```text
FAIL 后主 Agent 能明确知道哪里不满足并继续 revise
```

## Cost control

```text
Reviewer 是 bounded one-shot verifier，不是第二个长期 Agent
```

---

# 31. 最终架构语义

## Main Agent

```text
理解需求
→ 编译 Mission / Assertions
→ 设计
→ 建模
→ 自主使用 PROBE / SIMULATE
→ 声称完成
```

## Harness

```text
控制流程
→ 管理 canonical state
→ 管理 evidence/provenance
→ 做 cheap deterministic checks
→ 启动 independent verification
→ 决定是否允许完成
```

## PROBE

```text
回答关于 immutable artifact 的任意 deterministic 问题
```

## Reviewer

```text
独立验证 preregistered Assertions
→ 用 PROBE 将语义要求落实为 candidate-specific measurement
→ 输出 evidence-backed verdict
```

---

# 32. 核心结论

这个设计不是：

```text
再加一个 LLM reviewer
```

而是把 Pi-CAD 的 final closure 从：

```text
Self-asserted completion
```

升级成：

```text
Pre-registered verification intent
+
Independent black-box review
+
Evidence-backed closure
```

它保留了 Pi-CAD 最重要的设计哲学：

> **Control what must be proven, not how the Agent solves the problem.**

同时保持 deep module 边界：

```text
Assertion belongs to Specification
Measurement strategy belongs to Reviewer
Facts belong to PROBE
Completion authority belongs to Control Plane
```

这是一套比“把测试逻辑塞进 PROBE”更简单、也更可扩展的 CAD 验收架构。

它可以被理解为：

> **Deferred-Execution CAD TDD：先冻结验收意图，后根据真实设计生成测量方法，再由独立 Reviewer 完成最终验证。**

---

# 附录 A：当前 regression 给出的证据

## A.1 probe-v1

已观察到：

- programmable probe 被失败样本真实使用；
- 对照样本没有仪式性滥用；
- 主要用途集中在派生几何量；
- 存在“事实已测得，但 referent 绑定错误”的失败。

结论：

```text
PROBE 应保留并继续保持 requirement-agnostic。
```

## A.2 refactor50

已观察到：

- Mission 每回合从 canonical requirements 重投影；
- context compaction 不是特定失败的原因；
- Agent 在同一个 acceptance reasoning 中同时看到目标尺寸与错误实测尺寸；
- 仍然产生自洽性合理化并接受。

结论：

```text
最终验收不能继续依赖 author Agent 的解释性 note。
```

---

# 附录 B：实施前置条件

当前上传报告记录的 `refactor/runtime-v2 @ 6d8612b` 尚未出现在已连接的远端 GitHub 分支中。

正式施工前：

1. 等正在运行的 `refactor50` 完成；
2. 固化完整 report；
3. 推送 runtime-v2 当前实现；
4. 基于该 commit 创建 reviewer-gate 开发分支；
5. 先跑现有 tests，形成干净 baseline；
6. 再按 PR-1 → PR-6 顺序施工。

这样可以避免在旧 `master` 上重复实现已经存在于 runtime-v2 的 PROBE / Observation 重构。
