# Pi-CAD 重构文档审阅与执行计划

审阅对象:

- `refactor/pi-cad-refactoring-whitepaper.md`(愿景/架构白皮书,下称"白皮书")
- `refactor/pi-cad-engineering-design-v2.md`(工程实施计划 v2,下称"v2")

审阅方式:逐条与当前代码库(`src/`、`python/cadctl/`、`tests/`、`benchmarks/`)核对后给出结论。

---

## 1. 与代码库核对的结果

文档对现状的判断基本属实,主要论断都能在代码中验证:

| 文档论断 | 核对结果 |
| --- | --- |
| "工具面随能力膨胀" | 属实。agent 可见 `cad_*` 工具约 30 个:11 个 control(`protocol.ts` `CONTROL_TOOLS`)+ 17 个 capability + `cad_probe_python`、`cad_derive_analysis_model`。其中约 10 个是 inspection/observation 变体(`cad_inspect_visual/geometry/surfaces/section`、`cad_measure`、`cad_compare_geometry`、`cad_assembly_tree`、`cad_inspect_interference`、`cad_scan_sections`、`cad_probe_python`) |
| "workflow 与后端耦合" | 属实。`src/shared/capability.ts` 直接 `execFile(python -m cadctl ...)`;extensions 层直接调用这些函数,无 ModelBackend 抽象 |
| "phase → 工具名清单硬编码" | 属实。`src/core/policies.ts` `toolsForPhaseBase()` 是一个巨型 switch,`REVIEW_TOOLS`/`COGNITIVE_TOOLS` 等清单重复罗列具体工具名——正是 v2 Phase 7 要替换的对象 |
| "observation 不是一等抽象" | 属实。后端输出以 `CadEventEnvelope`(wire format)直达 agent,无 visuals/headline/facts/diagnostics 的归一化分层 |
| 待保留文件存在且角色相符 | 属实。`state-machine.ts`(764 行)、`compiler.ts`(431)、`protocol.ts`(359)、`store.ts`(506)、`context-memory.ts`(681)均在,职责与文档描述一致 |

两个文档未提到、但对计划有利的事实:

1. **`cad_probe_python` 已落地**(最新提交 69225e8):可编程只读 B-Rep probe 已存在,是 PROBE 模块 Phase 3"programmable composition mode"的现成种子。
2. **`python/cadctl/` 本身已按能力分文件**(`probe.py`、`geometry.py`、`compare.py`、`section.py`、`interference.py`、`assembly.py`、`simulation/`…),与 PROBE/SIMULATE registry 的切分天然对齐,后端侧改动小。

---

## 2. 审阅意见

### 2.1 两文档之间的不一致

1. **路线图不匹配**:白皮书是 7 个 Phase, v2 是 Phase 0 + 8 个 Phase。v2 多出 Phase 0(行为冻结/golden tests)和 Phase 5(Model Backend Adapter),其后所有编号错位(白皮书 Phase 5 = v2 Phase 6,以此类推)。跟踪进度时必然混淆。建议:白皮书标注"vision doc,实施以 v2 为准",或直接对齐编号。
2. **SIMULATE preset 范围表述不一**:白皮书 §6 把 optimization 列为 SIMULATE preset;v2 §4.5 同样列出,但现有 `cad_optimize` 是独立工具且被策略明确排除在 source phases 之外(见 `policies.ts` 注释)。两文档都没说 `cad_optimize` 最终是折叠进 `cad_simulate` 还是保留独立。

### 2.2 设计层面的缺口

1. **30 个现有工具 → MODEL/PROBE/SIMULATE 的映射表缺失**。这是迁移计划最核心的一张表,但没有写。尤其以下工具在两份文档中都没有归属:
   - `cad_render_scene`、`cad_generate_drawing`(presentation/drawing 交付物生成)
   - `cad_export`
   - `cad_derive_analysis_model`(MODEL→SIMULATE 的桥梁,归 MODEL 还是 SIMULATE?)
   - `cad_optimize`
   
   这些本质是第四类能力——**交付物生成(deliverable/presentation)**,要么明确并入 MODEL,要么承认需要第四个模块,回避会导致 Phase 2/3 执行时临时决策。
2. **`CadEventEnvelope` 与 `ObservationBundle` 的关系未定义**。envelope 是 TS↔Python 的 wire format,已有 `BuildPayload/VisualPayload/GeometryPayload/MeasurePayload` 等类型。应明确:envelope 保持为进程间契约,bundle 是 agent 侧渲染层,envelope→bundle 的映射是 Observation Layer 的核心工作。否则 Phase 1 无从下手。
3. **ModelBackend 边界横跨 TS/Python 进程边界,但 v2 的文件计划只字未提 `python/cadctl/`**。真正的"backend adapter"是 TS 接口 + cadctl CLI 协议两层,新增 backend(如 CadQuery)时改哪层、加哪些 cadctl 子命令,需要写清楚。
4. **Context Runtime v2(Phase 8)没有存储治理**。observation index + visual retention 意味着图片/快照的持续累积,需要配额、去重(按 artifact hash)、清理策略,否则 `.pi-cad/` 会无限膨胀。

