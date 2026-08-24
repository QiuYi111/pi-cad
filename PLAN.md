# Pi-CAD Harness Kernel v7 重构计划

## 1. 目标与不可变决策

Pi-CAD 在同一仓库内重写通用 Harness Kernel。机械工程流程迁移到 Mechanical Domain Pack；现有 MODEL、PROBE 和 Python CAD/solver backend 保留；复杂领域执行统一为 Recipe；prompt 热路径只投影冻结状态。

- 开发分支：`codex/harness-kernel-v7`，基于 `refactor/runtime-v2` 的 `ccd6b28`。
- 正式运行环境仅为 Linux，或 Windows 用户在 WSL 内运行完整 Pi Agent、Pi-CAD、Node、uv/Python 和 solver runtime。
- 删除 Windows Node 调用 `wsl.exe`、PowerShell、drive mapping 和跨宿主 path translation。
- Workflow 使用 YAML 源文件，run 只执行经过校验、规范化和哈希的 immutable JSON snapshot。
- 新 run 在 26 条默认机械 route、Recipe 迁移和全部门禁通过后直接默认 v7。
- active v6 run 不自动迁移，由 legacy engine 完成或中止；terminal history 保持可读。
- SIMULATE、OPTIMIZE、DRAWING、PRESENTATION 和 analysis-model derivation Recipe 化；MODEL 和 PROBE 保持类型化安全原语。
- 首版 Recipe 来源只有内置 Domain Pack 和项目本地文件，不加载第三方可执行 Recipe 包。

## 2. 分层架构

```text
User / Project Configuration
  └── pi-cad.yaml

Domain Packs
  └── Mechanical Pack
      ├── route ontology / workflow factory
      ├── workflows / records / hooks
      ├── context providers / review profiles
      └── Recipe kinds and templates

Generic Harness Kernel
  ├── workflow loader/compiler/snapshot
  ├── reducer/transition/authority/invalidation
  ├── registries and permission engine
  ├── transactional snapshot store
  ├── bounded context compiler
  └── Recipe execution kernel

Capability Runtime
  ├── MODEL
  ├── PROBE
  ├── managed Recipe runtimes
  └── Python cadctl / solvers
```

`src/harness/**` 不得出现 `Route`、`greenfield`、`legacy`、`assembly`、`manufacturing`、具体机械 phase 或 evidence 语义。机械知识只能存在于 `src/domains/mechanical/**`。

## 3. Workflow 与 Registry 协议

### 3.1 项目选择与启动

项目根可由用户提供：

```yaml
schema: 1
workflow:
  source: builtin:mechanical/intake@1
  parameters: {}
```

- 文件名固定为 `pi-cad.yaml`；缺省时使用 `builtin:mechanical/intake@1`。
- `source` 只能是已注册 built-in ID，或项目根内的相对 YAML 路径。
- absolute path、`..` escape 和 symlink escape 必须拒绝。
- Agent 对 `pi-cad.yaml` 只读；配置变化只影响下一次 run。
- `cad_start({ reason })` 读取用户选择、编译 workflow、pin Registry Contract 并原子创建 v7 run。
- 默认 Mechanical intake 中，`cad_route`/`cad_reroute` 是 Mechanical Pack 注册的 Agent-facing action；它们调用 Kernel-owned `workflow_replace` transaction，不在 Generic Kernel 中解释 route。

Generic Kernel action 保持小而通用：

```text
cad_start
workflow_replace
transition
commit_record
commit_evidence
finish
```

Mechanical Pack 负责：

```text
cad_route
cad_reroute
mechanical records / obligations / review profile
```

### 3.2 Workflow Definition

`WorkflowDefinitionV1` 包含：

- `schema`、`id`、`version`、parameters schema、`initialPhase`；
- 任意 string phase ID；
- 每个 phase 的 purpose、actions、grants、write scopes、record/evidence obligations、context providers、review profile 和 transitions；
- registered hook、action、grant、record、evidence、provider 和 reviewer 引用。

Workflow YAML 不允许任意代码或表达式。编译器必须验证：

- 所有引用已注册且版本兼容；
- initial phase、transition target 和 terminal phase 可达；
- record/evidence obligation 存在合法 closure action；
- write scope 不超过对应 grant 的 Kernel 上限；
- authority-protected transition 无法由 workflow 自行授予 authority；
- normalized output 可使用 canonical JSON 稳定哈希。

