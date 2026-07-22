/** 模块职责：实现 packages/agent/src\types.ts 的 Agent 运行时逻辑。 */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

/** Agent 循环使用的流函数，`Models.streamSimple` 符合此签名。
 * 失败应编码在事件流及最终消息中（stopReason 为 error/aborted），而不是抛出异常。
 */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** 配置同一助手消息中工具调用的执行方式：顺序执行，或先准备后并发执行。 */
export type ToolExecutionMode = "sequential" | "parallel";

/** 控制循环到达队列排空点时注入多少条排队用户消息。 */
export type QueueMode = "all" | "one-at-a-time";

/** 助手消息发出的单个工具调用内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * `beforeToolCall` 返回的结果。
 *
 * 返回 `{ block: true }` 会阻止工具执行，循环改为发出错误工具结果。
 * `reason` 会成为该错误结果显示的文本；省略时使用默认的阻止消息。
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * `afterToolCall` 返回的部分覆盖项。
 *
 * 按字段合并：
 * - `content`：若提供，完整替换工具结果内容数组
 * - `details`：若提供，完整替换工具结果详情值
 * - `isError`：若提供，替换工具结果的错误标志
 * - `usage`：若提供，替换工具结果的用量信息
 * - `terminate`：若提供，替换提前终止提示
 *
 * 省略的字段保留工具执行结果中的原值。
 * `content`、`details` 和 `usage` 不进行深度合并。
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/** 最终工具执行本身的用量（如有），不计入主 LLM 上下文用量。 */
	usage?: Usage;
	/**
	 * 提示 Agent 应在当前工具批次结束后停止。
	 * 仅当批次中所有已定稿工具结果都将其设为 true 时才提前终止。
	 */
	terminate?: boolean;
}

/** 传给 `beforeToolCall` 的上下文。 */
export interface BeforeToolCallContext {
	/** 发起工具调用的助手消息。 */
	assistantMessage: AssistantMessage;
	/** 来自 `assistantMessage.content` 的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 按目标工具 schema 校验后的参数。 */
	args: unknown;
	/** 准备工具调用时的 Agent 上下文。 */
	context: AgentContext;
}

/** 传给 `afterToolCall` 的上下文。 */
export interface AfterToolCallContext {
	/** 请求该工具调用的助手消息。 */
	assistantMessage: AssistantMessage;
	/** 来自 `assistantMessage.content` 的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 按目标工具 schema 校验后的参数。 */
	args: unknown;
	/** 应用任何 `afterToolCall` 覆盖前的工具执行结果。 */
	result: AgentToolResult<any>;
	/** 当前是否将工具执行结果视为错误。 */
	isError: boolean;
	/** 工具调用定稿时的当前 Agent 上下文。 */
	context: AgentContext;
}

/** 传给 `shouldStopAfterTurn` 的上下文。 */
export interface ShouldStopAfterTurnContext {
	/** 完成本回合的助手消息。 */
	message: AssistantMessage;
	/** 传给前一个 `turn_end` 事件的工具结果消息。 */
	toolResults: ToolResultMessage[];
	/** 追加本回合助手消息和工具结果后的当前 Agent 上下文。 */
	context: AgentContext;
	/** 若循环此时退出，本次调用将返回的消息。提示运行包含初始提示消息；继续运行不包含已有上下文消息。 */
	newMessages: AgentMessage[];
}