### 2.3 计划层面的缺口

1. **`src/prompts/`(28 个 phase prompt 文件)完全不在迁移计划内**。所有 prompt 都引用具体工具名(如 `cad_inspect_geometry`、`cad_measure`)。Phase 3 合并出 `cad_probe` 后,这些 prompt 必须同步重写——这是一块实打实的工作量和回归风险,计划里应当显式列为 Phase 3 的交付物。
2. **`src/core/controller.ts`(904 行,全库最大文件)不在文件计划的"保留"或"新增"任何一边**。Phase 4 拆 candidate finalizer、Phase 7 拆 control plane,动的正是它;`policies.ts`/`runtime.ts` 同样未被提及(Phase 7 替换的就是 `policies.ts` 的 `toolsForPhaseBase`)。§7 文件计划需要补这三项的去向。
3. **旧工具 wrapper 的退役策略缺失**。Phase 2 说"旧工具变 wrapper",但没说:wrapper 保几个版本、prompt 何时切换、`CAPABILITY_TOOLS` 常量何时收缩、切换期间 agent 同时看到新旧入口是否会困惑。建议 wrapper 保留期内在其 description 里标注 deprecated,并以 benchmark 对比决定删除时点。
4. **Phase 0 golden tests 范围未定义**。哪些 route、冻结哪些行为(route 编译产物?phase 转移矩阵?`toolsForPhase` 输出?commit 语义?)、快照存放路径、drift 如何评审,都需要在动手前定死,否则"行为冻结"不可验证。
5. **每阶段缺验收标准(DoD)与回滚手段**。v2 自称 engineering implementation plan,但只有 §8 的整体测试策略,没有逐阶段的"完成即验证"判据;也没有说明各阶段是否走 feature flag、出问题如何回退。每阶段应独立可合并、可回滚(这是 Phase 0 存在的意义,应贯彻到底)。
6. **风险最高的一步没有特殊对待**:Phase 3(unified `cad_probe`)同时改变工具 schema、全部 phase prompt、工具选择行为,是唯一可能造成 agent 能力回归的步骤,必须在前后各跑一次分层 benchmark(CADTestBench + 内部 stratified)对比,达标才允许删除旧入口。文档提到了 benchmark,但没有把它绑定到 Phase 3 的门禁上。
7. 小项:`refactor/` 下的 `:Zone.Identifier:` 文件是 Windows 下载残留,可删除。

### 2.4 总体评价

方向正确、分层合理(Control/Context/Observation/MODEL-PROBE-SIMULATE 的正交划分与代码中的真实痛点一一对应),v2 的阶段顺序(先冻结、先 observation、再合并 probe、再拆 backend、最后动 control plane)体现了正确的风险递增排序。主要问题是**作为"工程实施计划"颗粒度不足**:缺工具映射表、缺 prompt 迁移、缺 Python 侧边界、缺逐阶段 DoD。这些问题都可以在动工前补齐,不需要修改架构本身。

---

## 3. 修订后的执行计划

以下在 v2 的 Phase 0–8 基础上补齐缺口。顺序不变,每阶段附 DoD;除非注明,所有阶段保持"独立可合并、可回滚"。

### 前置:文档修订(半天)

- [ ] 白皮书标注"vision doc,编号与实施以 v2 为准"(或对齐两文档编号)。
- [ ] v2 §7 补:`controller.ts` → `src/control/control-engine.ts` 渐进迁移;`policies.ts`/`runtime.ts` → PhaseContract 数据源;`src/prompts/*` → Phase 3 交付物;`python/cadctl/` → backend adapter 的 Python 侧。
- [ ] v2 新增"现有工具 → 模块归属映射表",明确 `cad_render_scene`/`cad_generate_drawing`/`cad_export`/`cad_derive_analysis_model`/`cad_optimize` 的去处(建议:drawing/presentation/export 并入 MODEL 的 deliverable presets;`cad_derive_analysis_model` 归 SIMULATE 的 model-derivation preset;`cad_optimize` 折叠为 SIMULATE preset)。
- [ ] 明确 `CadEventEnvelope`(wire)与 `ObservationBundle`(agent 渲染)的分层关系。
- [ ] 删除 `:Zone.Identifier:` 残留文件。

