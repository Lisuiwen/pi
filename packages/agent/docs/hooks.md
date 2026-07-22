# AgentHarness 钩子设计

<!-- Synced from jot 3utlzkxy. Edit this file in-repo going forward. -->

最终设计。

## 核心模型

Events carry their result type as a type-only phantom:

```ts
declare const HookResult: unique symbol;

interface HookEvent<TType extends string, TResult = void> {
	type: TType;
	readonly [HookResult]?: TResult;
}

type ResultOf<E> = E extends { readonly [HookResult]?: infer R } ? R : void;

type HookHandler<E, Ctx> = (
	event: E,
	ctx: Ctx,
	signal?: AbortSignal,
) => ResultOf<E> | void | Promise<ResultOf<E> | void>;

type HookObserver<E, Ctx> = (
	event: E,
	ctx: Ctx,
	signal?: AbortSignal,
) => void | Promise<void>;
```

Example:

```ts
interface ContextEvent extends HookEvent<"context", { messages?: AgentMessage[] }> {
	type: "context";
	messages: AgentMessage[];
}

interface ToolCallEvent extends HookEvent<"tool_call", { block?: boolean; reason?: string }> {
	type: "tool_call";
	toolName: string;
	input: Record<string, unknown>;
}

interface MessageEndEvent extends HookEvent<"message_end"> {
	type: "message_end";
	message: AgentMessage;
}
```

不使用结果映射表或规范表；事件类型自行定义结果。

## 钩子接口

```ts
interface AgentHarnessHooks<E extends HookEvent<string, unknown>, Ctx> {
	context: Ctx;

	setContext(ctx: Ctx): void;

	observe(handler: HookObserver<E, Ctx>): () => void;

	on<TType extends E["type"]>(
		type: TType,
		handler: HookHandler<Extract<E, { type: TType }>, Ctx>,
	): () => void;

	emit<TEvent extends E>(
		event: TEvent,
		signal?: AbortSignal,
	): Promise<ResultOf<TEvent> | undefined>;

	addCleanup(cleanup: () => void | Promise<void>): () => void;

	clear(): Promise<void>;
	dispose(): Promise<void>;
}
```

关键划分：

- `observe()` 查看所有事件，只读且忽略返回值。
- `on(type, handler)` 参与对应事件的语义处理。
- `emit(event)` 是 `AgentHarness` 唯一调用的方法。
- `clear()` 移除观察器/处理器并执行清理函数。

## 默认实现内部结构

```ts
class DefaultAgentHarnessHooks<E extends HookEvent<string, unknown>, Ctx>
	implements AgentHarnessHooks<E, Ctx> {
	context: Ctx;

	private observers = new Set<HookObserver<E, Ctx>>();
	private handlers = new Map<string, Set<HookHandler<any, Ctx>>>();
	private cleanups = new Set<() => void | Promise<void>>();

	constructor(ctx: Ctx) {
		this.context = ctx;
	}

	setContext(ctx: Ctx): void {
		this.context = ctx;
	}

	observe(handler: HookObserver<E, Ctx>): () => void {
		this.observers.add(handler);
		return () => this.observers.delete(handler);
	}

	on(type, handler): () => void {
		let handlers = this.handlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(type, handlers);
		}
		handlers.add(handler);
		return () => handlers.delete(handler);
	}

	async emit(event, signal?) {
		for (const observer of this.observers) {
			await observer(event, this.context, signal);
		}

		switch (event.type) {
			case "context":
				return this.emitContext(event, signal);
			case "before_provider_request":
				return this.emitBeforeProviderRequest(event, signal);
			case "before_provider_payload":
				return this.emitBeforeProviderPayload(event, signal);
			case "before_agent_start":
				return this.emitBeforeAgentStart(event, signal);
			case "tool_call":
				return this.emitToolCall(event, signal);
			case "tool_result":
				return this.emitToolResult(event, signal);
			case "session_before_compact":
			case "session_before_tree":
				return this.emitFirstCancelOrLast(event, signal);
			default:
				await this.emitObservationHandlers(event, signal);
				return undefined;
		}
	}
}
```

由于 `Map<string, ...>` 会丢失具体类型，实现在内部使用类型断言是可接受的；公共 API 仍保持类型安全。

## 变更语义

### 观察

```ts
await hooks.emit({ type: "message_end", message }, signal);
```

观察器和 `message_end` 处理器依次运行。除非该事件后来增加结果类型，否则忽略返回值。

### 上下文转换

处理器按注册顺序运行，每个处理器都能看到当前消息。

```ts
let current = event;

for (const handler of handlers("context")) {
	const result = await handler(current, ctx, signal);
	if (result?.messages) {
		current = { ...current, messages: result.messages };
	}
}

return current.messages === event.messages ? undefined : { messages: current.messages };
```

### Provider 请求/负载

按顺序转换，每个处理器看到前一个处理器的输出。

```ts
let current = event;

for (const handler of handlers("before_provider_payload")) {
	const result = await handler(current, ctx, signal);
	if (result !== undefined) {
		current = { ...current, payload: result.payload };
	}
}

return changed ? { payload: current.payload } : undefined;
```

### Agent 启动前

收集注入的消息，并串联系统提示词。

```ts
let systemPrompt = event.systemPrompt;
const messages = [];

for (const handler of handlers("before_agent_start")) {
	const result = await handler({ ...event, systemPrompt }, ctx, signal);
	if (result?.messages) messages.push(...result.messages);
	if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
}

return messages.length || systemPrompt !== event.systemPrompt
	? { messages, systemPrompt }
	: undefined;
```

