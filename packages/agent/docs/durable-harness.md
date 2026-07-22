# Durable AgentHarness 与会话设计

<!-- 从 jot zmnps2zu 同步而来。后续请直接在仓库中编辑本文件。 -->

Durable AgentHarness / 会话设计说明。

## 背景

仅靠自身无法让 `AgentHarness` 完全持久化，因为关键依赖由宿主应用以运行时 JavaScript 提供：

- 工具实现
- 模型与认证提供方
- 扩展和钩子处理器
- 资源加载器
- 系统提示词回调/修饰器

工具注册表属于运行时依赖。Harness 应持久化可序列化的工具配置（例如活动工具名称），但不应持久化具体工具实现。

实际目标是半持久化 Harness：

- 会话是持久化的追加式状态树
- Harness 将自己拥有的状态写入会话条目
- 宿主应用负责在恢复时重新创建兼容的、不可持久化依赖
- 恢复从持久化边界重新开始，而不是从正在进行的 provider 流继续

## 会话拥有持久化状态

应把会话视为所有可持久化的 Agent 状态，而不只是对话记录。

现有会话状态已经包含 Harness 状态：

- 模型变更
- 思考级别变更
- 活动工具变更
- 叶节点条目
- 标签
- 压缩和分支摘要
- 自定义消息与自定义条目

因此，继续使用一个持久化会话日志比增加 Harness 旁路存储更合适。对于大对象，旁路存储仍可能有用，但会话条目应保留真实来源引用。

## 恢复时应用必须提供的内容

应用必须重新创建兼容的运行时依赖：

- 模型注册表 / 模型对象
- 工具注册表
- 扩展集合、版本和顺序
- 资源加载器
- 系统提示词提供方/钩子
- 认证提供方
- 应用专用钩子

如果有稳定的 ID/版本/哈希，Harness 可以校验它们，但不能自行序列化这些依赖。

## 运行时配置与恢复

构造函数选项仍是显式的运行时配置，不读取会话状态。构造函数中的隐藏异步恢复会使错误处理变得含糊。

未来的异步构建器/工厂应负责持久化恢复：

```ts
const harness = await AgentHarness.builder()
  .env(env)
  .session(session)
  .model(defaultModel)
  .tools(runtimeTools)
  .defaultActiveTools(["read", "edit"])
  .restore({ missingActiveTools: "fail" });
```

`restore()` 应读取活动分支，归约持久化 Harness 配置，为缺失条目应用默认值，针对应用提供的运行时依赖进行校验，构造 Harness，并可在构造完成后发出 `source: "restore"` 更新事件。

对于活动工具：

- `active_tools_change` 条目是按分支作用域持久化的配置。
- 如果分支中没有 `active_tools_change`，恢复时使用构建器默认值；若未提供默认活动名称，则使用所有已注册工具。
- 活动工具名称必须唯一。
- 工具注册表名称必须唯一。
- 默认情况下，恢复出的活动工具缺失会导致恢复失败；之后可显式增加宽松的丢弃/禁用策略。
- 具体工具永远不会从会话恢复；宿主应用必须提供兼容工具。

## Harness 应持久化的内容

最小但有用的持久化条目包括：

- 按分支作用域的活动工具名称
- 排队的 steer/followUp/nextTurn 消息
- 与某次 turn 绑定的队列消费记录
- 活动操作期间接受的待处理会话写入
- 待处理写入的应用状态
- 操作开始/完成/中断
- turn 开始/完成
- provider 请求开始/完成（如恢复诊断需要）
- 工具调用开始/完成（如需安全恢复工具调用）

可能的条目：

```ts
type DurableHarnessEntry =
  | QueueEnqueuedEntry
  | QueueConsumedEntry
  | PendingWriteEnqueuedEntry
  | PendingWriteAppliedEntry
  | OperationStartedEntry
  | OperationFinishedEntry
  | OperationInterruptedEntry
  | TurnStartedEntry
  | TurnFinishedEntry
  | ProviderRequestStartedEntry
  | ProviderRequestFinishedEntry
  | ToolCallStartedEntry
  | ToolCallFinishedEntry;
```