run 保存 immutable `workflow.json`。route/reroute 不修改原 snapshot，而是生成 successor snapshot，并在 state 中记录 replacement reason、authority、predecessor hash 和 successor hash。

### 3.3 Registry Contract pinning

冻结 YAML 不足以冻结运行语义。每个 run 必须同时保存 `registry-contract.json`：

```ts
interface RegistryContractV1 {
  schema: 1;
  kernelProtocol: string;
  hash: string;
  actions: Record<string, ContractEntry>;
  grants: Record<string, ContractEntry>;
  hooks: Record<string, ContractEntry>;
  contextProviders: Record<string, ContractEntry>;
  reviewProfiles: Record<string, ContractEntry>;
  recordTypes: Record<string, ContractEntry>;
  evidenceTypes: Record<string, ContractEntry>;
  recipeKinds: Record<string, ContractEntry>;
  runtimeProfiles: Record<string, ContractEntry>;
}

interface ContractEntry {
  version: string;
  schemaDigest: string;
  semanticsDigest: string;
}
```

最低 pinning 内容：

- action input/output schema 和 mutation classification；
- grant 的 permission meaning、write boundary 和安全上限；
- hook/reviewer/provider 的版本与实现语义 digest；
- record/evidence schema 与 freshness规则；
- Recipe kind contract；
- runtime profile identity 和 qualification manifest schema。

`semanticsDigest` 由 registration 中显式、稳定、可审查的 contract descriptor 计算，不能依赖打包后源码路径或构建时间。它表示兼容语义版本，不试图哈希任意 JavaScript 闭包。

恢复旧 run 时：

1. 读取 pinned Registry Contract；
2. 与当前 Registry 的 schema/semantics digest 比较；
3. exact/declared-compatible 才允许运行；
4. 缺失或不兼容时进入 `blocked_external` 并列出具体 Registry ID；
5. 禁止静默使用新版语义；兼容升级必须由显式 compatibility table 或 migration 声明。

## 4. v7 State、Evidence 与事务协议

### 4.1 Run State

```ts
interface HarnessRunStateV7 {
  schemaVersion: 7;
  kernelVersion: "v7";
  runId: string;
  projectId: string;
  workflow: {
    id: string;
    version: string;
    hash: string;
    snapshotPath: string;
    registryContractHash: string;
    parameters: Record<string, unknown>;
    history: WorkflowReplacementRef[];
  };
  phase: string;
  status: string;
  interactionMode: "interactive" | "headless";
  records: Record<string, RecordRef>;
  artifacts: Record<string, ArtifactRef>;
  evidence: EvidenceRef[];
  staleEvidence: EvidenceRef[];
  authorities: AuthorityRef[];
  blocker?: BlockerRef;
  latestReview?: ReviewRef;
  contextRefs?: Record<string, string>;
  domainMetadata?: Record<string, unknown>;
}
```

Snapshot/index 是在线查询源；JSONL 只承担审计：

```text
.pi-cad/
├── project.json
├── cache/runtimes/*.json
└── runs/<runId>/
    ├── HEAD
    ├── state.json
    ├── workflow.json
    ├── registry-contract.json
    ├── indexes/*.json
    ├── context/frame.json
    ├── records/
    ├── evidence/
    ├── transactions/
    └── events.jsonl
```

### 4.2 Evidence obligation binding

任何 Recipe run 在执行前必须绑定它可能关闭的 obligation，禁止从 Recipe 名、输出内容或 Agent 描述推断。

```ts
interface RecipeRunRecord {
  runId: string;
  recipeKind: string;
  obligationRef?: string;
  workflowHash: string;
  registryContractHash: string;
  phaseAtPrepare: string;
  computeIdentity: string;
  // runtime/input/recipe/observation provenance...
}
```

对于 Simulation：

```ts
cad_simulate({
  recipe: string,
  obligationRef: string,
  outputs?: string[]
})

cad_commit_simulation({ run: string, observation: string })
```

规则：

