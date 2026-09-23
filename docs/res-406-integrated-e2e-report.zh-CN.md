# RES-406 合并后端到端验收记录

日期：2026-09-23
Pi-CAD 基线：`0d160cb69e65cfe5df3d6b151f85f4840c7a69e9`。
Prime 基线：`dfaee8067c5def339d1ca0d7b9f3573bc86c948c`，checkout 为 `.scratch/res406/prime-agent-main`。
环境：WSL2、Intel Core i5-12400F、12 逻辑 CPU、31 GiB 内存；Blender 5.0.1。
项目运行目录：`/tmp/pi-cad-desktop-rpc-subagents-kn17uz`。这是临时 Desktop RPC fixture，不是旧 demo 工作区。

## 结果

### 已通过

- Prime inline smoke：父代理启动两个子代理；子代理先构建错误几何、测量、修复并重测；A 再启动孙代理。每个会话使用自己的 canonical run 和 kernel。父代理采用三个子 STEP，并进入 `done`。
- Desktop RPC smoke：生产 sidecar、daemon socket、sandbox、Blender 和 Prime kernel 实际运行。父、子、孙四个 conversation 各绑定唯一 run，四个 run 全部 `done`；故意失败的额外子代理没有中断其他任务。父代理显式采用三个子 STEP。
- Desktop RPC 验证器确认项目 `currentRunId=null`，四个 conversation 没有共享 run；三份 ArtifactRef、清单、Probe 结果及父代理收到的 SHA 对得上。
- 在 Prime provider 请求构造处捕获了 typed image；smoke 检查子代理模型请求中包含 `type=image`，不是从 transcript 图片文本推断。
- Desktop RPC kernel-state 检查曾在文件落盘前触发。现在 smoke 最多等待 30 秒，并重跑成功。
- Prime inline 产物 SHA-256：child-a `464d399a41144c0e5d8c6644bdc5d2b8660b884bfed3deaf53259b96381efcd2`；child-b `17d8374bdd050fea794cbfda8234a6fb9826cf8e5a21a77ec9498f4b25f34d8d`；grandchild `b6078fea9d41441094fe27eba1ba6d5ed79b015efdc505e72e71c18a1f346d60`。
- Desktop RPC 产物 SHA-256：child-a `a03cdf790f114f525e8973cfa601b3ccd72ead30b195ad1e3c0616ba83fb738f`；child-b `e55f0facbe8ba38cb69a63c2238ee9afba800f2cf5ba4041eaa06db456442b7e`；grandchild `4944e1a0d50ce7cd52f3119443682c886e6eb811260f3d9c79b52f270352fd72`。Provider capture SHA-256：`8f69d39a87fd5eb628027473fc8f54eb15b0a51bfc6b005b89975a67508fb588`。父 transcript SHA-256：`15d9f49096017e1a47c6f3ed61d4cc56d8d28f279c3352d875137c6dd16c8cde`。
- 现有 Blender bridge smoke 实际导入 STEP，保留 `assy/bracket-a`、`assy/bracket-b` 两个对象身份；导入与 bridge manifest 的 STEP hash 一致。此项与 Prime 父子 smoke 分开运行。

### 修复

- Prime kernel 环境不再因 Blender MCP 的不完整 `pydantic` 目录优先而导入错误依赖。
- Bwrap 同时保留 Prime venv 的符号链接目标目录，并将 venv 路径传给 Prime 和 Blender MCP。Prime bootstrap 在 sandbox 外先完成；kernel Python skills 在 venv 中安装。
- Desktop RPC faux provider capture 使用 sandbox 内 `/workspace` 路径，确保记录的是 Prime 真正发出的请求。

### 验证命令

- `npx tsx --test tests/authority-sidecar.test.ts`：13 项通过，含 Prime venv 与 Bwrap 路径检查。
- `npm run check:agent-contract`：通过。
- `npm run test:ts`：417 项，416 通过、1 跳过、0 失败；跳过项需要 Toxiproxy。
- Python：`cd tests && ../.scratch/res406/kernel-venv/bin/python -m unittest test_identity test_export_identity test_probe`：67 项通过。
- Blender：`cd tests && ../.scratch/res406/kernel-venv/bin/python -m unittest test_presentation_v2.PresentationBridgeBundle.test_headless_blender_import_preserves_manifest_identity`：通过。
- Desktop：`npm --prefix apps/desktop test`：28 个文件、217 项通过。
- Inline：`PRIME_AGENT_REPO=.scratch/res406/prime-agent-main PRIME_AGENT_KERNEL_VENV=.scratch/res406/prime-kernel-venv node tests/prime-subagent-smoke.mjs`：通过。
- Desktop RPC：`PRIME_AGENT_REPO=.scratch/res406/prime-agent-main PRIME_AGENT_KERNEL_VENV=.scratch/res406/prime-kernel-venv RES406_KEEP_SMOKE=1 node tests/prime-desktop-rpc-subagent-smoke.mjs`：通过，产物保留在 `/tmp/pi-cad-desktop-rpc-subagents-kn17uz`。
- `npm run check`：仓库没有此脚本；可用脚本见 `npm run` 输出。

## 尚未完成的验收

- 稳定命名选取、部件重排/参数修改、重复实例、特征失效、旧 ref、旧 STEP/manifest、导出竞态、Probe timeout 与双关节碰撞有 Python/导出/Probe 回归覆盖；尚未把这些负例接进同一个父子 canonical run。
- done 后只读查询、并发取消/重启隔离和构建/导出交错尚未在本次 Desktop RPC run 中验证。
- Blender bridge 已单独做真实导入 smoke；未从同一 Desktop run 导出再导入 Blender。
- 尚未新增 RES-406 固定 seed Chaos 动作序列，也没有记录注入是否生效和最小复现。
- 尚无同机器、同样本的基线/合并版性能对照；不报告节省比例。
- 尚未提交、推送或开 PR；尚未附回 RES-401。

因此目前仅证明 inline 与 Desktop RPC 的真实父子 CAD 闭环、typed image 和身份隔离；RES-406 整体验收仍未完成。
