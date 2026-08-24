# Harness Kernel v7 对照验收

日期：2026-08-24

分支：`codex/harness-kernel-v7`

基线：`refactor/runtime-v2@ccd6b28`

## 基线与优先级

本验收按以下顺序解释需求：

1. 用户最终明确的五项协议与“复杂领域工具 Recipe 化”；
2. 仓库根 `PLAN.md`；
3. `pi-cad-harness-kernel-refactoring-whitepaper-v0.1.md` 的架构原则。

白皮书把 Drawing / Presentation / Optimization Recipe 化留作后续；最终计划明确将其纳入本次重构。实现采用最终计划：Simulation、Optimization、Drawing、Presentation、analysis-model derivation 共用统一 YAML Recipe Kernel，MODEL 与 PROBE 保持 primitives。

## 逐项结果

| 验收项 | 结果 | 实现/门禁 |
| --- | --- | --- |
| 独立开发边界 | 通过 | 独立 branch/worktree；原 `refactor/runtime-v2` 工作树未用于实现写入 |
| Generic Kernel 无机械 ontology | 通过 | `src/harness/**` 静态边界测试禁止 Mechanical route/phase/evidence 语义和 Domain Pack 依赖 |
| Mechanical Pack 所有权 | 通过 | route/reroute、26 route workflow adapter、records、hooks、providers、review profile、workstreams 位于 `src/domains/mechanical/**` |
| Configurable Workflow | 通过 | strict YAML、任意 phase string、引用验证、可达性、write-scope 上限、authority 防自授予、canonical snapshot/hash |
| Registry Contract pinning | 通过 | 9 类 Registry；schema/semantics digest；旧 run restore 对缺失/漂移 fail closed，仅接受显式 compatibility |
| Obligation binding | 通过 | Recipe prepare 显式冻结 obligation/workflow/Registry/phase；commit 不接受新 obligation；stale/other/duplicate fail closed |
| Required Recipe outputs | 通过 | obligation 可声明 `requiredOutputs`；prepare 必须请求；observer 必须产出每个显式请求输出，包括 non-primary |
| Transaction protocol | 通过 | staged immutable payload、manifest、commit、单 HEAD、fsync、CAS、幂等 materialization/journal recovery、fault injection |
| Context pure projection | 通过 | Provider 只拿受限 snapshot reader；无 cwd/fs/process/store mutation；逐 provider metrics 和 byte budgets |
| Prompt fast path | 通过 | 10k events/refs/observations 与 1000 reviews/runs 压测；无 migration/qualification/process；30 次 warm p95 门禁 250 ms |
| Linux/WSL boundary | 通过 | Windows-host bridge、`wsl.exe`、PowerShell/path translation 被移除；统一 Linux process runner |
| Recipe security | 通过 | project confinement、symlink/overlap rejection、preflight→freeze TOCTOU、immutable compute/input、observer-only repair、runtime recheck、timeout/output/quota/network cap |
| 领域 Recipe 化 | 通过 | 五类 Recipe kinds、通用 runner/observer/result adapter；drawing/presentation/analysis/optimization package templates；全部 6 个结构/热流体 skill 模板和 2 个 benchmark 模板有原生 `pi-recipe.yaml` |
| MODEL / PROBE 保留 | 通过 | real build123d/cadctl walking skeleton；typed/programmatic read-only PROBE 未被强制 Recipe 化 |
| Candidate lifecycle | 通过 | candidate freeze 后由 Mechanical hooks 生成 visual/geometry/assembly/interference/compare；新 candidate 使旧 evidence stale |
| Fresh Reviewer | 通过 | generic runner + Mechanical profile；fresh extension-free session、只读 probe allowlist、budget/timeout、结构化 fail closed；accepted 复验 subject/contract hash |
| Project Head | 通过 | run closure 与 Project Head 分离；完成后单 project transaction 发布；abort 不移动 Head |
| v6/v7 coexistence | 通过 | 新 work 默认 v7；active v6 始终由 v6 完成/abort，不自动迁移；显式 v6 fallback 有 deprecation warning |
| 26 route equivalence | 通过（结构） | 26/26 normalized workflow hash、transition graph、phase grants 与 v6 golden 对照；release/assembly/requirements/reroute 门禁回归通过 |
| Packaging | 通过 | `npm pack --dry-run` 包含 Registry Contract、Recipe Kernel、Domain Pack、package recipes 与 skill/benchmark YAML Recipes |
| Full regression | 通过 | AgentContract drift check；TypeScript 230/230；Python 82 passed、7 skipped；walking skeleton 使用真实 build123d/cadctl |

## 五项用户协议

1. **Evidence 关闭对象**：`RecipeObligationBindingV7` 在 compute 前写死 exact obligation，commit 只能使用 run 内 binding。
2. **原子落盘**：每个 generation 以 transaction directory + commit + 单 HEAD 为可见性协议；views 和 JSONL 都是可恢复派生物。
3. **解释代码冻结**：run 同时 pin workflow snapshot 和 Registry Contract；restore 不兼容时 fail closed。
4. **纯 Context Provider**：provider 只能读取注册的 bounded projection，并输出 duration/read/emitted/cache/truncation metrics。
5. **route 所有权**：Kernel 只提供 workflow replacement；Mechanical Pack 的 Agent-facing route/reroute action 解释领域参数。

## 有意保留的兼容层

- `pi-sim.toml` 只读 adapter 暂时保留给 active v6 和旧项目输入；所有仓库内置模板已有 YAML 版本。adapter 在 v6 退役窗口结束后删除。
- `cad_recall_observation` 仍存在于 v6 工具面以保证 active v6 行为不变；v7 grant/overlay 不暴露它，v7 直接读取 immutable observation files + bounded index。
- v6 Core 保留到一个 minor release、至少 30 天及两轮发布 benchmark 完成；这是迁移策略，不是 v7 Kernel 依赖。

## 发布前的外部/时间门禁

以下不是本地代码门禁，不能由一次仓库回归替代：

- 在隔离、已认证的 Pi/CADTestBench 环境连续运行两轮 `refactor-50`，确认 exact pass 最多下降一个 case、无 safety/authority 回归、median token/wall time 不恶化超过 10%；
- 观察一个 minor release / 至少 30 天的 v6 运维回退窗口，再删除 v6 engine、TOML adapter 和 v6-only recall tool。

在上述发布门禁完成前，代码可以合并为 v7 实现，但不应宣称已经满足“删除全部兼容层”的下一 breaking release 条件。
