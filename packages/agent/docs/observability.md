<!-- Synced from jot qe0ikdqs. Edit this file in-repo going forward. -->

# Pi 可观测性设计笔记

## 目标

使 `packages/ai` 和 `packages/agent` /harness 可观察，无需依赖 OpenTelemetry、Sentry 或任何 APM 供应商。

 Pi 应该发出稳定的、结构化的生命周期事件。外部侦听器可以将这些事件转换为 OTel 范围、Sentry 范围、日志、指标或自定义遥测数据。

## 心理模型

痕迹是工作的一棵因果树，例如一个用户轮流。

跨度是该树中的一个定时操作。它通常由 ID 表示，而不是对象指针：```ts
interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  status: "ok" | "error";
}
```
示例树：```text
traceId=t1 spanId=s1 parent=-  name=pi.agent.prompt
traceId=t1 spanId=s2 parent=s1 name=pi.agent.turn
traceId=t1 spanId=s3 parent=s2 name=pi.ai.provider.request
traceId=t1 spanId=s4 parent=s2 name=pi.agent.tool_call
traceId=t1 spanId=s5 parent=s4 name=pi.session.append_entry
```
## 异步上下文

 JavaScript 有一个事件循环，但多个异步链可以交错。单个全局 `currentContext` 在并发情况下崩溃。

 `AsyncLocalStorage` 是用于异步延续的 `ThreadLocal` 的 Node 等效项。它允许并发操作保持不同的当前上下文：```ts
await Promise.all([
  runWithPiContext({ userId: "alice" }, () => harness.prompt("A")),
  runWithPiContext({ userId: "bob" }, () => harness.prompt("B")),
]);
```
然后，深层代码可以读取活动异步链的正确当前上下文。

 Pi 必须运行在 Node、Bun、浏览器、workers 和其他 JS 运行时中，因此 ALS 不能成为核心抽象。它应该是一个运行时适配器。

## 核心设计

 Pi 拥有一个小的与运行时无关的可观察性抽象：```ts
export interface PiObservabilityContext {
  traceId?: string;
  currentSpanId?: string;
  userContext?: Record<string, unknown>;
}

export interface PiObservabilityEvent {
  type: "start" | "end" | "error" | "event";
  name: string;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  timestamp: number;
  durationMs?: number;
  context?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  error?: { name: string; message: string };
}

export interface PiObservability {
  getContext(): PiObservabilityContext | undefined;
  runWithContext<T>(context: PiObservabilityContext, fn: () => T): T;
  emit(event: PiObservabilityEvent): void;
  hasSubscribers(): boolean;
}
```
公共API：```ts
export function configurePiObservability(observability: PiObservability): void;
export function subscribePiObservability(listener: (event: PiObservabilityEvent) => void): () => void;
export function runWithPiContext<T>(userContext: Record<string, unknown>, fn: () => T): T;
export function traceOperation<T>(name: string, payload: Record<string, unknown>, fn: () => T): T;
```
`traceOperation()`：

1.读取当前上下文
2. 如果缺失则创建 `traceId`
3. 创建一个新的 `spanId`
4. 使用当前跨度作为 `parentSpanId`
5. 发出 `start`
6. 在子上下文下运行回调
7. 发出 `end` 或 `error`
8. 错误重新抛出

伪代码：```ts
function traceOperation<T>(name: string, payload: Record<string, unknown>, fn: () => T): T {
  const parent = getContext();
  const traceId = parent?.traceId ?? createId();
  const spanId = createId();
  const parentSpanId = parent?.currentSpanId;

  const child = { ...parent, traceId, currentSpanId: spanId };

  emit({ type: "start", name, traceId, spanId, parentSpanId, timestamp: Date.now(), context: parent?.userContext, payload });

  return runWithContext(child, () => {
    try {
      const result = fn();
      // Promise-aware implementation emits end/error after settlement.
      emit({ type: "end", name, traceId, spanId, parentSpanId, timestamp: Date.now(), context: child.userContext, payload });
      return result;
    } catch (error) {
      emit({ type: "error", name, traceId, spanId, parentSpanId, timestamp: Date.now(), context: child.userContext, payload, error: serializeError(error) });
      throw error;
    }
  });
}
```
## 运行时适配器

核心包不应导入仅限 Node 的 API。

可能的实现：

- 节点适配器：`AsyncLocalStorage` 用于上下文，可选 `diagnostics_channel` 发布。
- 浏览器/工作人员后备：本地订阅者集和有限/手动上下文传播。
- Bun/Deno 适配器：使用运行时特定的异步上下文（如果可用）。