每个被接受的变更都必须在公共 API 返回前完成持久化。

## 恢复模型

启动时：

1. 宿主应用注册工具、模型、扩展、资源、认证和钩子。
2. Harness 打开会话。
3. Harness 将会话条目归约为：
   - 当前叶节点
   - 对话分支
   - Harness 配置（包括活动工具名称）
   - 队列
   - 待处理写入
   - 活动操作/turn/工具状态
4. Harness 校验所需运行时依赖，包括将恢复的活动工具名称与应用提供的工具注册表比对。
5. Harness 协调未完成的操作状态。

Provider 流不可恢复。恢复只能从持久化边界重试，或将操作标记为中断。

## 恢复策略

默认采用保守策略：

- 未完成的 Agent turn：标记为中断，保留持久化队列/待处理写入，并返回空闲状态
- 未完成的 provider 请求：标记为中断，不自动重试
- 未完成的工具调用：追加中断/错误工具结果；仅当工具声明可安全重试/幂等时才重试
- 未完成的压缩：若没有压缩条目则重新执行
- 未完成的分支摘要/树导航：安全时重新执行或补写缺失的摘要/叶节点条目

可选策略：

```ts
recovery: "mark_interrupted" | "retry_unfinished"
```

`retry_unfinished` 必须防止对非幂等工具调用进行重复执行。

## 关键场景

### 队列

- 在 `queue_enqueued` 之前崩溃：消息未被接受。
- 在 `queue_enqueued` 之后崩溃：消息会被恢复。
- 队列排空后、持久化 turn 记录前崩溃：存在丢失/重复风险。
- 必须保证：已消费队列 ID 在被视为已消费前，记录于 `turn_started` 或等效条目中。

### 待处理写入

- 在 `pending_write_enqueued` 之前崩溃：写入未被接受。
- 入队后、应用前崩溃：恢复时应用写入。
- 应用后、写入完成标记前崩溃：确定性的目标条目 ID 让恢复逻辑能够发现条目已存在并标记为已应用。

### Agent 循环 turn

- provider 请求前崩溃：重试或标记中断。
- provider 请求期间崩溃：默认标记中断。
- provider 响应后、assistant 消息持久化前崩溃：如果没有记录 provider 结果，响应会丢失。
- assistant 消息持久化后崩溃：从持久化消息恢复。

### 工具调用

- 工具调用开始后、结果返回前崩溃：外部副作用可能已经发生。
- 默认恢复不应重新执行非幂等工具。
- 工具调用需要稳定 ID 和重试安全元数据，才能自动恢复。

### 压缩

- 摘要生成前崩溃：重新执行准备/摘要生成。
- 摘要生成后、压缩条目前崩溃：除非摘要已记录，否则重新执行。
- 压缩条目写入后崩溃：操作已完成；若缺少完成标记则补写。

### 分支摘要 / 树导航

- 摘要生成前崩溃：重新执行或标记中断。
- 摘要条目后、叶节点条目前崩溃：补写缺失的叶节点条目。
- 叶节点条目后崩溃：操作已完成；若缺少完成标记则补写。

## 最小可行试验

1. 增加持久化队列条目。
2. 增加带确定性目标 ID 的持久化待处理写入条目。
3. 增加操作开始/完成/中断条目。
4. 使用已消费队列 ID 记录 turn 开始。
5. 通过归约会话日志实现恢复。
6. 默认将未完成的 Agent turn 标记为中断。
7. 仅当不存在最终条目时，重新执行未完成的压缩/树操作。
8. 除非工具元数据声明可安全重试，否则不要重试未完成的工具调用。

## 待解决问题

- 哪些剩余 Harness 配置应首先移入会话：资源、stream options、系统提示词引用？
- 是否应按 turn 快照保存解析后的系统提示词文本，以便审计/调试？
- 恢复时是否要求严格匹配依赖 ID/版本？
- 应记录多少 provider 请求数据？
- 恢复时应追加用户可见的 assistant 中断消息，还是只追加内部操作条目？
- 恢复时存储是否应支持截断 JSONL 文件末尾不完整的一行？
