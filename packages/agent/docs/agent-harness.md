# AgentHarness 生命周期

`AgentHarness` 是底层 Agent 循环之上的编排层，负责会话持久化、运行时配置、资源解析、操作锁和扩展变更语义。

本文记录当前方向与已实现行为；规划中的扩展/会话外观会明确标注。

## 最终生命周期目标

监听器和钩子应能捕获 `AgentHarness` 并在允许的事件中调用公共 API，且不得破坏 turn 快照、持久化顺序、待处理写入、结算或阶段状态。规则是：忙碌时拒绝结构性操作；在安全点接受队列操作；setter 只影响未来快照；忙碌写入按确定顺序刷新；getter 返回最新配置。当前监听器没有外观对象，运行中调用 `waitForIdle()` 可能死锁，未来应提供 `runWhenIdle()`。

`AssistantMessageStream` 已将 SSE/websocket 传输读取与事件消费解耦，生命周期代码应在 Harness 边界使用显式 await 顺序，而非 fire-and-forget。

## 错误处理

- 预期失败且不应抛出的底层能力使用 `Result<TValue, TError>`，包括 `ExecutionEnv`、文件系统/shell、资源加载和压缩辅助函数。
- `Session`、`AgentHarness` 等高层 API 通过拒绝/抛出报告错误。
- 公共失败尽量归一化为 `AgentHarnessError`，子系统错误保留为 `cause`。

事件观察已提交状态。提交后钩子失败不会回滚，方法会以 `AgentHarnessError` 代码 `"hook"` 拒绝。

## 状态模型

### Harness 配置

配置包含 model、thinking level、tools、active tool names、resources、stream options 以及 system prompt/provider。getter 返回最新配置；setter 即使 turn 运行中也立即更新，并只影响下一次 turn 快照。

`setResources()` 每次调用都以浅拷贝资源发出 `resources_update`；`getResources()` 返回当前资源浅拷贝。

### Turn 快照

`createTurnState()` 为一次 LLM turn 创建快照，包含持久化消息、解析资源、系统提示词、model、thinking level、所有工具、活动工具、stream options 和派生 session id。provider 回调每次创建只调用一次；资源数组、stream options、headers、metadata 只浅拷贝。凭据通过 `getApiKeyAndHeaders()` 按请求解析。

### Session

Session 只包含已持久化条目，读取不包含排队写入。`buildContextEntries()` 构建考虑压缩的上下文，`buildContext()` 将活动分支投影为 `AgentMessage[]`。自定义条目默认省略，可通过 `entryProjectors` 和 `entryTransforms` 调整。

`setLeafId()` 会追加持久化 `leaf` 条目（根节点为 `null`），重新打开存储时从最近条目重建叶节点。

### 待处理会话写入

操作活动时的写入按不含 `id`、`parentId`、`timestamp` 的条目形状排队，始终持久化，并在保存点、结算和失败清理时刷新。公共外观 API 尚未实现。

## 操作阶段

```ts
type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";
```

结构性操作 `prompt`、`skill`、`promptFromTemplate`、`compact`、`navigateTree` 仅在 `phase === "idle"` 时允许，并在首个 `await` 前设置阶段；忙碌时以 `AgentHarnessError` 代码 `"busy"` 拒绝。turn 中可调用 `steer`、`followUp`、`nextTurn`、`abort` 和运行时 setter。阶段结算语义仍需审查。

## Turn 执行

`prompt`、`skill`、`promptFromTemplate` 都执行：断言 idle 并设为 `"turn"`；调用 `createTurnState()`；从快照生成文本；调用 `executeTurn()`。`skill` 与模板从同一快照解析资源。`steer`、`followUp`、`nextTurn` 接受文本和可选图片创建用户消息，`nextTurn` 消息在下一用户消息之前插入。队列模式 `getSteeringMode()`/`setSteeringMode()`、`getFollowUpMode()`/`setFollowUpMode()` 实时生效，队列只在安全点排空。

## 保存点

assistant turn 和工具结果完成后到达保存点：

1. 在 Agent 消息后刷新待处理写入；
2. 底层循环可能继续时创建新快照；
3. 在下一次 provider 请求前应用最新上下文、模型、思考级别、stream options 和 session id。

因此 turn 中的配置变化影响下一 turn，但不修改当前请求。传输已解耦，保存点和钩子可直接等待，从而保持记录顺序。底层循环把 `ThinkingLevel` 转为 provider `reasoning`：`"off"` -> `undefined`，其他值原样传递。 `agent_end` 只需刷新写入并清阶段；`settled` 时序仍在审查。提示词回调启动时失败会拒绝并恢复 idle，保存点失败则记录 assistant 错误。

## 钩子和事件

目标系统见 [hooks.md](./hooks.md)。Harness 发出类型化事件并消费类型化结果；单一实现负责注册、清理、来源和 reducer；`on()` 同时支持观察/变更钩子；结果事件由类型化 reducer 归约；上下文应由外观组成的普通对象构成。