/** Agent 循环发起下一次提供商请求前可替换的运行时状态。 */
export interface AgentLoopTurnUpdate {
	/** 下一次提供商请求的上下文。 */
	context?: AgentContext;
	/** 下一次提供商请求使用的模型。 */
	model?: Model<any>;
	/** 下一次提供商请求使用的思考等级。 */
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * 每次调用 LLM 前，将 AgentMessage[] 转换为兼容 LLM 的 Message[]。
	 *
	 * 每条 AgentMessage 都必须转换为 LLM 能理解的 UserMessage、AssistantMessage 或 ToolResultMessage。
	 * 无法转换的 AgentMessage（如仅供 UI 使用的通知、状态消息）应被过滤掉。
	 *
	 * 契约：不得抛出异常或拒绝 Promise，应改为返回安全的回退值。
	 * 抛出异常会中断底层 Agent 循环，且不会产生正常的事件序列。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // 将自定义消息转换为用户消息
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // 过滤仅供 UI 使用的消息
	 *     return [];
	 *   }
	 *   // 透传标准 LLM 消息
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 在 `convertToLlm` 前对上下文执行的可选转换。
	 *
	 * 用于在 AgentMessage 层执行操作：
	 * - 管理上下文窗口（裁剪旧消息）
	 * - 注入外部来源的上下文
	 *
	 * 契约：不得抛出异常或拒绝 Promise，应改为返回原始消息或其他安全的回退值。
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 为每次 LLM 调用动态解析 API key。
	 *
	 * 适用于可能在长时间工具执行阶段过期的短期 OAuth 令牌（如 GitHub Copilot）。
	 *
	 * 契约：不得抛出异常或拒绝 Promise；没有可用 key 时返回 undefined。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 每个回合完全结束且已发出 `turn_end` 后调用。
	 *
	 * 若返回 true，循环会发出 `agent_end`，并在轮询 steering 或 follow-up 队列前退出，
	 * 不再发起下一次 LLM 调用。当前助手响应及所有工具执行仍会正常完成。
	 *
	 * 用于请求在当前回合后平稳停止，例如在上下文接近容量上限之前。
	 *
	 * 契约：不得抛出异常或拒绝 Promise。抛出异常会中断底层 Agent 循环，且不会产生正常事件序列。
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * 在 `turn_end` 后、循环决定是否发起下一次提供商请求前调用。
	 * 返回替换后的上下文、模型或思考状态，以影响本次运行的下一回合。
	 * 返回 undefined 则继续使用当前上下文和配置。
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * 返回在运行过程中注入对话的 steering 消息。
	 *
	 * 在当前助手回合完成工具调用后执行，除非 `shouldStopAfterTurn` 已先退出。
	 * 若返回消息，会在下一次 LLM 调用前加入上下文。
	 * 当前助手消息中的工具调用不会被跳过。
	 *
	 * 用于在 Agent 工作期间对其进行“引导”。
	 *
	 * 契约：不得抛出异常或拒绝 Promise；没有可用 steering 消息时返回 []。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 返回在 Agent 原本即将停止后处理的 follow-up 消息。
	 *
	 * 当 Agent 没有更多工具调用和 steering 消息时调用。
	 * 若返回消息，会将其加入上下文，Agent 随后继续下一回合。
	 *
	 * 用于需要等待 Agent 完成当前工作后再处理的 follow-up 消息。
	 *
	 * 契约：不得抛出异常或拒绝 Promise；没有可用 follow-up 消息时返回 []。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 工具执行模式。
	 * - "sequential"：逐个执行工具调用
	 * - "parallel"：先依次预检工具调用，再并发执行允许的工具；
	 *   每个工具定稿后按完成顺序发出 `tool_execution_end`，
	 *   随后按助手消息中的原始顺序发出工具结果消息
	 *
	 * 默认值："parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * 参数校验通过后、工具执行前调用。
	 *
	 * 返回 `{ block: true }` 可阻止执行，循环会改为发出错误工具结果。
	 * 钩子会收到 Agent 的中止信号，并负责响应它。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * 工具执行完成后、发出 `tool_execution_end` 和工具结果消息事件前调用。
	 *
	 * 返回 `AfterToolCallResult` 可覆盖工具执行结果的部分字段：
	 * - `content` 替换完整内容数组
	 * - `details` 替换完整详情载荷
	 * - `isError` 替换错误标志
	 * - `usage` 替换工具结果用量
	 * - `terminate` 替换提前终止提示
	 *
	 * 省略的字段保留原值，不进行深度合并。
	 * 钩子会收到 Agent 的中止信号，并负责响应它。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * 支持思考/推理的模型所使用的思考等级。
 * 注意：仅部分模型系列支持 "xhigh" 和 "max"。请使用 @earendil-works/pi-ai 中的模型
 * 思考等级元数据判断具体模型是否支持。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 可扩展的应用自定义消息接口。
 * 应用可通过声明合并扩展：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 默认为空，应用通过声明合并进行扩展
}

