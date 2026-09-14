# text-to-cad 吸收评估

评估对象：[earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad)，`main@0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6`（2026-08-26）。证据只取仓库源码、README、许可证及仓库直接引用的官方资料。

## 结论

值得吸收，但不宜整仓搬入。它最有价值的不是完整机械设计知识，而是把 CAD 工作变成可检查、可恢复的工程流程：

`任务简报 → 参数/基准 → 生成 → 几何检查 → 截图 → 最小修复 → 重跑 → 交接`

Pi-CAD 应先吸收流程和判定协议；工具命令按现有能力改写；建模经验放进按需资料；制造参数仅作初筛。

## 1. 设计、建模知识

### 可直接借鉴

- 先按功能基准定原点和方向。零件用安装面、配合面、对称轴；装配用固定根件和命名基准。定位必须写进源码，再由生成结果验证。[positioning.md L5-L18](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/positioning.md#L5-L18)
- 操作顺序：基础体、主要增料、减料、壳、穿壁孔、圆角/倒角。易坏步骤靠后，特征分段命名，失败更容易定位。[build123d-modeling.md L9-L18](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/build123d-modeling.md#L9-L18)
- 切削体应穿出目标面，避免共面布尔；贯穿切削可在两侧多约 1 mm。同处也要求生成前检查整体比例、壁厚和边距。
- 工程图先读标题栏、单位、投影和版本；剖视图作为内部孔、盲孔、壁厚的依据；每个尺寸标注都转成命名参数和检查项。[cad-brief.md L29-L38](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/cad-brief.md#L29-L38)
- 分清零件和装配：单体制造用一个实体；分别制造、采购或运动的物体用带名称的装配。标签表达角色和位置，不假设面、边编号长期稳定。[build123d-modeling.md L13-L18](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/build123d-modeling.md#L13-L18)
- 导入件不能假设原点和方向，先量面、轴和孔位，再建配合基准。[positioning.md L125-L170](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/positioning.md#L125-L170)

### 需改写

- 多截面放样按点序配对、近相切布尔、切线链倒角、圆角降级、`located`/`moved` 等经验很实用，但大量内容绑定 build123d/OCC。应改成“现象—原因—检查—修复”的中立资料，并保留具体后端附录。[build123d-modeling.md L197-L203](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/build123d-modeling.md#L197-L203) [L293-L309](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/build123d-modeling.md#L293-L309) [L331-L346](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/build123d-modeling.md#L331-L346)
- DfAM 的默认壁厚、悬垂角、桥长只可作为早期提醒。原仓库也明确其采样和粗估边界，不能宣称可制造或认证。[process-limits.md L12-L40](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/dfam-check/references/process-limits.md#L12-L40)

### 不应吸收

- 把默认孔径、壁厚、圆角当作用户需求或行业保证。
- 把截图外观当尺寸、间隙、强度或可制造性证据。
- 把拓扑有效、总包围盒合理等同于设计正确。仓库明确：有效拓扑仍可能是负体积或错误实体。[build123d-modeling.md L242-L265](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/build123d-modeling.md#L242-L265)

## 2. 工具使用知识

### 可直接借鉴

- 工具分工清楚：`gen` 生成，`export` 导出，`inspect` 测量和比较，`snapshot` 视觉检查，`artifact` 调试产物。[CAD skill L53-L77](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/SKILL.md#L53-L77)
- 标准输出只给结果，标准错误给进度和失败；机器输出用紧凑 JSON；失败指向用户生成器栈，而非运行库栈。适合 workflow 节点可靠取值。
- 目标路径以任务工作目录为准；只生成明确目标，不扫全目录。源文件和生成文件同名同目录，便于追踪。
- 检查分层：基础事实/面/定位；实体有效性；按需求量尺寸、间隙和对齐；修改任务再做差异检查。[inspection-and-validation.md L130-L136](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/inspection-and-validation.md#L130-L136)
- 打印流程坚持真实切片器：发现后端、试跑、正式切片、静态检查，再交给打印机专用流程。检查非空、温度、运动、挤出、XYZ 范围和未知命令。[gcode/SKILL.md L14-L61](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/gcode/SKILL.md#L14-L61) [L129-L137](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/gcode/SKILL.md#L129-L137)

### 需改写

- `#o1.2.f1` 选择符、`AssemblyHelper`、具体命令名是 cadgen 协议。Pi-CAD 可借“局部稳定引用”和“结构化测量”概念，不能直接假设兼容。
- SendCutSend 规则值得借其方法：下载最新官方规格、量实际上传文件、逐条比较。但供应商参数、材料和工艺会变化，必须保留来源日期和适用产品。[sendcutsend/SKILL.md L24-L61](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/sendcutsend/SKILL.md#L24-L61)

## 3. 适合 Pi-CAD 的 workflow

建议直接做成节点图：

1. `classify`：新零件、装配、修改、导入检查、导出。
2. `brief`：抽取单位、坐标、尺寸、特征、配合、文件、假设、检查项。
3. `source_parts`：有明确采购件时先查真实 STEP；找不到再记录外形包络。
4. `plan`：参数、标签、基准、预期包围盒、检查映射。
5. `generate`：只改源码，只生成显式目标。
6. `validate_base`：实体数、闭合、自交、正体积、包围盒、标签。
7. `validate_spec`：每条用户尺寸、间隙、关系对应一个可复现检查。
8. `snapshot_review`：至少一张主产物截图；视觉疑点转成几何检查。
9. `repair_resume`：从首个失败节点最小续跑。
10. `handoff`：产物、截图、已跑检查、假设、剩余风险。

该主干与仓库强制流程一致。[CAD skill L78-L97](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/SKILL.md#L78-L97)

### 失败判定

节点必须保存：输入摘要、源版本、命令、退出码、结构化结果、产物哈希、首个失败证据。

- 硬失败：命令非零；产物不存在；解析失败；无实体；开壳；自交；任一实体体积非正；明确尺寸或配合超差。
- 视觉失败：截图发现缺特征、错方向、错装配、比例明显异常。不能只凭图片直接下尺寸结论，须新增测量后定案。
- 软警告：未给出的制造参数、工具启发式结果、无法验证的假设。保留风险，不冒充通过或失败。

数值检查定成败，截图补足未编码的语义错误，是仓库最值得吸收的判定原则。[inspection-and-validation.md L5-L7](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/inspection-and-validation.md#L5-L7)

### 续跑设计

1. 固定真实任务输入、失败前源码和已完成节点结果。
2. 从首个失败节点恢复，只给 Agent 最小必要上下文：目标、相关参数、失败命令、原始错误、关联产物。
3. 先分类：生成、无效几何、尺度、缺特征、选择符、定位、截图或交接。
4. 只改最小责任区。
5. 先重跑失败命令；通过后再跑它依赖的检查；修改可能影响其他几何时跑差异检查。
6. 仍失败则保留原候选，报告尝试、仍可用产物、不能声称通过的项和下一步。

这与仓库修复环一致。[repair-loop.md L5-L14](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/repair-loop.md#L5-L14) [L192-L209](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/references/repair-loop.md#L192-L209)

真实任务过长时，可只回放一个失败节点，但通过条件必须同时满足：原失败消失、下游必要检查通过、无明显退化。高分真实案例可作防退化样本。

## 4. 其他可迁移实现

### 可直接借鉴思想，代码需适配

- `MateTarget`/`MateRelation` 和 `AssemblyHelper`：把“面对面、同轴、转动、直线”保存为结构化关系，而非只存最终矩阵。[assembly.py L7-L27](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad-viewer/scripts/viewer/packages/cadgen/src/cadgen/assembly.py#L7-L27)
- 有效性检查：实体、壳、自由边、单实体带符号体积、自交。适合拆成独立检查节点。[validity.py L43-L177](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad-viewer/scripts/viewer/packages/cadgen/src/cadgen/validity.py#L43-L177)
- 产物过期判断：输入闭包哈希、配置规范化哈希、每种产物独立版本。配置变化也能使缓存失效，避免旧截图/旧网格误判。[package_freshness.py L1-L88](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad-viewer/scripts/viewer/packages/cadgen/src/cadgen/_internal/package_freshness.py#L1-L88)
- 跨平台文件锁和等待结果：避免相同模型并发生成互踩；把 `built/current/skipped-peer/contended` 作为明确状态。[lock.py L120-L158](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad-viewer/scripts/viewer/packages/cadgen/src/cadgen/coordination/lock.py#L120-L158)
- 源码、参数、检查结果、截图、导出文件分层。源是唯一真值，STEP 为主产物，STL/3MF/GLB 为派生产物。[CAD skill L99-L105](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/skills/cad/SKILL.md#L99-L105)

### 不应直接搬

- 整套 cadgen、重复打包进每个 skill 的运行库、预构建 viewer 资源。体积大且与 build123d/OCC、目录布局和自身选择符紧绑。
- DfAM 网格算法的结果包装成严格工程结论。它适合筛查和排序，不替代工艺审核。
- 把所有建模故障经验塞进 workflow 主文。应由失败类型按需加载，否则上下文过长。

## 许可证

根许可证是 MIT：允许使用、复制、修改、合并、发布、分发、再许可和销售；分发源码或大段复制实现时须保留版权和许可文字；软件按原样提供、无担保。[LICENSE L1-L21](https://github.com/earthtojake/text-to-cad/blob/0e94cd1d2b5fa2013d89aa9504ecadcf16ce39f6/LICENSE#L1-L21)

仓库内各 skill 还有各自的 `LICENSE`。若复制某目录代码，应逐目录核对并保留相应声明。只吸收思路并独立实现，仍建议在设计记录里保留来源和提交号，便于审计。

## 建议次序

1. 先实现失败节点记录、最小续跑、下游复查。
2. 再实现简报和“用户要求 → 检查项”映射。
3. 补基础几何检查和强制截图。
4. 加输入闭包哈希、配置哈希、并发锁。
5. 最后按失败类型加入建模经验和制造初筛。