事件描述当前动作，getter 描述未来快照配置。条件允许时按生命周期顺序等待钩子；`AssistantMessageStream` 已负责传输背压。

### 摘要重试事件

配置重试策略后，临时 provider 错误会产生：

- `retry_scheduled`：包含 operation、attempt、maxAttempts、delayMs、errorMessage；
- `retry_attempt_start`：退避完成，重试开始；
- `retry_finished`：重试成功、耗尽或中止。

它们仅供观察，不接受钩子结果。

## 规划中的会话外观

扩展最终使用 Harness 作用域的 `HarnessSession`，由外观强制待处理写入顺序。读取只返回持久化状态；idle 写入立即持久化，busy 写入入队。规划中的诊断 API：

```ts
getPendingWrites(): readonly PendingSessionWrite[]
```

Agent 消息在 `message_end` 持久化；扩展写入在保存点随后刷新。

## 中止

turn 中允许 `abort`，会中止底层运行并清空 steering/follow-up 队列，但保留 `nextTurn` 消息。待处理写入在下一保存点、`agent_end` 或失败清理时刷新。中止屏障仍需审查。

## 压缩与树导航

压缩、树导航是仅限 idle 的结构性会话变更，不排队，下一次 prompt 创建新快照。分支摘要属于树导航；自动压缩和重试决策点尚未实现。

## 测试组织

当前测试：

- `packages/agent/test/harness/agent-harness.test.ts`：核心生命周期和公共 API；
- `packages/agent/test/harness/agent-harness-stream.test.ts`：stream options 和 provider 钩子。

后续可拆分 resources、tools、lifecycle 测试。使用 `pi-ai` faux provider（`registerFauxProvider`、`fauxAssistantMessage`）避免真实 API。覆盖率命令：

```bash
npm run test:harness
npm run coverage:harness
```

`coverage:harness` 覆盖 `test/harness/**/*.test.ts`、`src/harness/**/*.ts` 以及直接使用的 `src/agent.ts`、`src/agent-loop.ts`。

## 实现待办

### 1. 工具注册表读写语义

状态：进行中。已增加 `setTools`、`setActiveTools`、`getTools`、`getActiveTools`、队列模式 getter/setter、`tools_update` 事件和持久化 `active_tools_change`；重复名称及无效活动工具会拒绝。剩余：无。

### 2. 每个 `AgentHarness` 的模型注册表

状态：计划中。需决定注册表来源、保存对象或引用、选择校验以及活动 turn/保存点变更语义。

### 3. 完整生命周期/状态审查

状态：进行中。已实现显式 phase、turn 快照、保存点刷新、待处理写入刷新、队列回滚、消息先持久化、abort 取消屏障和持久化 leaf。剩余：最终阶段语义、settled 时序、settled 写入、follow-up、自动压缩、重试、before_agent_start、busy 事件时序和 abort 屏障审查。

### 4. 通用钩子/事件机制

状态：已在 [hooks.md](./hooks.md) 设计，尚未实现。需增加 `HookEvent`、`ResultOf`、注册元数据、hooks 实现、reducer、上下文外观和对等测试。

### 5. 半持久化恢复试验

状态：计划中。设计见 [durable-harness.md](./durable-harness.md)。需定义队列、写入、操作、turn、provider 请求和工具调用条目及保守恢复策略。

### 6. 生命周期加固测试

状态：计划中。需覆盖监听器/钩子重入、配置和队列更新、busy 拒绝、abort、getter、消息顺序及各类失败后的 phase 清理。

### 7. coding-agent 迁移计划

状态：计划中。需映射资源加载、保留应用层来源/去重、适配扩展、迁移流/认证/重试/请求头行为。

---

## 已完成的实现待办

### 8. 移除 `AgentHarness` 对 `Agent` 的依赖

状态：完成。Harness 直接调用 `runAgentLoop()`，负责生命周期、中止、队列、provider 流、事件、会话、待处理写入和快照；测试覆盖 prompt、队列、abort、保存点、顺序、监听器、工具钩子和 provider 流。

### 9. 完善 provider/stream 配置

状态：完成。已增加 `AgentHarnessOptions.streamOptions`、getter/setter、按 turn 快照、认证解析、provider 钩子、字段删除和链式补丁；`agent-harness-stream.test.ts` 已覆盖相关行为。

### 10. 完成底层 `Result` 清理

状态：完成。已增加通用 `Result<TValue, TError>`，更新 `ExecutionEnv`/ `NodeExecutionEnv`、文件系统与 shell 能力、JSONL 存储、资源加载、shell 输出、压缩/分支摘要、错误映射和测试。保持底层 Result API 非抛出，会话 API 使用 `SessionError`，公共 Harness 失败使用 `AgentHarnessError`；Node 专用实现隔离在 `src/harness/env/nodejs.ts` 等入口。
