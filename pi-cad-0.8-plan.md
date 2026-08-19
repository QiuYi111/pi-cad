# Pi-CAD 0.8 实施计划

**主题:Physical Realizability + Workflow Compiler**(白皮书第 14 节)
**基线:0.7.2 · `c12c0fa` · 白皮书《Pi-CAD 0.7 → 0.8 架构与产品总结书》**

---

## 0. 总原则(白皮书冻结决定 → 实现约束)

| 白皮书决定 | 实现含义 |
|---|---|
| 删除 `quick` | fast path 只能由 compiler 从 route 推导,不存在 Agent 可选的捷径 |
| Route = objective × lineage × structure × maturity | `cad_route` 改为层次化描述,不再选 workflow enum |
| `concept` 不是 maturity | maturity enum 删除 `concept`/`review`,它们变成 phase |
| assembly 强制 `assembly_design → interface_design → part_design` | structure fragment 注入 phase + record 义务 |
| reroute 只增义务、不授进度 | obligation set 单调性 + harness 签发的 downgrade authority |
| assembly 必须有 interference observation | structure=assembly 自动注入 evidence obligation |
| canonical design 与 analysis model 分离 | simulation 以 authoritative design 为 subject,analysis model 只是 input |
| release presentation = Blender interpreter | preview → final 分阶段,manifest hash 绑定 |
| section 保持 explicit sensor | P2 只加 deterministic scan,不做 "critical section" 判断 |

**明确不做**(防止 scope 蔓延):新 solver、CHT、rotating machinery、combustion、GUI、多用户协作。

---

## 1. Milestone 1 — Route ontology + Workflow Compiler(P0)

### 1.1 数据模型

```ts
// src/shared/route.ts(新)
type Route =
  | { objective: "analyze" }
  | { objective: "convert" }
  | {
      objective: "design";
      lineage: "greenfield" | "legacy" | "hybrid";
      structure: "part" | "assembly";
      maturity: "prototype" | "engineering" | "manufacturing" | "release";
    };

// obligation key 是不透明字符串集合,单调性只做子集比较
type ObligationKey = string; // 如 "evidence:visual", "record:assembly_design",
                             // "workstream:bom", "presentation:exploded"
function obligationsOf(route: Route): Set<ObligationKey>;
```

`protocol.ts`:
- `ALL_WORKFLOWS`/`CadWorkflow` 删除(或仅留作 migration 类型);`CadRunState` 增加 `route?: Route`,`workflow` 字段废弃
- `CAD_STATE_SCHEMA_VERSION` 3 → 4
- maturity enum 从 `CadRequirements` 中改为引用 route 的 maturity(单一来源,requirements 里不再重复声明)
- 新 phase:`system_concept`、`assembly_design`、`interface_design`、`part_design`、`integration_review`;删除只属于 quick 的 `intent` 语义(greenfield part 用 `part_design` 替代 `intent`)

### 1.2 Compiler(保留现有执行引擎)

白皮书建议保留 `WorkflowSpec`/state-machine engine,只替换 definition mechanism。落地:

```ts
// src/workflows/compiler.ts(新)
interface CompiledProcess extends WorkflowSpec {
  route: Route;
  obligations: ObligationKey[];      // accepted/finish 之外的 record 级义务
  phaseRecords: Partial<Record<CadPhase, string>>; // 每个认知 phase 需要的 record 类型
}
function compileWorkflow(route: Route): CompiledProcess;
```

组合方式(白皮书 6.1):
- **lineage fragment**:`legacy` → `baseline → change plan`;`hybrid` → `baseline → concept`;`greenfield` → 无 baseline
- **structure fragment**:`assembly` → `system_concept → assembly_design → interface_design → part_design → build → integration_review`;`part` → `[concept]* → part_design → build → review`(`*` 仅当架构真正开放)
- **maturity overlay**:不复制流程,只叠加 obligations(见 M2)

Fast path 验证用例(白皮书 5.2):
```
design/greenfield/part/engineering
  → requirements → part_design → build → review        (4 个 phase,无概念探索)
design/greenfield/assembly/release
  → requirements → system_concept → assembly_design → interface_design
  → part_design → build → integration_review → …(release obligations)
```

### 1.3 `cad_route` V2

```
cad_route({ objective, lineage?, structure?, maturity?, reason })
```
- objective=analyze/convert 时其余字段省略;objective=design 时四元组必填
- 同一 turn 内完成层次判断(objective → lineage → structure → maturity),不逐项问用户
- 存量 state migration:schemaVersion<4 的 active run 直接 `aborted`(附 migration note 事件),project head 不动,要求重新 cad_route —— 避免 lossy 映射

### 1.4 触碰面

`state-machine.ts`(`workflowSpec()` → `compiledSpec(state.route)`)、`policies.ts`(`toolsForPhase` 覆盖新 phase:system_concept/assembly_design/interface_design = cognitive;part_design = plan 类;integration_review = review 类)、`context.ts`、7 个 workflow 文件删除并由 fragments 取代、全部引用 `state.workflow` 的 guard(auto-actions 的 compare 条件改用 lineage)。

