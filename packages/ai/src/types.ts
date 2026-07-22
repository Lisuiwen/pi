/** 模块职责：实现 packages/ai/src\types.ts 相关的模型、协议或工具逻辑。 */
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import type { BedrockOptions } from "./api/bedrock-converse-stream.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { PiMessagesOptions } from "./api/pi-messages.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "pi-messages";

export type Api = KnownApi | (string & {});

export type KnownImagesApi = "openrouter-images";

export type ImagesApi = KnownImagesApi | (string & {});

export type KnownProvider =
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "radius"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";
export type ProviderId = KnownProvider | string;

export type KnownImagesProvider = "openrouter";

export type ImagesProviderId = KnownImagesProvider | string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
export type ChatTemplateKwargValue =
	| string
	| number
	| boolean
	| null
	| {
			$var: "thinking.enabled" | "thinking.effort";
			omitWhenOff?: boolean;
	  };

/** 各思考等级对应的 token 预算（仅适用于按 token 计量的提供商）。 */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

// 所有提供商共享的基础选项。
export type CacheRetention = "none" | "short" | "long";

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** 提供商作用域内的环境变量覆盖值，其优先级高于 `process.env`。 */
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * 对支持多种传输方式的提供商指定首选传输层。
	 * 不支持该选项的提供商会直接忽略它。
	 */
	transport?: Transport;
	/**
	 * 提示缓存保留偏好。各提供商会映射到自身支持的取值。
	 * 默认值为 `"short"`。
	 */
	cacheRetention?: CacheRetention;
	/**
	 * 对支持会话级缓存的提供商，传入可选会话标识符。
	 * 提供商可用它启用 prompt 缓存、请求路由或其他会话感知能力；
	 * 不支持该能力的提供商会忽略它。
	 */
	sessionId?: string;
	/**
	 * 可选回调，用于在发送前检查或替换提供商请求负载。
	 * 返回 `undefined` 表示保持负载不变。
	 */
	onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * 可选回调，在收到 HTTP 响应且尚未消费其 body 流之前触发。
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * 可选的自定义 HTTP 请求头，会被附加到 API 请求中。
	 * 它们会与提供商默认头合并，调用方传入的值优先。
	 * 在 AWS Bedrock 上，这些头会通过 Smithy 的 `build` 阶段中间件注入，
	 * 因而会纳入 SigV4 签名覆盖范围；保留头
	 * （`x-amz-*`、`authorization`、`host`）会被静默忽略，
	 * 以保留 SigV4 / bearer 认证正确性。
	 * 若某个值为 `null`，则表示屏蔽同名的提供商/API 默认头。
	 */
	headers?: ProviderHeaders;
	/**
	 * 对支持该能力的提供商/SDK 指定 HTTP 请求超时时间（毫秒）。
	 * 例如，OpenAI 与 Anthropic 的 SDK 客户端默认是 10 分钟。
	 */
	timeoutMs?: number;
	/**
	 * 对支持 WebSocket 传输的提供商指定连接超时时间（毫秒）。
	 * 这里只覆盖连接/握手阶段；连接建立后的流空闲超时仍由 `timeoutMs` 控制。
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * 对支持客户端重试的提供商/SDK 指定最大重试次数。
	 * 例如，OpenAI 与 Anthropic 的 SDK 客户端默认值为 2。
	 */
	maxRetries?: number;
	/**
	 * 当服务端要求长时间等待后再重试时，允许等待的最大延迟（毫秒）。
	 * 若服务端要求的延迟超过该值，请求会立刻失败，并把该延迟写入错误信息，
	 * 以便更高层的重试逻辑在用户可见的前提下自行处理。
	 * 默认值为 `60000`（60 秒）；设为 `0` 可关闭该上限。
	 */
	maxRetryDelayMs?: number;
	/**
	 * 可选元数据，会一并带到 API 请求中。
	 * 提供商只会提取自己认识的字段，其余字段会被忽略。
	 * 例如，Anthropic 会使用 `user_id` 做滥用追踪与限流。
	 */
	metadata?: Record<string, unknown>;
	/**
	 * 提供商作用域内的环境变量值，其优先级高于 `process.env`。
	 * 可用于区域设置、端点占位符、代理变量等提供商配置。
	 */
	env?: ProviderEnv;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

