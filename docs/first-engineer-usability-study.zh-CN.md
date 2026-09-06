# Reify 新工程师首条流程验证

固定环境为 1440×900、100% 缩放、默认减少动画设置；固定任务为：“创建 60×40×6 mm 安装板，四角各有一个直径 5 mm、距相邻边 8 mm 的通孔。查看模型，把板厚改成 8 mm，测量并做一次 Z 剖切，然后导出 STEP。”

参与者此前不得接触 Reify。主持人只提供安装包、任务文字和目标导出目录，不讲解界面。全过程使用真实 Agent、CAD build、Viewer、参数修改、测量/剖切和导出。

记录以下时间点和事实：开始、首个可见反馈、首个可交互模型、完成、每次卡住、每次求助、构建失败与恢复、最终文件路径。结束时请参与者不用提示回答：当前模型是什么、任务在哪个阶段、自己修改了什么、导出结果在哪里。

完成标准：导出的 STEP 可重新打开；厚度和孔规格经工具测量成立；参与者能回答四个状态问题；键盘可在对话与画布间切换；Viewer 可缩放；系统减少动画设置下不出现持续运动；中文长文本无截断导致的信息丢失。

发现主要障碍后在同一 build 修复并让另一位新参与者重复固定任务。不得把自动 E2E 或开发者自测记为新工程师通过。

结果使用 `scripts/record-first-engineer-study.mjs input.json output.json` 校验和归档。输入必须包含 participantId（匿名）、buildVersion、platform、resolution、timestamps、stalls、helpRequests、stateAnswers、artifactPath、artifactSha256、measurements 与 outcome。