**验收**(白皮书 15.1):
- 同一任务无法通过任何 route 选择绕过 obligations(不存在 quick 等价物)
- `greenfield/assembly/engineering` 不提交 assembly_design + interface_design record 就无法进入 build
- fast path:`part/engineering` 全约束任务流程长度 ≤ 4 phase

---

## 2. Milestone 2 — Maturity reality floor + Assembly fragments(P0)

### 2.1 Maturity → obligations(白皮书 3.1 / 6.1)

| maturity | 叠加的 obligation(在 structure 基础上) |
|---|---|
| prototype | assembly 时 `evidence:assembly_tree` + `evidence:interference`;physics 相关时 simulation obligation(现有机制) |
| engineering | + `record:interface_contracts`(A↔B:purpose/locating/DOF/fastener/fit/direction/tool access,白皮书 7.4 十项)+ 材料/关键尺寸 record |
| manufacturing | + `evidence:drawing`(现有 cad_generate_drawing)+ 制造定义 record |
| release | + 现有 9 个 release workstreams(机制平移到 maturity overlay)+ `presentation:*`(见 M4) |

- "Reality floor" 落在 **requirements prompt + skill**:物理 CAD 任务默认 REAL/BUILDABLE/FUNCTIONAL;只有用户显式要 mockup 时,Agent 必须把 maturity 降为 prototype 并在 assumptions 里记录用户授权 —— prompt 层规则 + obligations 层兜底(prototype 也有 interference/仿真义务,概念几何无处可逃)。
- `concept`/`review` 从 maturity enum 移除后,旧 requirements 里的 maturity 值在 migration 中映射为 `prototype` 并 warning。

### 2.2 新 phase prompts

`src/prompts/`:`system_concept.md`、`assembly_design.md`(白皮书 7.3 的四问)、`interface_design.md`(7.4 的 interface contract 模板)、`part_design.md`(由 interface contracts 反推零件)、`integration_review.md`(必须亲自看 visual/geometry/interference/simulation 证据)。

record 落盘走现有 `store.writeRecord` 机制 + 新 control tool:
```
cad_commit_assembly_design({ modules[], datums[], sequence[], envelopes[] })
cad_commit_interface_contracts({ contracts: A↔B[10 项] })
```
`phaseRecords` guard:进入 build 前检查对应 record 已提交。

**验收**:prototype 不再等于概念几何(maturity 改变 obligations 有测试);assembly design 十问/接口十项有 record 才能往下走。

---

## 3. Milestone 3 — Reroute + Interference(P0)

### 3.1 Reroute(白皮书 8)

新 tool `cad_reroute({ route, reason })`,三条硬约束的实现:

1. **obligation 单调性**:`obligationsOf(old) ⊆ obligationsOf(new)` → 自主允许;否则需要 authority。典型:part→assembly(结构信息增加)可自主;assembly→part、engineering→prototype 需要 authority。
2. **authority 由 harness 签发,不信 Agent 自述**:
   - downgrade 请求 → state 存 `pendingReroute` + `cad_wait_for_user`
   - 用户真实回复后(before_agent_start 的 resume 路径)harness 写入一次性 `rerouteAuthorityToken`
   - Agent 带 token 再调 `cad_reroute` 才生效;token 用后即焚
3. **不授予进度、不能指定 target phase**:reroute 后 compiler 重算流程,harness 取 **earliest unmet obligation/record/evidence** 对应的 phase;`cad_reroute` 无 targetPhase 参数。已在 BUILD 发现是 assembly → 回到 assembly_design,不是跳到 integration_review。

### 3.2 Interference interpreter(白皮书 9)

```
python/cadctl/interference.py
  pair 逐对:build123d/OCP common(布尔交集)→ intersectionVolume
            distance(无交时)→ minDistance
  AABB broad phase + exact narrow phase;输出 raw facts
CLI: cadctl inspect-interference --artifact ... 
TS tool: cad_inspect_interference({ artifact })
  → { pairs: [{a, b, intersectionVolume, minDistance, classification: penetration|contact|clearance}] }
  绝不输出 "fail" / "bad" —— Agent 自己解释(过盈配合 vs 穿模)
```

- evidence kind `"interference"` 加入 `EVIDENCE_KINDS`
- `runCandidateAuto` 注入(白皮书 9.3):structure=assembly 时 `build → visual → geometry → assembly_tree → interference → review`
- structure=assembly 的 compiled process 自动要求 current-version interference evidence;新 candidate 提交后自动 stale(现有 markEvidenceStale 机制天然覆盖)

**验收**(白皮书 15.2):构造明显穿模 STEP → integration_review 必须出现 interference evidence;intentional contact 只报 contact/volume/distance;新 candidate 后旧 interference evidence stale。

