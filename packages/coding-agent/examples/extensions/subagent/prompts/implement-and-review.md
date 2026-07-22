---
description: worker 实施，reviewer 审查，worker 应用反馈
---
使用带有 chain 参数的 subagent 工具执行此工作流：

1. 首先使用 "worker" Agent 实施：$@
2. 然后使用 "reviewer" Agent 审查上一步的实施结果（使用 {previous} 占位符）
3. 最后使用 "worker" Agent 应用审查反馈（使用 {previous} 占位符）

将其作为链执行，并通过 {previous} 在步骤之间传递输出。