对于 Node，诊断通道可以用作被动事件总线：```ts
import { channel } from "diagnostics_channel";
channel("pi.observability").publish(event);
```
订阅者可以创建 OTel/Sentry 跨度，而无需对 pi 进行猴子修补。

## pi 发出什么

 Pi 发出发生的情况。它不会直接创建 OTel/Sentry 跨度。

初始最小事件名称：```text
pi.agent.prompt
pi.agent.skill
pi.agent.prompt_template
pi.agent.compaction
pi.agent.branch_navigation
pi.agent.session.append_entry
pi.ai.provider.request
```
每个操作都会发出：```text
start
end
error
```
后期补充：```text
pi.agent.turn
pi.agent.tool_call
pi.agent.queue_update
pi.ai.provider.retry
pi.ai.provider.first_token
pi.ai.provider.usage
pi.session.read
pi.session.write
```
## 最少的检测点

### 包/代理

包裹：

- `AgentHarness.prompt()`
- `AgentHarness.skill()`
- `AgentHarness.promptFromTemplate()`
- `AgentHarness.compact()`
- `AgentHarness.navigateTree()`
- `Session.appendTypedEntry()`或存储附加立面

示例：```ts
return traceOperation(
  "pi.agent.prompt",
  {
    sessionId: turnState.sessionId,
    provider: turnState.model.provider,
    model: turnState.model.id,
    promptLength: text.length,
    imageCount: options?.images?.length ?? 0,
  },
  () => this.executeTurn(turnState, text, options),
);
```
会话写入：```ts
return traceOperation(
  "pi.agent.session.append_entry",
  { entryType: entry.type },
  async () => {
    await this.unwrap(this.storage.appendEntry(entry));
    return entry.id;
  },
);
```
### 包/ai

包围常见的提供者边界：

- `streamSimple()`
- `completeSimple()`

示例：```ts
return traceOperation(
  "pi.ai.provider.request",
  {
    api: model.api,
    provider: model.provider,
    model: model.id,
    sessionId: options.sessionId,
    reasoning: options.reasoning,
  },
  () => actualStreamSimple(model, context, options),
);
```
结束/错误有效负载可以包含安全元数据：

- 停止原因
- 状态码
- 重试次数
- 输入/输出/总代币
- 总成本
- 中止/超时标志

## 安全和编辑

默认有效负载必须是安全的。

默认安全：

- 提供者
- 型号
- API 标识符
- 会话 ID
- 条目类型
- 工具名称
- 状态码
- 停止原因
- 令牌计数
- 成本
- 持续时间

默认情况下不安全：

- 提示
- 完工情况
- 工具参数
- 工具结果
- 外壳输出
- 文件内容
- 提供者请求有效负载
- 提供商响应机构
- API 键
- 标题

稍后可以通过显式编辑挂钩选择内容捕获。

## 听众行为

可观察性绝不能影响 pi 的执行。

订阅者的错误应该被吞掉或隔离。 Harness hooks 是控制平面的，可能会影响执行；可观察性订阅者是被动的，而且不应该这样做。

## 用户上下文

用户可以将任意上下文与回合关联起来：```ts
await runWithPiContext(
  {
    userId: "u123",
    orgId: "acme",
    region: "eu",
  },
  () => harness.prompt("fix this"),
);
```
该异步链内的每个发出的事件都包含上下文：```ts
{
  type: "start",
  name: "pi.ai.provider.request",
  traceId: "t1",
  spanId: "s3",
  parentSpanId: "s1",
  context: {
    userId: "u123",
    orgId: "acme",
    region: "eu",
  },
  payload: {
    provider: "anthropic",
    model: "claude-sonnet-4",
  },
}
```
OTel 适配器可以将其映射到跨度属性。 Sentry 适配器可以将其映射到 Sentry 上下文/跨度。自定义用户可以登录 JSON 。

## 包裹故事

最小初始包：```text
packages/observability
  runtime-agnostic context + traceOperation + subscribe
```
然后：```text
packages/ai
  emits pi.ai.* events

packages/agent
  emits pi.agent.* / pi.session.* events
```
稍后可选：```text
packages/observability-node
  AsyncLocalStorage + diagnostics_channel bridge

packages/otel
  subscribes to pi events and creates OpenTelemetry spans
```
## 论文

 Pi 定义了一个稳定、安全的事件合约。适配器定义事件的去向。

这使得 ai/harness 无需将核心包绑定到 OTel、Sentry、Node-only API 或猴子补丁即可观察。