### 工具调用

按顺序执行，遇到阻止结果立即退出。

```ts
for (const handler of handlers("tool_call")) {
	const result = await handler(event, ctx, signal);
	if (result?.block) return result;
}
```

### 工具结果

按顺序累积补丁，每个处理器都能看到当前已修改的结果。

```ts
let current = event;
let modified = false;

for (const handler of handlers("tool_result")) {
	const result = await handler(current, ctx, signal);
	if (!result) continue;

	current = {
		...current,
		content: result.content ?? current.content,
		details: result.details ?? current.details,
		isError: result.isError ?? current.isError,
	};

	modified = true;
}

return modified
	? { content: current.content, details: current.details, isError: current.isError }
	: undefined;
```

### 会话前置事件

按顺序执行，遇到取消结果立即退出。

```ts
let last;

for (const handler of handlers(event.type)) {
	const result = await handler(event, ctx, signal);
	if (!result) continue;
	last = result;
	if (result.cancel) return result;
}

return last;
```

## Harness 用法

Harness 只负责调用：

```ts
await this.hooks.emit(event, signal);
```

或者：

```ts
const result = await this.hooks.emit({ type: "context", messages }, signal);
return result?.messages ?? messages;
```

Harness 不保存处理器、不串联监听器，也不感知扩展策略。

## 上下文

上下文是普通对象，不会在每次 `emit` 时重建。

```ts
const hooks = new CodingAgentHooks({
	harness: harnessFacade,
	session: sessionFacade,
	ui: noUiFacade,
});
```

之后：

```ts
hooks.setContext({
	...hooks.context,
	ui: tuiFacade,
});
```

对于动态状态，优先使用稳定的 facade/方法，避免复杂的 getter 嵌套：

```ts
interface CodingAgentHookContext {
	harness: HarnessFacade;
	session: SessionFacade;
	ui: UiFacade;
	models: ModelFacade;
}
```

每次运行的 `signal` 作为处理器的第三个参数传入。

## 后续加载扩展

扩展加载器可以与 harness 并列，并负责构造钩子：

```ts
const hooks = await loadExtensions({
	paths,
	context,
	hooks: new CodingAgentHooks(context),
});
const harness = new AgentHarness({ ..., hooks });
```

加载器向钩子注册：

```ts
hooks.on("context", handler);
hooks.on("tool_call", handler);
hooks.addCleanup(cleanup);
```

重新加载时：

```ts
await hooks.clear();
const nextHooks = await loadExtensions(...);
harness.setHooks(nextHooks); // idle-only if supported
```

## Poking holes

### 1. 必须明确错误策略

现有 coding-agent 会捕获扩展错误、报告后继续运行。新钩子也应采用相同策略，例如：

```ts
errorMode: "continue" | "throw"
onError(error)
```

对 coding-agent，默认值应为 `"continue"`。

### 2. 来源元数据很重要

现有 runner 知道错误、资源或工具来自哪个扩展。普通 `on()` 会丢失这些信息，除非增加注册元数据或作用域。

可能需要：

```ts
const scope = hooks.createScope({ sourceInfo });
scope.on("context", handler);
scope.addCleanup(...);
```

Or `on(type, handler, { sourceInfo })`.

### 3. 某些扩展能力是注册表，而不是钩子

这些能力不由 `emit()` 覆盖，应继续作为 `CodingAgentHooks` 或扩展宿主上的注册表：

- tools
- commands
- shortcuts
- flags
- message renderers
- provider registrations
- OAuth providers
- custom model providers

这是合理的；它们不属于 `AgentHarness`。

### 4. 现有 coding-agent 事件都可以表示

以下事件均没有阻碍：

- `context`
- `before_provider_request`
- `after_provider_response`
- `before_agent_start`
- `message_end`
- `tool_call`
- `tool_result`
- `input`
- `user_bash`
- `resources_discover`
- `session_before_*`
- `session_*`
- model/thinking selection events
- agent/turn/message/tool lifecycle events

它们会成为由 `CodingAgentHooks` 处理的附加事件类型。

### 5. 必须保留旧语义

迁移 coding-agent 时必须复制以下特殊规则：

- `input`: transform chain, `handled` short-circuits.
- `user_bash`: first meaningful result wins.
- `message_end`: replacement must keep same role.
- `before_agent_start`: `ctx.getSystemPrompt()` must reflect current chained prompt.
- `resources_discover`: aggregate paths and keep extension source.
- `tool_call`: argument mutation remains visible to later handlers.
- `tool_result`: later handlers see prior patches.

该设计支持所有规则，但默认实现和 coding hooks 实现必须明确编码这些语义。

### 6. `emit()` 的分支可能遗漏自定义变更事件

如果子类新增会产生结果的事件却忘记覆写 `emit()`，该事件会退化为仅观察行为。测试应捕获此问题；若日后风险变高，可增加受保护的策略注册表。

### 7. 观察器语义是有意限制的

观察器只会看到一次原始事件，不会看到每次中间变更。若需要最终转换状态，应发出单独的最终事件或使用事件专用处理器。

## 结论

该设计可以实现新的 coding-agent。它比当前 runner 更简单，能保持 harness 清晰；只要 `CodingAgentHooks` 增加带来源作用域、注册表、清理机制，并严格保留旧事件语义，就能保留关键扩展能力。

--- Comments ---

关于“addCleanup(cleanup”的线程 hn2xk0tzhj
  [tmluyaub9v] Owner（2026-05-14T12:55:45.500Z）：应允许将 cleanup 可选地传递给 on/observe
