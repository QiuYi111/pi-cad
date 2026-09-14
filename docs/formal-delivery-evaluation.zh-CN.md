# Reify 正式交付收益对照协议

每个 experimentId 固定模型及推理档位、任务文本、机器与 runtime 版本、token/时间预算和人工验收量具。按 `baseline`、`tiered`、`tiered-review` 三种变体执行；经验候选完成独立验证与采用后，追加 `tiered-review-experience`，不得用历史 benchmark 替代。

每个样本单独保存 JSON、Agent trace、构建/审查 evidence、人工验收记录和正式包 manifest。样本字段由 `scripts/summarize-product-evaluation.mjs` 强制检查，包括工程验收、误通过、人工介入、是否恢复、总时长、首个反馈、费用和 release state。脚本拒绝同 experimentId 下模型、任务、环境或预算变化的伪对照，并把全部原始样本嵌入报告。

负向样本固定覆盖：无人工批准、批准绑定版本过期、目标无权限、复制或推送中断。任何一个样本出现错误正式发布即停止结论发布并记录 finding。正式包需在另一目录重新计算 SHA，并把 acceptance summary、human approval 与 source revision 对回当前样本。

报告只陈述输入样本所测得的数值。缺少变体、真实平台、成本或人工验收时明确写入 limitation，不推算提升百分比。
