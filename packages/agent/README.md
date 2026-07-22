# @earendil-works/pi-agent-core

具有工具执行和事件流的状态代理。建立在 `@earendil-works/pi-ai` 之上。

## 安装

```bash
npm install @earendil-works/pi-agent-core
```
### SQLite 会话后端

SQLite 会话后端和 `node:sqlite` 适配器位于单独的包 `@earendil-works/pi-storage-sqlite-node` 中，因此默认情况下核心包不会引入运行时内置函数或本机 SQLite 依赖项。后端接受特定于运行时的 SQLite 工厂，允许其他存储后端将来作为自己的包提供。

## 快速入门

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model,
  },
  streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // Stream just the new text chunk
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello!");
```
## 核心概念

### AgentMessage 与 LLM 消息

该代理与 `AgentMessage` 一起使用，这是一种灵活的类型，可以包括：
- 标准LLM消息（`user`，`assistant`，`toolResult`）
- 通过声明合并自定义特定于应用程序的消息类型

LLM 只能理解 `user`、`assistant` 和 `toolResult`。 `convertToLlm` 函数通过在每次 LLM 调用之前过滤和转换消息来弥补这一差距。

### 消息流```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    (optional)                           (required)
```
1. **transformContext**：修剪旧消息，注入外部上下文
2. **convertToLlm**：过滤掉仅UI消息，将自定义类型转换为LLM格式

## 事件流程

代理发出 UI 更新事件。了解事件顺序有助于构建响应式界面。

###提示()事件序列

当您致电 `prompt("Hello")` 时：```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // Your prompt
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM starts responding
├─ message_update  { message: partial... }       // Streaming chunks
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // Complete response
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```
### 使用工具调用

如果助手调用工具，则循环继续：```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // If tool streams
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // Next turn
├─ message_start      { assistantMessage }           // LLM responds to tool result
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```
工具执行模式是可配置的：

- `parallel`（默认）：按顺序调用预检工具，同时执行允许的工具，每个工具完成后立即发出 `tool_execution_end`，然后按助手源顺序发出 toolResult 消息和 `turn_end.toolResults`
- `sequential` ：一一执行工具调用，匹配历史行为

在并行模式下，工具完成事件遵循工具完成顺序，但持久化的 toolResult 消息仍然遵循助手源顺序。

该模式可以通过代理配置中的 `toolExecution` 进行全局设置，也可以通过 `AgentTool` 上的 `executionMode` 针对每个工具进行设置。如果批处理中的任何工具调用以 `executionMode: "sequential"` 为目标工具，则整个批处理将按顺序执行，无论全局设置如何。

`beforeToolCall` 挂钩在 `tool_execution_start` 和经过验证的参数解析之后运行。它可以阻止执行。 `afterToolCall` 挂钩在工具执行完成后、`tool_execution_end` 和最终工具结果消息事件发出之前运行。

工具还可以返回 `terminate: true` 来提示应跳过自动后续 LLM 调用。仅当每个最终工具都导致该批次设置 `terminate: true` 时，循环才会提前停止。混批继续正常进行。

低级循环调用者可以设置 `shouldStopAfterTurn` 在当前回合完成后优雅停止：

```typescript
const stream = agentLoop(
  prompts,
  context,
  {
    model,
    convertToLlm,
    shouldStopAfterTurn: async ({ message, toolResults, context, newMessages }) => {
      return shouldCompactBeforeNextTurn(context.messages);
    },
  },
  undefined,
  models.streamSimple.bind(models),
);
```
`shouldStopAfterTurn` 在发出 `turn_end` 后、助手响应和任何工具执行正常完成后运行。如果它返回 `true` ，则循环会发出 `agent_end` 并在轮询转向或后续队列之前以及开始另一个 LLM 调用之前退出。它不会中止提供程序流，不会取消正在运行的工具，并且不会更改助手消息停止原因。

当您使用 `Agent` 类时，辅助 `message_end` 处理将被视为工具预检开始之前的障碍。这意味着 `beforeToolCall` 看到的代理状态已包含请求工具调用的助理消息。

### continue() 事件序列

`continue()` 从现有上下文中恢复，而不添加新消息。使用它在错误后重试。

```typescript
// After an error, retry from current state
await agent.continue();
```
上下文中的最后一条消息必须是 `user` 或 `toolResult` （不是 `assistant` ）。

### 事件类型

|活动 |描述 |
|--------|-------------|
|  `agent_start` |代理开始处理|
|  `agent_end` |跑步的最后一项活动。等待此活动的订阅者仍可计入结算 |
|  `turn_start` |新一轮开始（一次 LLM 调用 + 工具执行） |
|  `turn_end` |转弯完成并显示辅助消息和工具结果 |
|  `message_start` |任何消息开始（用户、助理、工具结果）|
|  `message_update` | **仅限助理。** 包括带有 delta 的 `assistantMessageEvent` |
|  `message_end` |留言完毕 |
|  `tool_execution_start` |工具开始|
|  `tool_execution_update` |工具流进展|
|  `tool_execution_end` |工具完成 |

 `Agent.subscribe()` 听众按注册顺序等待。  `agent_end` 意味着不会再发出循环事件，但 `await agent.waitForIdle()` 和 `await agent.prompt(...)` 仅在等待的 `agent_end` 侦听器完成后才稳定。

## 代理选项

```typescript
const agent = new Agent({
  // Initial state
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // Convert AgentMessage[] to LLM Message[] (required for custom message types)
  convertToLlm: (messages) => messages.filter(...),

  // Transform context before convertToLlm (for pruning, compaction)
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // Steering mode: "one-at-a-time" (default) or "all"
  steeringMode: "one-at-a-time",

  // Follow-up mode: "one-at-a-time" (default) or "all"
  followUpMode: "one-at-a-time",

  // Required stream function
  streamFn: models.streamSimple.bind(models),

  // Session ID for provider caching
  sessionId: "session-123",

  // Dynamic API key resolution (for expiring OAuth tokens)
  getApiKey: async (provider) => refreshToken(),

  // Tool execution mode: "parallel" (default) or "sequential"
  toolExecution: "parallel",

  // Preflight each tool call after args are validated. Can block execution.
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") {
      return { block: true, reason: "bash is disabled" };
    }
  },

  // Postprocess each tool result before final tool events are emitted.
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    if (toolCall.name === "notify_done" && !isError) {
      return { terminate: true };
    }
    if (!isError) {
      return { details: { ...result.details, audited: true } };
    }
  },

  // Custom thinking budgets for token-based providers
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```
## 代理状态

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```
通过 `agent.state` 访问状态。

