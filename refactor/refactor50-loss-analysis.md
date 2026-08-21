# Refactor-50 丢分案例分析(运行中快照,29/50 时点)

运行:`2026-08-21T10-06-07-498Z_refactor50` @ `6d8612b`(refactor/runtime-v2)
对照:同 50 样本的 detailed-200-final 基线(closure-v1 @ 6c9c89a)

时点状态:29/50 完成,**26/29 exact(89.7%)**,全 clean、全 done,无回归。
基线在相同样本上 25/29。丢分 4 例,翻正 1 例(00005721: 13/14 → 14/14)。

---

## 案例一 00006892 — 真正的 Agent 推理失误(8/14,基线 9/14)

### 根因深挖(v2):不是 context 丢失,是验收合理化

针对"是否 context 管理失效导致 mission 丢失"的核查结论:

1. **compact 从未触发**:会话仅 47 个事件、14 次工具调用,单回合
   峰值 input ≈ 65,547 tokens,远低于 `DEFAULT_THRESHOLD_PERCENT=55%`
   的重建阈值。working context 层从未承压。
2. **mission 也不靠 compact 存活**:Mission 由 `before_agent_start` →
   `renderTaskContext` 每回合从 canonical 记录(records/requirements.json)
   重投影进 system prompt(runtime.ts:326-331)。system prompt 不落
   session.jsonl,故会话文件中 Mission 文本仅出现两次(工具回显)——
   属正常,注入路径已核实。验收回合 Mission 在场。
3. **决定性证据 —— 验收 note 原文**:

   > "The result is one valid solid with measured bbox 1.5 x **0.260525**
   > x 0.15789 … the source explicitly defines the 1.5 x **0.52105** x
   > 0.15789 starting prism … The oversized centered semicircle naturally
   > removes the +Y half of the prism … **this is consistent with the
   > stated diameter and placement**."

   Agent 看见了 0.2605,理解了上半条被整体切除,然后把它**合理化**
   为"与所述直径一致"——它校验的是**构建脚本的内部自洽**
   (source 定义了正确的起始棱柱),而不是**结果零件与需求的符合**
   (Must:最终件宽度 0.52105)。复核了菜谱,没尝菜。Must 条目
   "Prism width is 0.52105 units" 与实测 0.260525 同回合共存,
   事实供给完整,对账判断缺位。

### 结论与改进点

- 失败不在供给层(mission 每回合在场、观察事实两次上桌),
  在**验收门禁只查证据在场、不查事实与需求一致**。
  `accepted` 的 note 是声明式的,错误的合理化能通过。
- 对症改进(control plane 职责,"Control decides what is REQUIRED"):
  **确定性验收 lint**——`cad_transition(accepted)` 时解析 Must 中
  "尺寸 is X units" 类条目,与当前证据的实测 bbox/拓扑(提交摘要
  里已有)做数值 diff,超差即 block 并列出矛盾项。bbox 已在
  commit digest 中,实现代价极低,fail-closed。

---

任务:1.5 × 0.52105 × 0.15789 棱柱,从长边中央切一个半圆
(半圆直径 1.701232,贯穿高度)。

**Agent 建了什么**:在棱柱俯视图正中做了一个 D 形内凹腔,且切具直径
(1.701)大于棱柱本身(1.5 × 0.52)——切掉的是整个上半条,效果等于
一刀平切:

- 最终 bbox = 1.5 × **0.2605** × 0.15789(宽度腰斩,要求 0.52105)
- **cylinders = 0** —— 半圆切口必然产生圆柱面,一个都没有

**关键事实:证据两次摆上桌面,Agent 仍然接受了**:

1. `cad_commit_candidate` 的摘要行直接打印
   `bbox=1.5×0.260525×0.15789`(宽度只有要求的一半);
2. review 相位 `cad_inspect_geometry` 返回
   `cylinders: 0 cylindrical faces`。