- `obligationRef` 必须由调用方从 Current Action Card 当前列出的 unmet simulation obligations 中显式选择；只有唯一一个合法 obligation 时工具层才可无歧义自动填入，并仍写入 run record。
- prepare 时验证 obligation 存在、当前未满足、phase/action 允许此 Recipe kind，并将 obligation、workflow hash、Registry Contract hash 一起冻结。
- commit 只能关闭 run 预绑定的 obligation，不接受新的 obligation 参数。
- workflow replacement、requirements revision 或 evidence invalidation 后，如果 obligation 不存在、版本变化或已经 stale，commit 必须 fail closed。
- 一个 Recipe run 只能产生针对该 obligation 的一次有效 commit；重复 commit 必须幂等返回原 Evidence ref，不能关闭第二个 obligation。
- 非 Evidence 型 Recipe 可以没有 `obligationRef`；其 RecipeKind contract 必须明确结果只可生成 Artifact/Record/Observation。

### 4.3 Transaction protocol

跨文件 mutation 使用 staged transaction + 单一 canonical pointer，不假设多个 `rename()` 组成事务。

```text
runs/<runId>/transactions/<tx-id>/
├── manifest.json
├── state.json
├── workflow.json?
├── registry-contract.json?
├── indexes/<name>.json
├── records/<...>
├── evidence/<...>
├── event.json
└── commit.json
```

提交协议：

1. 在 transaction staging 中写完所有 immutable payload，逐项记录 path、size 和 SHA-256；
2. `fsync` payload 和 transaction directory；
3. 最后写并 `fsync` `commit.json`，其中包含 tx ID、parent generation、next generation 和 manifest hash；
4. 通过同目录临时文件 + atomic rename 只替换一个 canonical `HEAD` pointer；
5. loader 读取 `HEAD` 指向的 committed generation，绝不拼装半 materialized canonical 文件；
6. state/index/record/evidence 的便捷 canonical 路径只作为可重建 materialized view，不作为 commit point；
7. 更新 HEAD 后可同步或后台 materialize views；失败不改变已提交真相；
8. event journal 由 committed transaction 派生并幂等追加，重复恢复不得重复 event；
9. transaction 使用 parent generation 做 compare-and-swap；并发 writer 冲突必须重读并重试 reducer，禁止 last-writer-wins。

恢复协议：

- 无 `commit.json` 的 staging transaction 可安全清理；
- 有 commit 但未被 HEAD 引用的 transaction 视为未提交，不自动推进；
- HEAD 已引用但 views/event 尚未 materialize 时，按 hash 幂等恢复；
- HEAD、commit 或 payload hash 不一致时 fail closed 并提供只读 doctor/rebuild；
- ordinary prompt 只读取 HEAD 和其 generation snapshot，不执行恢复；恢复发生在显式 project-open maintenance、mutating command 或 doctor。

project head promotion 使用相同 generation/CAS 模型，确保 run closure 与 Project Head 更新不会出现可见的中间状态。

## 5. Context Fast Path 协议

`before_agent_start` 只能通过受限接口读取冻结投影：

```ts
interface ContextSnapshotReader {
  readProject(): Promise<ProjectProjection>;
  readState(): Promise<StateProjection | null>;
  readWorkflow(): Promise<WorkflowProjection | null>;
  readRegistryContract(): Promise<RegistryProjection | null>;
  readIndex(name: RegisteredIndexName): Promise<unknown>;
  readContextFrame(): Promise<ContextFrame | null>;
}

interface ContextProviderContract {
  id: string;
  version: string;
  maxBytesRead: number;
  maxBytesEmitted: number;
  render(reader: ContextSnapshotReader): Promise<ContextFragment>;
}
```

- Provider 不接收 `cwd`、普通 `fs`、process runner、runtime resolver 或 Store mutation API。
- reader 只开放已注册的小型 snapshot/index；路径和单次读取大小由 reader 控制。
- Provider 不能请求 JSONL、任意目录或未注册文件。
- waiting-user 恢复移到 Pi `input` event，以一次 bounded reducer transaction 完成；`before_agent_start` 保持纯读取。
- runtime availability 只读取持久化 `ready | unavailable | unknown` manifest；qualification 发生在首次实际调用或显式 doctor。

每次 projection 记录：

```ts
interface ContextProviderMetrics {
  providerId: string;
  durationMs: number;
  bytesRead: number;
  bytesEmitted: number;
  cacheHit: boolean;
  truncated: boolean;
}
```

