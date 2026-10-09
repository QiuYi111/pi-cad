# res408-07a-race-repeat-8aa-180 race / 重复故障统计

- commit：8aa12102e39d3f1b0f6d65082c0b0a26936c7e77（HEAD），dirty=false
- 轮次：180/180；maxCommands=14；seed=408700；runtimeRatio=1；并发=3
- 使用真实准备的轮次：144；准备命令：{"openConversation":144}
- 各 profile 的准备轮数：{"race":108,"session-isolation":36}

## 每类 fault 的四态统计

| fault | 命令次数 | Injected | NotApplicable | InjectionFailed | RecoveryFailed | Recovered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raceRestartDuringTransition | 48 | 20 | 28 | 0 | 0 | 20 |
| raceCrossConversationFault | 42 | 33 | 9 | 0 | 0 | 33 |
| raceRepeatSubmitDuringFault | 24 | 16 | 8 | 0 | 0 | 16 |
| raceTwoConversationsBuild | 39 | 28 | 11 | 0 | 0 | 28 |
| raceUserActionDuringKernelFault | 51 | 28 | 23 | 0 | 0 | 28 |
| raceLegalOrderSwap | 19 | 19 | 0 | 0 | 0 | 19 |
| killKernelDuringBuild | 20 | 17 | 3 | 0 | 0 | 17 |
| restartRuntimeDuringBuild | 10 | 9 | 1 | 0 | 0 | 9 |
| killRuntimeDuringBuild | 13 | 7 | 6 | 0 | 0 | 7 |
| killAuthorityDuringBuild | 22 | 0 | 22 | 0 | 0 | 0 |

## 同名重复和恢复顺序

计数依据 rounds.jsonl 内每次真实命令和 fault outcome；同一轮重复同名 fault 会逐次计数。标准 report 的覆盖统计按每轮去重后的 fault 名计数。

- 重复同名 fault 的轮次：37；重复对数：57
- fault → action → 同 fault 的轮次：30；序列对数：41
- 恢复顺序种类：40
- raceLegalOrderSwap: 7
- raceTwoConversationsBuild: 12
- killRuntimeDuringBuild → killKernelDuringBuild: 2
- raceRestartDuringTransition → raceTwoConversationsBuild: 2
- raceUserActionDuringKernelFault: 12
- raceRestartDuringTransition → raceRestartDuringTransition → restartRuntimeDuringBuild: 1
- raceCrossConversationFault: 17
- raceUserActionDuringKernelFault → raceRepeatSubmitDuringFault → raceLegalOrderSwap: 1
- raceRepeatSubmitDuringFault: 7
- raceUserActionDuringKernelFault → raceRestartDuringTransition: 1
- killKernelDuringBuild: 6
- raceTwoConversationsBuild → raceCrossConversationFault: 1
- raceRestartDuringTransition: 10
- raceUserActionDuringKernelFault → raceLegalOrderSwap: 1
- raceUserActionDuringKernelFault → raceTwoConversationsBuild: 2
- restartRuntimeDuringBuild: 3
- raceTwoConversationsBuild → raceRepeatSubmitDuringFault: 2
- killRuntimeDuringBuild: 2
- raceTwoConversationsBuild → raceLegalOrderSwap: 2
- restartRuntimeDuringBuild → killKernelDuringBuild → killKernelDuringBuild: 1
- raceUserActionDuringKernelFault → raceRepeatSubmitDuringFault: 1
- raceCrossConversationFault → raceCrossConversationFault: 2
- raceRepeatSubmitDuringFault → raceCrossConversationFault: 3
- raceUserActionDuringKernelFault → killRuntimeDuringBuild → killKernelDuringBuild: 1
- raceUserActionDuringKernelFault → raceRestartDuringTransition → raceTwoConversationsBuild → raceUserActionDuringKernelFault: 1
- raceRestartDuringTransition → killKernelDuringBuild: 1
- raceLegalOrderSwap → raceCrossConversationFault → raceLegalOrderSwap → raceCrossConversationFault → raceTwoConversationsBuild: 1
- raceLegalOrderSwap → raceTwoConversationsBuild: 2
- raceUserActionDuringKernelFault → raceUserActionDuringKernelFault: 1
- raceLegalOrderSwap → raceLegalOrderSwap: 1
- raceCrossConversationFault → raceUserActionDuringKernelFault → raceUserActionDuringKernelFault → raceRepeatSubmitDuringFault: 1
- killKernelDuringBuild → raceRestartDuringTransition → killKernelDuringBuild: 1
- raceRepeatSubmitDuringFault → raceCrossConversationFault → raceCrossConversationFault → raceCrossConversationFault: 1
- killKernelDuringBuild → restartRuntimeDuringBuild → restartRuntimeDuringBuild → killKernelDuringBuild: 1
- killRuntimeDuringBuild → restartRuntimeDuringBuild: 1
- raceCrossConversationFault → raceTwoConversationsBuild: 1
- restartRuntimeDuringBuild → killKernelDuringBuild → killRuntimeDuringBuild: 1
- raceRestartDuringTransition → raceUserActionDuringKernelFault → raceLegalOrderSwap: 1
- raceLegalOrderSwap → raceTwoConversationsBuild → raceTwoConversationsBuild → raceCrossConversationFault: 1
- raceUserActionDuringKernelFault → raceRestartDuringTransition → raceUserActionDuringKernelFault: 1