随后 `cad_transition(accepted)` 的 note 声称 "Reviewed current-version
STEP geometry… one valid solid with measured…" —— 验收判断没有把观察
到的事实与需求对账。这不是观察层缺信息(观察层工作正常,事实齐全),
是解释/判断层失守。基线同一样本同样失败(9/14),根因相同。

顺带:该样本里 Agent 在 review 相位两次试图用 bash 逃逸,被 read_only
栅栏正确拦截并引导到探针 —— 护栏按设计工作。

**改进方向(策略级,不动架构)**:`accepted` 转移可以要求 Agent 逐条
对账"需求尺寸 vs 实测 bbox/拓扑特征",commit 摘要里的 bbox 与
cylinders 计数已经足够支撑这个对账提示。

## 案例二 00000960 — 提示词歧义 + 测试生成瑕疵(11/16,与基线同分同剖面)

任务:0.75 × 0.75 × 0.00195 薄板 + 0.281257 × 0.0625 小矩形接到右缘,
"starting halfway up its height"。

- 歧义:"height" 指什么?地面真值按**厚度**理解(Z 偏移 0.00195/2),
  Agent(和基线)按**平面边**理解(Y = 0.375)。两种读法都合理,
  测试只认地面真值。挂 `second_box_half_height_offset 0/2`。
- 测试瑕疵:`first_box_plan_dims` 检查**整体 bbox** 最大边 ≈ 0.75,
  而提示词本身就要求凸出右缘的小矩形(整体 X 必然 1.03)——按提示词
  严格作答也过不了这条。挂 1/3。

与基线逐项同分(11/16),失败需求组完全一致 —— 稳定的数据集侧问题。

## 案例三 00001817 — 融合 vs 组装的词义歧义(16/17,与基线同分同测)

任务:桌面 + 四条腿,"legs… linked to the bottom of the table top"。

Agent 交付 `Compound`(5 个独立实体,装配语义);地面真值把 "linked"
读成**融合成单一实体**。挂 `planar_prism_geometry_faces 1/2`
(平面数对不上)。基线同分同测。这类"link/attach 是否融合"是
CADTestBench 提示词的系统性歧义。

## 案例四 00006578 — inset 解释歧义(19/20,与基线同分同测)

任务:四孔 "inset from the edges by 0.263507 / 0.219429"。

需求原文自己写着 "interpreting inset relative to hole center/edge as
applicable" —— 测试取了其中一种(孔边距),Agent 取了另一种
(孔心距)。挂 `hole_insets_xy 1/2`。基线同分同测。

---

## 分类汇总

| 案例 | 本轮 | 基线 | 根因分类 |
| --- | --- | --- | --- |
| 00006892 | 8/14 ✗ | 9/14 ✗ | **Agent 判断失误**(观察层已给出矛盾事实) |
| 00000960 | 11/16 ✗ | 11/16 ✗ | 提示词歧义 + 测试生成瑕疵(数据集侧) |
| 00001817 | 16/17 ✗ | 16/17 ✗ | 融合/组装词义歧义(数据集侧) |
| 00006578 | 19/20 ✗ | 19/20 ✗ | inset 解释歧义(需求文本自带两种读法) |
| 00005721 | 14/14 ✓ | 13/14 ✗ | 正向翻正(几何全对) |

结论(至 29/50 时点):

1. 4 个丢分里 **3 个与基线逐项同分同挂**——是数据集歧义类的稳定
   复现,与重构无关;完整 200 样本运行的 adjudication 流程
   (final-report 已判 3 例 DEFECT)就是针对这类。
2. 唯一的实质失误(00006892)是**验收判断没有消化观察层给出的
   事实**,重构前后同样失守——说明瓶颈在解释/对账策略,不在
   观察供给。这恰好支持在 review 相位加"需求-测量逐项对账"的
   验收门槛,是后续 prompt/策略改进的首选点。
3. 无新增回归;净变化 +1(翻正 00005721)。

> 注:分析样本解包于 `results/.cache/tmp-analysis`,运行结束时随
> `.cache` 一并清理;基线逐项对照来自 FINAL-REPORT 失败清单(基线
> 明细在运行期间处于 L1 vault 内)。
