# Reify Chaos POC

最小可用的 Chaos 测试系统，用来发现 run / worker 这类系统级问题。
只做一条真实链路：

```
生成行为 → 注入故障 → invariant 失败 → 保存证据 → replay → shrink
```

不做 instruction-level 重放，不碰 hypervisor。

## 一条命令跑起来

```bash
npm install
npm run chaos:fetch-tools     # 下载真的 Toxiproxy 二进制（可选，不装就少外部故障）
npm run chaos:demo            # 看一条真实故障链
npm run chaos:run             # 随机生成 action/fault 序列并检查 invariant
```

`pnpm` 用法一样：`pnpm chaos:run`、`pnpm chaos:replay <artifact>`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run chaos:demo` | 跑固定故障链：建 run → 起 worker → kill worker → 系统恢复 → 注入外部 API 故障 |
| `npm run chaos:run -- --runs 20` | fast-check 随机生成序列，跑不通过就存 artifact |
| `npm run chaos:run -- --bug double-worker` | 植入已知 bug，检查 runner 能不能发现 |
| `npm run chaos:replay -- chaos/artifacts/xxx.json` | 用 artifact 里的序列重放 |
| `npm run chaos:replay -- <artifact> --seed` | 用 artifact 里的 seed 重放 |
| `npm run chaos:shrink -- <artifact>` | 重新 shrink，报告最小复现步数 |
| `npm run chaos:bugs` | 列出可植入的 bug |
| `npm run chaos:invariants` | 列出所有 invariant |

`chaos:run` 退出码：默认没发现问题 = 0，发现问题 = 1；带 `--bug` 时反过来，发现 bug = 0。

## 目录

```
chaos/
  actions/      用户/系统动作
  faults/       进程故障 + 外部依赖故障，以及注入/恢复运行时
  invariants/   不变量检查
  model/        fast-check 序列生成
  runner/       执行、artifact、replay、shrink
  sut/          被测系统（控制面 / worker / 假外部 API / Toxiproxy 客户端）
  artifacts/    失败证据（git 忽略）