## NotApplicable 原因（前置条件保持原样）

- 20 × raceUserActionDuringKernelFault: 常驻 runtime 面不暴露 viewer-catalog，只有一次性 CLI 控制面才有
- 20 × raceRestartDuringTransition: 会话 conv-a 在 cook 阶段不接受事件 plan_ready（合法：finished）
- 5 × raceRepeatSubmitDuringFault: 会话 conv-a 没有 active run（done）
- 2 × killKernelDuringBuild: 会话 conv-a 当前阶段 plan 不允许 model.build
- 2 × killRuntimeDuringBuild: 会话 conv-a 没有 active run（done）
- 4 × raceCrossConversationFault: 另一个会话 conv-a 还没有 active run
- 2 × raceUserActionDuringKernelFault: 会话 conv-a 没有 active run（done）
- 2 × raceCrossConversationFault: 会话 conv-a 当前阶段不允许 model.build
- 22 × killAuthorityDuringBuild: 这一轮直连常驻 runtime，没有一次性控制面进程；runtime 生命周期故障用 killRuntimeDuringBuild
- 8 × raceRestartDuringTransition: 会话 conv-a 没有 active run（done）
- 5 × raceTwoConversationsBuild: 会话 conv-a 还没有 active run
- 3 × raceRepeatSubmitDuringFault: kernel 起了但没有进入真 build（没等到 build 子进程）
- 1 × killKernelDuringBuild: 会话 conv-a 没有 active run（done）
- 2 × raceCrossConversationFault: kernel 起了但没有进入真 build（没等到 build 子进程）
- 1 × raceCrossConversationFault: 另一个会话 conv-b 还没有 active run
- 3 × raceTwoConversationsBuild: 第二个会话 conv-b 还没有 active run（先 openConversation）
- 1 × restartRuntimeDuringBuild: 会话 conv-a 没有 active run（done）
- 2 × raceTwoConversationsBuild: kernel 起了但没有进入真 build（没等到 build 子进程）
- 3 × killRuntimeDuringBuild: 会话 conv-a 当前阶段 plan 不允许 model.build
- 1 × killRuntimeDuringBuild: 这条 build 不是 runtime 服务的
- 1 × raceUserActionDuringKernelFault: kernel 起了但没有进入真 build（没等到 build 子进程）
- 1 × raceTwoConversationsBuild: 会话 conv-b 当前阶段不允许 model.build
