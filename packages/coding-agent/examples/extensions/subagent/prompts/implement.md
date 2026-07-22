---
description: 完整实施工作流——scout 收集上下文，planner 制定计划，worker 负责实施
---
使用带有 chain 参数的 subagent 工具执行此工作流：

1. 首先使用 "scout" Agent 查找与以下内容相关的所有代码：$@
2. 然后使用上一步的上下文，让 "planner" Agent 为 "$@" 创建实施计划（使用 {previous} 占位符）
3. 最后使用 "worker" Agent 实施上一步生成的计划（使用 {previous} 占位符）

将其作为链执行，并通过 {previous} 在步骤之间传递输出。