/**
 * AgentMessage：LLM 消息与自定义消息的联合类型。
 * 该抽象允许应用添加自定义消息类型，同时保持类型安全及与基础 LLM 消息的兼容性。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Agent 的公开状态。
 *
 * `tools` 和 `messages` 使用访问器属性，以便实现在存储前复制赋值数组。
 */
export interface AgentState {
	/** 每次模型请求都会发送的系统提示。 */
	systemPrompt: string;
	/** 后续回合使用的当前模型。 */
	model: Model<any>;
	/** 后续回合请求的推理等级。 */
	thinkingLevel: ThinkingLevel;
	/** 可用工具。赋值新数组时会复制其顶层结构。 */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** 对话记录。赋值新数组时会复制其顶层结构。 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * Agent 正在处理提示或继续运行时为 true。
	 *
	 * 该值会保持 true，直到所有待等待的 `agent_end` 监听器完成。
	 */
	readonly isStreaming: boolean;
	/** 当前流式响应的部分助手消息（如有）。 */
	readonly streamingMessage?: AgentMessage;
	/** 当前正在执行的工具调用 ID。 */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** 最近一次失败或中止的助手回合所产生的错误消息（如有）。 */
	readonly errorMessage?: string;
}

/** 工具产生的最终或部分结果。 */
export interface AgentToolResult<T> {
	/** 返回给模型的文本或图片内容。 */
	content: (TextContent | ImageContent)[];
	/** 用于日志或 UI 渲染的任意结构化详情。 */
	details: T;
	/** 最终工具执行本身的用量（如有），不计入主 LLM 上下文用量。 */
	usage?: Usage;
	/** 此结果引入、并从对话记录当前位置起可用的工具名称。 */
	addedToolNames?: string[];
	/**
	 * 提示 Agent 应在当前工具批次结束后停止。
	 * 仅当批次中所有已定稿工具结果都将其设为 true 时才提前终止。
	 */
	terminate?: boolean;
}

/** 工具用于推送部分执行结果的回调；execute() 结束后的调用会被忽略。 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Agent 运行时使用的工具定义。 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** 供 UI 显示的可读标签。 */
	label: string;
	/**
	 * schema 校验前用于处理原始工具调用参数的可选兼容层。
	 * 必须返回符合 `TParameters` 的对象。
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** 执行工具调用。失败时抛出异常，不要将错误编码进 `content`。 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * 针对单个工具覆盖执行模式。
	 * - "sequential"：此工具必须与其他工具调用逐个执行。
	 * - "parallel"：此工具可与其他工具调用并发执行。
	 *
	 * 省略时使用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;
}

/** 传入底层 Agent 循环的上下文快照。 */
export interface AgentContext {
	/** 请求中包含的系统提示。 */
	systemPrompt: string;
	/** 模型可见的对话记录。 */
	messages: AgentMessage[];
	/** 本次运行可用的工具。 */
	tools?: AgentTool<any>[];
}

/** Agent 为 UI 更新发出的事件；agent_end 发出后仍需等待订阅者完成，才算空闲。 */
export type AgentEvent =
	// Agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// 回合生命周期：一个回合包含一次助手响应及其所有工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期：为 user、assistant 和 toolResult 消息发出
	| { type: "message_start"; message: AgentMessage }
	// 仅在助手消息流式传输期间发出
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