metrics 写入进程内 ring buffer 或 prompt 完成后的异步诊断，不在热路径追加 journal。测试必须直接断言：

```text
childProcessCalls === 0
recursiveScans === 0
jsonlFullReads === 0
migrationCalls === 0
runtimeQualificationCalls === 0
bytesRead <= aggregate provider budget
```

warm Linux/WSL project 下，30 次普通 prompt startup 的 p95 必须不超过 250 ms。

## 6. Recipe 平台

新 Recipe 放在 `recipes/<kind>/<name>/pi-recipe.yaml`，包含：

- schema、ID、version 和 opaque Recipe kind；
- registered runtime profile；
- project-relative typed inputs 及 role；
- recipe-relative argv-form named actions；
- 独立 observer program/files；
- typed exports、primary outputs；
- timeout、CPU、memory 和 workspace quota 请求，最终受 Kernel cap 约束。

生命周期：

1. 校验 manifest 和 RecipeKind contract；
2. canonicalize 路径并拒绝 escape/symlink escape；
3. 绑定合法 obligation（如该 Recipe kind 可产生 Evidence）；
4. 原子冻结 compute closure、inputs、workflow/Registry/runtime identity；
5. 只从冻结 workspace 执行；
6. observer 生成 immutable ObservationSnapshot；
7. Domain adapter 将结果映射为 Artifact、Record 或 Evidence。

Recipe 不能声明 grant、authority、Evidence kind 或 Project Head promotion。observer 可独立修复和重跑，但 compute hash、input hash、runtime digest 或 obligation identity 变化时必须创建新 run。

v7 保留领域工具名，但参数改为 Recipe-first：

```text
cad_simulate({ recipe, obligationRef, outputs? })
cad_sim_observe({ run, outputs? })
cad_commit_simulation({ run, observation })
cad_optimize({ recipe, outputs? })
cad_generate_drawing({ recipe, stage })
cad_render_scene({ recipe, stage, outputs? })
cad_derive_analysis_model({ recipe })
```

现有 `pi-sim.toml` 通过只读 adapter 编译成统一 Recipe definition；内置模板和 benchmark 全部迁移后删除 adapter。

## 7. 实施顺序

### Phase -1：独立分支、行为冻结与止血

- 建立 WSL 原生 Node/uv 测试环境和 Linux-only guard。
- 冻结 26 route golden、phase/grant matrix、state traces、AgentContract、CADTestBench 与性能基线。
- runtime qualification、migration、journal repair 和全量 context scan 移出 prompt 热路径。
- 建立统一 Linux process runner：timeout、AbortSignal、process group kill、输出上限、并发限制和 in-flight dedupe。
- 修复 Simulation Recipe root confinement 与 preflight→freeze TOCTOU。
- AgentContract drift check 接入 CI。

### Phase 1：Registries 与 Registry Contract

- 建立 Action、Grant、Record、Evidence、Context、Hook、Review、RecipeKind 和 Runtime Registries。
- 现有 v6 tool surface 通过 registration helper 接入，行为保持不变。
- 从 registrations 生成 AgentContract、cookbook catalog、tool group 和 Registry Contract。

### Phase 2：Workflow Definition 与 snapshots

- 实现 `pi-cad.yaml`、Workflow YAML schema、validator、compiler 和 canonical snapshot。
- 当前 mechanical route compiler 作为 adapter 输出 WorkflowDefinition。
- 对 26 route 做 normalized equivalence。

### Phase 3：Transactional v7 walking skeleton

- 实现 transaction store、crash recovery、generation/CAS 和 v6/v7 engine router。
- 实现 `cad_start`、v7 reducer、generic transition、authority、record/evidence closure 和 Project Head promotion。
- 贯通 `requirements → part_design → build → review → ready → done`。

### Phase 4：Permission Engine 与 Context Compiler

- tool overlay、tool-call guard、Action Card 和 write scope 改由 workflow snapshot + Registry Contract 驱动。
- Context Provider 全部迁移到 `ContextSnapshotReader`。
- 增量 compact、bounded indexes 和 provider metrics 落地。

### Phase 5：Mechanical Domain Pack