```

## 被测系统

`chaos/sut/` 是一个真的多进程系统，形状和 Reify 的 run / worker 一致：

- `server.ts`：控制面。管 run 状态机和 worker 生命周期，有真崩溃检测和恢复。
  run 状态：`PENDING → STARTING → RUNNING → STOPPING → COMPLETED / FAILED / CANCELED`。
- `worker.ts`：真子进程。注册、心跳、调外部 API、提交副作用、正常退出或被杀。
- `upstream.ts`：假外部 API（LLM / OAuth 之类）。
- `toxiproxy.ts`：真的 Toxiproxy 客户端，外部故障走它。

worker 到外部 API 的流量走 Toxiproxy，所以外部故障是真的 TCP 层故障。

## 已实现的 invariant

| 名字 | 含义 |
| --- | --- |
| `worker-ownership` | active worker 必须是它 run 当前的 worker，归属不能串 |
| `worker-liveness` | 记录说在跑的 worker，进程必须真的活着 |
| `single-active-worker` | 同一个 run 同时最多一个 active worker |
| `terminal-state-stable` | terminal state 不能回到 RUNNING |
| `recovery-convergence` | 没有 live worker 的 run 不能一直停在 STARTING / RUNNING / STOPPING |
| `ui-backend-consistency` | UI 状态投影必须等于 backend 状态 |
| `no-duplicate-effects` | 同一个 step token 只能产生一次副作用 |
| `no-unexpected-runs` | backend 不能凭空多出 run |

## 可植入的 bug（自检用）

`--bug <name>` 会在 SUT 里打开一个已知缺陷，用来确认 runner 真的能发现它：

- `double-worker`：worker 崩了以后旧记录不清理 → `worker-ownership` / `worker-liveness`
- `stuck-recovery`：崩了以后不恢复也不收敛 → `recovery-convergence`
- `terminal-revert`：terminal run 被刷新后回到 RUNNING → `terminal-state-stable`
- `duplicate-effect`：同一个 token 重复记副作用 → `no-duplicate-effects`
- `stale-ui`：UI 状态投影不刷新 → `ui-backend-consistency`

## 失败证据（artifact）

失败时写 `chaos/artifacts/<时间>-<invariant>.json`，包含：

```
seed                          fast-check seed
replayPath                    fast-check counterexample path
originalSequence              第一次失败时的随机序列（shrink 前）
shrunkSequence                shrink 后的最小序列
replaySequence                实际复现用的序列
actionSequence / faultSequence 分开的动作和故障
apiRequests                   runner 发过的关键 API 请求
externalRequests              真打到外部 API 的请求（含 token）
ids                           project / run / worker ID
stateTimeline                 每步的 run / worker 状态变化
logs                          runner 记的备注（比如某个故障没打上）
invariant / detail            失败的 invariant 和细节
```

## 新增一个 Action

在 `chaos/actions/index.ts` 里加一个对象，然后放进 `actionDefinitions`：

```ts
export const archiveRun: ActionDefinition = {
  name: "archiveRun",
  description: "归档一个 run",
  arbitrary: runIndexParams(),                     // fast-check 生成参数
  describe: (params) => `archiveRun(run#${params.runIndex})`,
  run: async (ctx) => {
    const snapshot = await ctx.session.snapshot();
    const run = pickRun(snapshot.runs, Number(ctx.params.runIndex ?? 0));
    if (!run) return;                              // 目标不存在就跳过
    await ctx.session.client.request("POST", `/api/runs/${run.id}/archive`);
    ctx.trace.record({ kind: "command", name: "archiveRun", detail: { runId: run.id } });
  },
};
```

要求：

- 参数只能来自 `arbitrary`，必须可 JSON 序列化，不能有隐藏随机；
- 目标不存在时安静跳过，不要抛；
- 调 API 的客户端方法写进 `chaos/sut/client.ts`；
- 想影响生成权重，在 `chaos/model/commands.ts` 的 `ACTION_WEIGHTS` 里加名字。

## 新增一个 Fault

加 `inject` 和 `recover` 两个方法，放进 `chaos/faults/index.ts` 的对应数组：

```ts
export const killWorkerAfterDelay: FaultDefinition = {
  name: "killWorkerDelayed",
  description: "延迟后杀掉 worker",
  arbitrary: fc.record({ delayMs: fc.integer({ min: 100, max: 800 }) }),
  describe: (params) => `killWorkerDelayed(${params.delayMs}ms)`,
  inject: async (ctx) => { /* 现在注入 */ },
  recover: async (ctx) => { /* 恢复，必须幂等 */ },
};
```

- 进程故障放进 `processFaultDefinitions`（kill / pause / resume 这类信号）；
- 外部依赖故障放进 `externalFaultDefinitions`（走 Toxiproxy），
  没装 Toxiproxy 时这些不会参与生成；
- 加进 `allFaultDefinitions` 才会被 runner 认识；
- `recover` 必须幂等，`chaos:run` 每轮结束都会调一次。

## 新增一个 Invariant

加一个对象放进 `chaos/invariants/index.ts` 的 `invariantDefinitions`：

```ts
const noOrphanWorker: InvariantDefinition = {
  name: "no-orphan-worker",
  description: "worker 不能指向不存在的 run",
  async check({ snapshot }) {
    const runIds = new Set(snapshot.runs.map((run) => run.id));
    for (const worker of snapshot.workers) {
      if (worker.status === "exited") continue;
      if (!runIds.has(worker.runId)) {
        throw new InvariantViolation("no-orphan-worker", `worker ${worker.id} 指向 ${worker.runId}`);
      }
    }
  },
};
```

`check` 在每条命令之后和稳定的过程中反复调用，每次拿到一份 `snapshot`。
需要跨时间判断（比如“卡了多久”）时，用 `session.history` 存时间戳。
顺序有意义：越靠前的 invariant 越先报错。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CHAOS_WORKER_STEPS` | 8 | worker 跑多少步 |
| `CHAOS_WORKER_STEP_MS` | 250 | 每步间隔 |
| `CHAOS_RECOVERY_DELAY_MS` | 120 | 崩溃后多久起新 worker |
| `CHAOS_STOP_GRACE_MS` | 300 | 正常停止多久后升级成 SIGKILL |
| `CHAOS_DEAD_WORKER_GRACE_MS` | 400 | worker 记录和进程状态允许的漂移 |
| `CHAOS_STALLED_RUN_BUDGET_MS` | 2500 | run 没有 live worker 的容忍时间 |
| `CHAOS_TOXIPROXY_BIN` | `.chaos-cache/bin/toxiproxy-server` | Toxiproxy 二进制位置 |

## 边界

- 只保证一条链路成立，不覆盖所有组件；
- worker 是本地进程，不是容器。想换成 Pumba 的容器 kill / pause，
  换掉进程故障实现即可，Action / Fault / Invariant 接口不用动；
- 外部故障依赖 Toxiproxy 二进制，没装就自动只跑进程故障。