/**
 * 将已知 API 映射到各自完整的提供商专属流式选项类型。
 * 这里从 API 实现模块导入的都只是类型，编译产物中会被擦除，
 * 因此对 tree-shaking 安全。
 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-vertex": GoogleVertexOptions;
	"mistral-conversations": MistralOptions;
	"bedrock-converse-stream": BedrockOptions;
	"pi-messages": PiMessagesOptions;
}

/**
 * 某个 API 对应的完整流式选项类型。
 * 已知 API 会解析成其具体选项类型；自定义 API 字符串则回退到通用形状。
 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

/**
 * API 实现模块统一遵守的流式契约：`src/api/` 下每个模块都只导出
 * `stream` 与 `streamSimple`，因此模块本身即可满足该接口。
 * 惰性包装器（`lazyApi()`）与提供商工厂会把它们作为值传递。
 * 这是无类型分发层的统一形状；各 API 的具体选项类型仍定义在实现模块自身，
 * 以及 `Provider.stream()` 通过 `ApiStreamOptions` 暴露的签名里。
 */
export interface ProviderStreams {
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/**
 * 图像生成 API 实现模块统一遵守的契约：
 * `src/api/` 下每个图像 API 模块都只导出 `generateImages`，
 * 因此模块本身即可满足该接口。惰性包装器与图像提供商工厂会把它们作为值传递。
 */
export interface ProviderImages {
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

export interface ImagesOptions {
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * 提供商作用域内的环境变量值，其优先级高于 `process.env`。
	 * 可用于端点占位符、代理变量等提供商配置。
	 */
	env?: ProviderEnv;
	/**
	 * 可选回调，用于在发送前检查或替换提供商请求负载。
	 * 返回 `undefined` 表示保持负载不变。
	 */
	onPayload?: (payload: unknown, model: ImagesModel<ImagesApi>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * 可选回调，在收到 HTTP 响应后触发。
	 */
	onResponse?: (response: ProviderResponse, model: ImagesModel<ImagesApi>) => void | Promise<void>;
	/**
	 * 可选的自定义 HTTP 请求头，会被附加到 API 请求中。
	 * 它们会与提供商默认头合并，并可覆盖默认头。
	 * 若某个值为 `null`，则表示屏蔽同名的提供商/API 默认头。
	 */
	headers?: ProviderHeaders;
	/**
	 * 对支持该能力的提供商/SDK 指定 HTTP 请求超时时间（毫秒）。
	 */
	timeoutMs?: number;
	/**
	 * 对支持客户端重试的提供商/SDK 指定最大重试次数。
	 */
	maxRetries?: number;
	/**
	 * 当服务端要求长时间等待后再重试时，允许等待的最大延迟（毫秒）。
	 * 若服务端要求的延迟超过该值，请求会立刻失败，并把该延迟写入错误信息，
	 * 以便更高层的重试逻辑在用户可见的前提下自行处理。
	 * 默认值为 `60000`（60 秒）；设为 `0` 可关闭该上限。
	 */
	maxRetryDelayMs?: number;
	/**
	 * 可选元数据，会一并带到 API 请求中。
	 * 提供商只会提取自己认识的字段，其余字段会被忽略。
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

// 传给 `streamSimple()` 与 `completeSimple()` 的统一选项，包含 reasoning。
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	/** 各思考等级的自定义 token 预算（仅适用于按 token 计量的提供商）。 */
	thinkingBudgets?: ThinkingBudgets;
}

// 带类型化选项的通用 `StreamFunction`。
//
// 契约：
// - 必须返回 `AssistantMessageEventStream`。
// - 一旦被调用，请求/模型/运行时失败都应编码进返回的流中，而不是直接抛出。
// - 以错误结束时，必须产出一个 `stopReason` 为 `"error"` 或 `"aborted"`、
//   且带有 `errorMessage` 的 `AssistantMessage`，并通过流协议发出。
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

export type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // 例如 OpenAI Responses 的消息元数据（旧版 id 字符串或 TextSignatureV1 JSON）
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // 例如 OpenAI Responses 的 reasoning item ID
	/** 为 `true` 时表示思考内容已被安全过滤器脱敏。加密后的不透明负载会存放在
	 *  `thinkingSignature` 中，以便在多轮对话中原样回传给 API，保持上下文连续性。 */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string; // Base64 编码的图像数据
	mimeType: string; // 例如 `"image/jpeg"`、`"image/png"`
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google 专用：用于复用思维上下文的不透明签名
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 以 1 小时保留策略写入的 `cacheWrite` 子集。目前只有 Anthropic 会上报这一拆分。 */
	cacheWrite1h?: number;
	/**
	 * 当提供商上报时，对应的 reasoning/thinking token 数。
	 * 这是 `output` 的子集：`output` 已经包含这些 token。
	 * 能细分 reasoning 的提供商会填入数字（可能是 0）；
	 * 不支持细分的提供商则保持为 `undefined`。
	 */
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix 时间戳（毫秒）
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string; // 当与请求时的 `model` 不同，记录实际返回的 `chunk.model`（如 OpenRouter `auto` -> `anthropic/...`）
	responseId?: string; // 上游 API 暴露时使用的提供商专属 response/message 标识
	diagnostics?: AssistantMessageDiagnostic[]; // 失败与恢复场景下脱敏后的提供商/运行时诊断信息
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number; // Unix 时间戳（毫秒）
}

export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // 同时支持文本与图像
	details?: TDetails;
	/** 工具执行本身的 usage（若可获取）。不计入主 LLM 上下文统计。 */
	usage?: Usage;
	/**
	 * 该结果之后才变得可用的 `Context.tools` 中的工具名称。
	 * 原生支持延迟工具加载的提供商会把这里当作加载时机；
	 * 其他提供商会忽略它，照常使用 `Context.tools`。
	 */
	addedToolNames?: string[];
	isError: boolean;
	timestamp: number; // Unix 时间戳（毫秒）
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type ImagesInputContent = TextContent | ImageContent;
export type ImagesOutputContent = TextContent | ImageContent;

export interface ImagesContext {
	input: ImagesInputContent[];
}

export type ImagesStopReason = "stop" | "error" | "aborted";

export interface AssistantImages {
	api: ImagesApi;
	provider: ImagesProviderId;
	model: string;
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: ImagesStopReason;
	errorMessage?: string;
	timestamp: number; // Unix 时间戳（毫秒）
}

import type { TSchema } from "typebox";

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/**
 * `AssistantMessageEventStream` 的事件协议。
 *
 * 流应先发出 `start`，再发送各类增量更新，最后以以下两种方式之一结束：
 * - `done`：携带最终成功的 `AssistantMessage`
 * - `error`：携带最终失败的 `AssistantMessage`，其 `stopReason` 为 `"error"` 或 `"aborted"`，
 *   并附带 `errorMessage`
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/**
 * OpenAI 兼容 completions API 的兼容性设置。
 * 可用于为自定义提供商覆盖基于 URL 的自动检测结果。
 */
export interface OpenAICompletionsCompat {
	/** 提供商是否支持 `store` 字段。默认值：根据 URL 自动检测。 */
	supportsStore?: boolean;
	/** 提供商是否支持 `developer` 角色（而非 `system`）。默认值：根据 URL 自动检测。 */
	supportsDeveloperRole?: boolean;
	/** 提供商是否支持 `reasoning_effort`。默认值：根据 URL 自动检测。 */
	supportsReasoningEffort?: boolean;
	/** 提供商是否支持 `stream_options: { include_usage: true }`，以便在流式响应中返回 token usage。默认值：`true`。 */
	supportsUsageInStreaming?: boolean;
	/** `max tokens` 应使用哪个字段。默认值：根据 URL 自动检测。 */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** 工具结果是否要求带 `name` 字段。默认值：根据 URL 自动检测。 */
	requiresToolResultName?: boolean;
	/** 工具结果后的用户消息之间，是否必须插入一条 assistant 消息。默认值：根据 URL 自动检测。 */
	requiresAssistantAfterToolResult?: boolean;
	/** 思考块是否必须转换成带 `<thinking>` 分隔符的文本块。默认值：根据 URL 自动检测。 */
	requiresThinkingAsText?: boolean;
	/** 开启 reasoning 时，所有重放的 assistant 消息是否都必须带空的 `reasoning_content` 字段。默认值：根据 URL 自动检测。 */
	requiresReasoningContentOnAssistantMessages?: boolean;
	/** reasoning/thinking 参数格式。`"openai"` 使用 `reasoning_effort`；`"openrouter"` 使用 `reasoning: { effort }`；`"deepseek"` 使用 `thinking: { type }`，并在支持时附带 `reasoning_effort`；`"together"` 使用 `reasoning: { enabled }`，并在支持时附带 `reasoning_effort`；`"zai"` 使用 `thinking: { type }`；`"qwen"` 使用顶层 `enable_thinking: boolean`；`"qwen-chat-template"` 使用 `chat_template_kwargs.enable_thinking` 与 `preserve_thinking`；`"chat-template"` 使用可配置的 `chat_template_kwargs`；`"string-thinking"` 使用顶层 `thinking: string`；`"ant-ling"` 仅在映射后的 effort 非空时使用 `reasoning: { effort }`。默认值：`"openai"`。 */
	thinkingFormat?:
		| "openai"
		| "openrouter"
		| "deepseek"
		| "together"
		| "zai"
		| "qwen"
		| "chat-template"
		| "qwen-chat-template"
		| "string-thinking"
		| "ant-ling";
	/** 当 `thinkingFormat` 为 `chat-template` 时，作为 `chat_template_kwargs` 发送的参数。可使用 `{ "$var": "thinking.enabled" }` 或 `{ "$var": "thinking.effort" }` 让 pi 控制思考值。 */
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
	/** 通过请求体中的 `provider` 字段发送的 OpenRouter 兼容路由偏好。 */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway 的路由偏好。仅在 `baseUrl` 指向该网关时生效。 */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** z.ai 是否支持顶层 `tool_stream: true` 以流式返回工具调用增量。默认值：`false`。 */
	zaiToolStream?: boolean;
	/** 提供商是否支持工具定义中的 `strict` 字段。默认值：`true`。 */
	supportsStrictMode?: boolean;
	/** 提示缓存的 `cache control` 约定。`"anthropic"` 会按 Anthropic 风格，把 `cache_control` 标记应用到 system prompt、最后一个工具定义，以及最后一条用户/assistant/工具结果文本内容上。 */
	cacheControlFormat?: "anthropic";
	/** 是否根据 `options.sessionId` 发送会话亲和性数据。默认值：`false`。 */
	sendSessionAffinityHeaders?: boolean;
	/** 提供商专属的延迟工具序列化模式。 */
	deferredToolsMode?: "kimi";
	/** 会话亲和性请求头格式：`openai` 发送 `session_id`、`x-client-request-id` 与 `x-session-affinity`；`openai-nosession` 发送 `x-client-request-id` 与 `x-session-affinity`；`openrouter` 发送 `x-session-id`。这不会影响请求体中的 `prompt_cache_key`，后者由缓存保留策略控制。默认值：自动检测。 */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** 提供商是否支持长时 prompt 缓存保留（如 `prompt_cache_retention: "24h"`，或按格式决定的 Anthropic 风格 `cache_control.ttl: "1h"`）。默认值：`true`。 */
	supportsLongCacheRetention?: boolean;
}

/** OpenAI Responses API 的兼容性设置。 */
export interface OpenAIResponsesCompat {
	/** 提供商是否支持 `developer` 角色（而非 `system`）。默认值：`true`。 */
	supportsDeveloperRole?: boolean;
	/** 会话亲和性请求头格式：`openai` 发送 `session_id` 与 `x-client-request-id`；`openai-nosession` 只发送 `x-client-request-id`；`openrouter` 发送 `x-session-id`。这不会影响请求体中的 `prompt_cache_key`，后者由缓存保留策略控制。默认值：自动检测。 */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** 提供商是否支持 `prompt_cache_retention: "24h"`。默认值：`true`。 */
	supportsLongCacheRetention?: boolean;
	/** 模型是否支持由客户端执行的延迟工具搜索。默认值：`false`。 */
	supportsToolSearch?: boolean;
}

/** Anthropic Messages 兼容 API 的兼容性设置。 */
export interface AnthropicMessagesCompat {
	/**
	 * 提供商是否接受按工具设置的 `eager_input_streaming`。
	 * 若为 `false`，Anthropic 提供商会省略 `tools[].eager_input_streaming`，
	 * 并在启用工具的请求中发送旧版 beta 头
	 * `fine-grained-tool-streaming-2025-05-14`。
	 * 默认值：`true`。
	 */
	supportsEagerToolInputStreaming?: boolean;
	/** 提供商是否支持 Anthropic 风格的长时缓存保留（`cache_control.ttl: "1h"`）。默认值：`true`。 */
	supportsLongCacheRetention?: boolean;
	/**
	 * 开启缓存时，是否根据 `options.sessionId` 发送 `x-session-affinity` 请求头。
	 * 这对 Fireworks 之类依赖会话亲和性做 prompt 缓存路由的提供商是必需的
	 * （把请求打到同一副本可最大化缓存命中）。
	 * 默认值：`false`。
	 */
	sendSessionAffinityHeaders?: boolean;
	/**
	 * 提供商是否支持在工具定义上使用 Anthropic 风格的 `cache_control` 标记。
	 * 若为 `false`，会从工具参数中省略 `cache_control`。
	 * 某些 Anthropic 兼容提供商（如 Fireworks）并不支持该字段，
	 * 可能会拒绝或忽略它。
	 * 默认值：`true`。
	 */
	supportsCacheControlOnTools?: boolean;
	/**
	 * 模型是否接受 Anthropic 的 `temperature` 请求字段。
	 * Claude Opus 4.7+ 会拒绝非默认温度值。
	 * 默认值：`true`。
	 */
	supportsTemperature?: boolean;
	/**
	 * 是否无视模型 id，强制使用自适应思考格式
	 * （`thinking.type: "adaptive"` 加 `output_config.effort`）。
	 * 需要该格式的内置模型会在生成元数据里打开此项。
	 * 自定义 Anthropic 兼容提供商也可为任何上游要求此格式的模型设为 `true`；
	 * 若想在覆盖内置模型时退出该行为，可显式设为 `false`。
	 * 默认值：`false`。
	 */
	forceAdaptiveThinking?: boolean;
	/** 是否在重放空 thinking 签名时保留为 `signature: ""`，而不是把 thinking 转成文本。默认值：`false`。 */
	allowEmptySignature?: boolean;
	/**
	 * 提供商是否支持通过工具结果中的 `tool_reference` 块加载延迟工具。
	 * 对 Anthropic 官方模型，除 Haiku 和早于 Claude 4.5 的模型外默认值为 `true`；
	 * 对其他提供商默认值为 `false`。
	 */
	supportsToolReferences?: boolean;
}

/**
 * OpenRouter 提供商的路由偏好。
 * 用于控制 OpenRouter 将请求路由到哪些上游提供商。
 * 这些值会作为 OpenRouter API 请求体中的 `provider` 字段发送。
 * @see https://openrouter.ai/docs/guides/routing/provider-selection
 */
export interface OpenRouterRouting {
	/** 是否允许后备提供商接管请求。默认值：`true`。 */
	allow_fallbacks?: boolean;
	/** 是否只保留那些支持请求中全部参数的提供商。默认值：`false`。 */
	require_parameters?: boolean;
	/** 数据收集策略。`"allow"`（默认）表示允许使用可能存储或训练用户数据的提供商；`"deny"` 表示只使用不收集用户数据的提供商。 */
	data_collection?: "deny" | "allow";
	/** 是否将路由限制到仅使用 ZDR（Zero Data Retention）端点。 */
	zdr?: boolean;
	/** 是否将路由限制到仅允许文本蒸馏的模型。 */
	enforce_distillable_text?: boolean;
	/** 按顺序尝试的提供商名称/slug 列表；当前不可用时会回退到下一个。 */
	order?: string[];
	/** 仅允许本次请求使用的提供商名称/slug 列表。 */
	only?: string[];
	/** 本次请求要跳过的提供商名称/slug 列表。 */
	ignore?: string[];
	/** 用于筛选提供商的量化等级列表（例如 `["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"]`）。 */
	quantizations?: string[];
	/** 排序策略。可传字符串（如 `"price"`、`"throughput"`、`"latency"`），也可传带 `by` 和 `partition` 的对象。 */
	sort?:
		| string
		| {
				/** 排序指标：`"price"`、`"throughput"`、`"latency"`。 */
				by?: string;
				/** 分区策略：`"model"`（默认）或 `"none"`。 */
				partition?: string | null;
		  };
	/** 每百万 token 的最高价格（美元）。 */
	max_price?: {
		/** 每百万 prompt token 的价格。 */
		prompt?: number | string;
		/** 每百万 completion token 的价格。 */
		completion?: number | string;
		/** 每张图片的价格。 */
		image?: number | string;
		/** 每个音频计费单位的价格。 */
		audio?: number | string;
		/** 每次请求的价格。 */
		request?: number | string;
	};
	/** 偏好的最小吞吐量（token/秒）。可传单个数字（作用于 p50），也可传一个按分位数设置阈值的对象。 */
	preferred_min_throughput?:
		| number
		| {
				/** 第 50 百分位的最小 token/秒。 */
				p50?: number;
				/** 第 75 百分位的最小 token/秒。 */
				p75?: number;
				/** 第 90 百分位的最小 token/秒。 */
				p90?: number;
				/** 第 99 百分位的最小 token/秒。 */
				p99?: number;
		  };
	/** 偏好的最大延迟（秒）。可传单个数字（作用于 p50），也可传一个按分位数设置阈值的对象。 */
	preferred_max_latency?:
		| number
		| {
				/** 第 50 百分位的最大延迟（秒）。 */
				p50?: number;
				/** 第 75 百分位的最大延迟（秒）。 */
				p75?: number;
				/** 第 90 百分位的最大延迟（秒）。 */
				p90?: number;
				/** 第 99 百分位的最大延迟（秒）。 */
				p99?: number;
		  };
}

/**
 * Vercel AI Gateway 的路由偏好。
 * 用于控制网关把请求路由到哪些上游提供商。
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** 仅允许本次请求使用的提供商 slug 列表（例如 `["bedrock", "anthropic"]`）。 */
	only?: string[];
	/** 按顺序尝试的提供商 slug 列表（例如 `["anthropic", "openai"]`）。 */
	order?: string[];
}

export interface ModelCostRates {
	input: number; // $/million tokens
	output: number; // 美元/百万 token
	cacheRead: number; // 美元/百万 token
	cacheWrite: number; // 美元/百万 token
}

export interface ModelCostTier extends ModelCostRates {
	/** 当请求总输入量超过该 token 数时，使用这一价格档。 */
	inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
	/** 请求级价格档。命中的最高输入阈值会应用到整次请求。 */
	tiers?: ModelCostTier[];
}

// 统一模型系统中的模型接口。
export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	reasoning: boolean;
	/**
	 * 将 pi 的 thinking 等级映射到提供商/模型专属取值。
	 * 缺失的键会回退到提供商默认值；`null` 表示该等级不受支持。
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	/** OpenAI 兼容 API 的兼容性覆盖项。未设置时会根据 `baseUrl` 自动检测。 */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: never;
}

export interface ImagesModel<TApi extends ImagesApi>
	extends Omit<Model<Api>, "api" | "provider" | "reasoning" | "contextWindow" | "maxTokens" | "compat"> {
	api: TApi;
	provider: ImagesProviderId;
	output: ("text" | "image")[];
}
/** 模块职责：实现 packages/ai/src\types.ts 相关的模型、协议或工具逻辑。 */