- 移出 route ontology/factory、default workflows、records、prompts、providers、hooks、review profile 和 release workstreams。
- `cad_route`/`cad_reroute` 改为 domain action + generic workflow replacement transaction。
- requirements revision 使用 generic dependency invalidation。

### Phase 6：Recipe Kernel

- 实现统一 YAML manifest、RecipeKind contract、obligation binding、freeze、runner、observer、provenance 和 domain result adapter。
- 先用现有 Simulation V2 做等价验证。

### Phase 7：领域 Recipe 迁移

- 依次迁移 Simulation、Optimization、Drawing、Presentation、analysis-model derivation。
- 每种能力迁移后更新 skill/cookbook/AgentContract，并运行 provenance、Observation 和 agent benchmark。
- MODEL build/export 与 PROBE presets 保持 primitives。

### Phase 8：完整机械流程、Reviewer 与 Observation

- 按 analyze、convert、legacy、hybrid、assembly、manufacturing、release 迁移全部 26 route。
- Fresh Reviewer 拆成 Generic Review Runner + Mechanical Review Profile。
- Observation 改为直接可读 immutable files + bounded index；通用读取可恢复图像后删除 `cad_recall_observation`。

### Phase 9：默认切换与 Legacy 退出

- 全部门禁通过后，新 run 默认 v7。
- `PI_CAD_KERNEL=v6` 只作为显式运维回退并打印 deprecation warning。
- 第一个 v7 release 继续执行 active v6；不创建自动迁移器。
- 回退保留一个 minor release、至少 30 天和两轮完整 benchmark；随后停止创建 v6 run。
- 下一 breaking release 删除 legacy engine，保留 terminal v6 history reader；active v6 fail closed，并要求使用旧版本完成或中止。

## 8. 测试与合并门禁

### Kernel / Workflow

- arbitrary phase ID、transition legality、grant/write enforcement；
- record/evidence obligation、invalidation、authority；
- workflow replacement history 与 snapshot immutability；
- Registry Contract compatible/incompatible restore；
- custom workflow 引用、路径、权限全部 fail closed。

### Transaction / Crash Recovery

- 在每一个 staging、fsync、commit、HEAD swap、materialization 和 journal append 边界注入 crash；
- loader 永远只能观察 parent 或 committed next generation；
- recovery 幂等，不重复 Evidence、Record、event 或 Project Head promotion；
- 并发 writer CAS 冲突不会丢失 mutation。

### Evidence binding

- 非法、已满足、stale 或其他 workflow 的 obligationRef 被拒绝；
- run 无法关闭未预绑定 obligation；
- requirements revision/reroute 后旧 run commit fail closed；
- 重复 commit 幂等且不能关闭第二个 case。

### Recipe security

- absolute path、`..`、symlink escape、freeze 后源替换；
- observer 越权、runtime mismatch、timeout、输出爆量、workspace quota；
- process tree termination、network denied、qualification dedupe；
- TOML adapter 与 YAML Recipe 的 compute/observation identity 等价。

### Context / Performance

- 10k events/refs/observations、1000 reviews/runs 和大型 runtime root；
- prompt path 的 process、migration、qualification、recursive scan 和 full JSONL read 均为零；
- provider metrics 与 aggregate byte budget 精确断言；
- warm prompt p95 ≤ 250 ms，compact 可取消。

### 行为与 Agent benchmark

- 26 route golden、Project Head atomicity、requirements revision、reroute authority、release suffix、review、Simulation provenance 全覆盖；
- TypeScript 与 Python full suite 在 Linux/WSL 执行，Python 使用 `uv run --offline --frozen --project python ...`；
- CADTestBench `refactor-50` 通过率最多下降一个 case，无 safety/authority 回归；
- median token 和 wall time 不恶化超过 10%；
- 连续两轮完整 CI + benchmark 通过后才允许默认切换。

## 9. 非目标

- 不新建仓库；
- 不重写 Python CAD/solver backend；
- 不把 MODEL、PROBE 强行 Recipe 化；
- 不支持 Windows-host Node；
- 不允许 workflow/Recipe 自定义权限含义；
- 不支持第三方可执行 Recipe 包或 workflow marketplace；
- 不支持 arbitrary-code workflow；
- 不自动迁移 active v6 state machine。