---

## 4. Milestone 4 — P1/P1/P2

### 4.1 Authoritative vs Analysis Model(P1,白皮书 10)

- simulation spec(flow/thermal/structural)增加显式 `analysisModel?: { source, operations: ["bonded"|"fused"|"simplified", ...] }`
- 规则:当求解输入是对 authoritative assembly 的 **改写**(fuse/bond)时,必须走 analysisModel 路径;canonical artifact 永远只是 `subjectArtifactHash`,analysis model 进 `inputArtifacts`
- 已有 `subjectArtifactHash`/`inputArtifacts`/`FrozenInputs` 直接支撑,主要是 schema + 校验 + prompt/skill 规则(禁止为 solver 改写设计本体)
- 轻量守护:`artifact` 与 project head 同 hash 且 spec 声明了 fused/bonded origin 而 analysisModel 未声明 → fail closed

### 4.2 Release Presentation v2(P1,白皮书 11)

- Blender 作为 optional pinned runtime(对齐 SU2 模式:`scripts/blender-manifest.json` + SHA256 + fail-soft + `PI_CAD_SKIP_BLENDER`/`PI_CAD_BLENDER_BIN`);体积大(~300MB),PATH 优先、下载可选
- presentation backend 补齐 interpreter:`validate → preview(5–10 关键帧)→ Agent inspect → final render → ffmpeg encode → verify`
- PresentationSpec 消费 Assembly Definition(sequence/directions/modules,来自 M2 的 assembly_design record)生成 exploded still + assembly animation + turntable
- release 固定目录:`hero.png / exploded.png / assembly.mp4 / turntable.mp4 / presentation.blend / manifest.json`;manifest 绑 subjectArtifactHash、specHash、Blender version、renderer、fps、resolution、输出 sha256
- maturity=release overlay 注入 `presentation:*` obligations;candidate 变化 presentation 自动 stale(白皮书 15.3)

### 4.3 Section analytics(P2,白皮书 12)

```
cad_scan_sections({ artifact, axis|path, count|step })
  → [{ position, area, centroid, Ix, Iy, Ixy, principalMoments, bbox, loopCount }]
```
只给事实,不返回 `critical_section=true`。build123d section + 面积/惯性矩计算;复用现有 section 代码路径。

---

## 5. 测试与验收矩阵(白皮书 15 全条目落为测试)

| 域 | 测试 |
|---|---|
| Router/Compiler | route→process 快照(含 fast path);quick 不存在;义务不可绕过 |
| Maturity | 同一 route 不同 maturity 的 obligations 集合单调递增;prototype 也强制 interference/仿真义务 |
| Assembly | 缺 assembly_design/interface_design record 时 build 被挡;record 提交后放行 |
| Reroute | 升级自主;降级无 token 被拒;有 token 成功且 token 一次性;reroute 后 phase = earliest unmet;无 targetPhase 参数 |
| Migration | schemaVersion 3→4:active run abort、head 保留、maturity 概念值映射 + warning |
| Interference | 穿模/contact/clearance 三态 fixture;assembly 自动注入;candidate 变更后 stale |
| Analysis model | fused 输入未声明 analysisModel → fail closed;evidence subject 正确 |
| Presentation | release closure 缺 exploded/animation/turntable 被阻塞(Blender 缺失时 skip);manifest hash 绑定 |
| Benchmark | jet-engine 场景升级为完整逆解闭环(白皮书 15.4) |

## 6. 实施顺序与依赖

```
M1 route+compiler+migration      ← 一切的地基(其余 milestone 都依赖 route)
M2 maturity floor + assembly fragments(+ prompts/records/guards)
M3 reroute(依赖 obligation set)+ interference(独立,可并行)
M4 analysis-model 分离 / presentation v2 / section scan
```

每个 milestone 独立可交付、全量测试绿后合入;M1 是唯一的 breaking change(schemaVersion 4),放在最前避免反复迁移。

## 7. 主要风险

| 风险 | 缓解 |
|---|---|
| CompiledProcess 与现有 7 workflow 的行为差异破坏存量测试 | M1 先做 compiler 输出与旧 spec 的等价性测试(analyze/convert/legacy 流程逐字段对比)再删除旧文件 |
| phase enum 膨胀导致 policies 遗漏 | `toolsForPhase` 改为按 phase 分类表(cognitive/source/review)驱动,新增 phase 声明类别即可 |
| reroute authority 的 UX 复杂度 | token 机制完全在 harness 内,state 可审计;prompt 明确两步流程 |
| Blender 体积/CI 时长 | PATH 优先 + 下载 fail-soft + CI 默认 `PI_CAD_SKIP_BLENDER`(presentation 测试 skip-gated,与 SU2 同模式) |
| fuse-检测的误报 | 4.1 只在 spec 自己声明 fused/bonded origin 时才强制 analysisModel,不做几何启发式猜测 |