分配 `agent.state.tools = [...]` 或 `agent.state.messages = [...]` 会在存储顶级数组之前复制它。改变返回的数组会改变当前代理状态。

在流式传输期间，`agent.state.streamingMessage` 包含当前的部分辅助消息。

 `agent.state.isStreaming` 仍然是 `true`，直到运行完全结束，包括等待的 `agent_end` 订户。

## 方法

### 提示

```typescript
// Text prompt
await agent.prompt("Hello");

// With images
await agent.prompt("What's in this image?", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

// AgentMessage directly
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// Continue from current context (last message must be user or toolResult)
await agent.continue();
```
### 状态管理

```typescript
agent.state.systemPrompt = "New prompt";
agent.state.model = getModel("openai", "gpt-4o");
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.toolExecution = "sequential";
agent.beforeToolCall = async ({ toolCall }) => undefined;
agent.afterToolCall = async ({ toolCall, result }) => undefined;
agent.state.messages = newMessages; // top-level array is copied
agent.state.messages.push(message);
agent.reset();
```
### 会话和思考预算

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```
### 控制

```typescript
agent.abort();           // Cancel current operation
await agent.waitForIdle(); // Wait for completion
```
### 事件

```typescript
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") {
    // Final barrier work for the run
    await flushSessionState(signal);
  }
});
unsubscribe();
```
## 指导和跟进

引导消息允许您在工具运行时中断 Agent。后续消息可让您在 Agent 停止后对工作进行排队。

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

// While agent is running tools
agent.steer({
  role: "user",
  content: "Stop! Do this instead.",
  timestamp: Date.now(),
});

// After the agent finishes its current work
agent.followUp({
  role: "user",
  content: "Also summarize the result.",
  timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```
使用clearSteeringQueue、clearFollowUpQueue 或clearAllQueues 删除排队的消息。

当转弯完成后检测到转向消息时：
1. 当前助手消息中的所有工具调用均已完成
2. 注入转向消息
3. LLM在下一轮做出回应

仅当不再有工具调用且没有转向消息时才会检查后续消息。如果有任何队列，它们将被注入并运行另一个回合。

## 自定义消息类型

通过声明合并扩展 `AgentMessage`：

```typescript
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

// Now valid
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```
处理 `convertToLlm` 中的自定义类型：

```typescript
const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return []; // Filter out
    return [m];
  }),
});
```
## 工具

使用 `AgentTool` 定义工具：

```typescript
import { Type } from "typebox";

const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",  // For UI display
  description: "Read a file's contents",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  // Override execution mode for this tool (optional).
  // "sequential" forces the entire batch to run one at a time.
  // "parallel" allows concurrent execution with other tool calls.
  // If omitted, the global toolExecution config applies.
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    // Optional: stream progress
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

    // Optional: add `terminate: true` here to skip the automatic follow-up LLM call
    // when every finalized tool result in the batch does the same.
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

agent.state.tools = [readFileTool];
```
### 错误处理

**当工具失败时抛出错误**。不要将错误消息作为内容返回。

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }
  // Return content only on success
  return { content: [{ type: "text", text: "..." }] };
}
```
抛出的错误由代理捕获，并以 `isError: true` 作为工具错误报告给 LLM。

从 `execute()` 或 `afterToolCall` 返回 `terminate: true` 以提示代理应在当前工具批次后停止。仅当批次中的每个最终工具结果终止时，此操作才会生效。该提示仅适用于运行时；发出的 `toolResult` 转录消息仍然是标准的 LLM 工具结果。

## 代理使用

对于通过后端代理的浏览器应用程序：

```typescript
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```
## 低级 API 

对于不使用 Agent 类的直接控制：

```typescript
import { agentLoop, agentLoopContinue } from "@earendil-works/pi-agent-core";

const context: AgentContext = {
  systemPrompt: "You are helpful.",
  messages: [],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel("openai", "gpt-4o"),
  convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
  toolExecution: "parallel",  // overridden by per-tool executionMode if set
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

const streamFn = models.streamSimple.bind(models);
for await (const event of agentLoop([userMessage], context, config, undefined, streamFn)) {
  console.log(event.type);
}

// Continue from existing context
for await (const event of agentLoopContinue(context, config, undefined, streamFn)) {
  console.log(event.type);
}
```
这些低层流是可观察的。它们保留事件顺序，但在后续生产者阶段继续之前，它们不会等待异步事件处理解决。如果您需要消息处理作为工具预检之前的屏障，请使用 `Agent` 类而不是原始 `agentLoop()` 或 `agentLoopContinue()` 。

## 许可证

麻省理工学院