### Phase 0:行为冻结(1–2 天)

- 定义 golden 范围并落盘:
  - 全部 route 的 `compileWorkflow()` 产物快照;
  - `toolsForPhase()` 对全部 phase 的输出矩阵(这也是 Phase 7 的等价性基准);
  - 状态机转移/acceptance/evidence 语义:以现有 `tests/state-machine.test.ts` 等为回归底线,补缺口;
  - 跑一次 CADTestBench + 内部分层 benchmark,归档基线结果。
- **DoD**:`scripts/test.sh` 全绿;golden 文件入库;benchmark 基线归档于 `benchmarks/results/`。

### Phase 1:Observation Layer(2–3 天)

- 新增 `src/observations/{bundle,renderer,profiles}.ts`;实现 envelope→bundle 映射(visuals/headline/facts/diagnostics/provenance/artifacts),visual-first 排序。
- 现有工具输出全部经 renderer 渲染,**工具名与 schema 不变**。
- **DoD**:observation 单测(视觉优先、稳定摘要、artifact 引用)通过;现有 TS 测试全绿(行为无变化)。

### Phase 2:Probe Registry(2–3 天)

- 新增 `src/modules/probe/registry.ts` + `presets/`,把 `capability.ts` 中 inspect/measure/section/compare/interference/assembly 实现迁入 presets。
- 旧工具改为调 registry 的薄 wrapper;agent 可见面完全不变。
- **DoD**:每个 preset 有 contract test(确定性输出、provenance、artifact 绑定);golden 对照无 diff。

### Phase 3:统一 `cad_probe`(3–5 天,含 prompt 重写 + benchmark 门禁)

- 新增 agent 工具 `cad_probe`:preset 模式 + programmable 模式(基于既有 `cad_probe_python` 收编);preset 保持轻 schema(枚举 + 少量参数)。
- `policies.ts` 各 phase 清单引入 `cad_probe`;**同步重写受影响的 phase prompts**;旧 inspection 工具降级为 deprecated wrapper(描述中标注)。
- 前后各跑一次分层 benchmark,成功率和 token 成本不劣化才继续。
- **DoD**:benchmark 达标;`cad_probe` 在全部 review/cognitive phase 可用;旧工具仅剩 wrapper;`CAPABILITY_TOOLS` 收缩完成或明确退役时间表。

### Phase 4:Candidate Finalizer(2 天)

- 从 `controller.ts` 拆出 candidate review 生命周期;引入 `CandidateProposal`;MODEL 执行与 acceptance 判定分离。
- `cad_commit_candidate` 行为逐字节兼容(golden 对照)。
- **DoD**:golden 无 diff;`workflows-full.test.ts` 全绿。

### Phase 5:ModelBackend 适配器(2–3 天)

- 定义 `ModelBackend` 接口 + build123d(cadctl)首个实现;workflow/extensions 只依赖接口。
- 同时在 v2 补记 cadctl CLI 侧的子命令契约为 backend 协议的一部分。
- **DoD**:新增一个 stub backend 的 contract test 通过;workflow 代码零 `execFile` 直调。

### Phase 6:SIMULATE 模块(3–4 天)

- 抽取共享生命周期 validate→freeze→execute→collect→observe→evidence;structural/flow/thermal 变为 adapters;`cad_derive_analysis_model`、`cad_optimize` 按 §3 前置映射表归位。
- **DoD**:三类仿真共享生命周期单测;仿真 evidence 语义与 Phase 0 golden 一致。

### Phase 7:PhaseContract 编译器(3–4 天)

- 引入 `src/control/phase-contract.ts`:phase → capability grants(替代工具名清单);`policies.ts` 的 switch 改为消费 contract 数据。
- **DoD**:**等价性测试**:contract 生成的每 phase 工具集与 Phase 0 golden 矩阵完全一致(差异需显式评审);control plane 对 build123d/cadctl 零 import。

### Phase 8:Context Runtime v2(3–5 天)

- observation index、visual retention(按 artifact hash 去重 + 配额 + 清理)、compaction 后的 visual rehydration。
- **DoD**:压缩后 agent 可按索引恢复关键视觉状态;`.pi-cad/` 存储有界;`context-memory.test.ts` 扩展通过。

### 里程碑与依赖

- Phase 1→2→3 严格串行(observation 是 probe 的前置);
- Phase 4、5 可并行;Phase 6 依赖 5;Phase 7 依赖 3(capability 词汇表先稳定);Phase 8 依赖 1。
- 总量级估算:文档修订 + Phase 0–8 约 4–6 周的单人全职等价工作量,其中 Phase 3 风险最高,预留 benchmark 回跑缓冲。
