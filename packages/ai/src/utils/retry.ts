/** 模块职责：实现 packages/ai/src\utils\retry.ts 相关的模型、协议或工具逻辑。 */
import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode 的 Zen API 会把 OpenCode Go/免费层额度限制表示为 429 JSON 错误类型。
	// 这些属于订阅/账户限制，而不是临时性限流。
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go 的订阅额度提示会要求用户在滚动/每周/每月额度耗尽后启用可用余额。
	"Monthly usage limit reached",
	"available balance",

	// 通用的配额/预算/计费耗尽。`insufficient_quota` 是 OpenAI 的
	// 配额/计费错误码，其余字符串覆盖常见网关措辞。
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// 通用的提供商负载、HTTP 状态码与服务端瞬时失败。
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// 包装层/提供商对上游瞬时失败的描述，包括 OpenRouter 的
	// `"Provider returned error"` 响应（#2264）。
	"provider.?returned.?error",

	// 网络、代理与 fetch 传输层失败。这包括 OpenAI Codex 的 raw-fetch
	// 错误，如 `"upstream connect"`、`"connection refused"`、
	// `"reset before headers"`（#733），以及 OpenRouter 连接中断（#3317）。
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket 传输层可能返回关闭/报错文本，而不是 HTTP/fetch 风格的错误。
	"websocket.?closed",
	"websocket.?error",

	// SDK 或传输层导致的流提前结束。Anthropic 可能抛出
	// `"stream ended without ..."` 和 `"Anthropic stream ended before message_stop"`
	//（#4433）；Bedrock/Smithy 可能抛出 HTTP/2 无响应错误（#3594）。
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// 提供商要求的重试延迟上限失败应交由外层重试策略处理，
	// 以便调用方能展示或中止退避过程（#1123）。
	"retry delay",

	// OpenAI Responses 与 Bedrock 在流式异常中途显式给出的重试提示（#6019）。
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// 基于 gRPC 的提供商（例如 NVIDIA NIM）。
	"ResourceExhausted",
]);

/**
 * 重试策略：在有限次数内按指数退避重试
 * （`baseDelayMs * 2^(attempt-1)`）。
 * 其字段与 coding-agent 中的 `settings.retry`
 * （`enabled`、`maxRetries`、`baseDelayMs`）保持一致；
 * 放在这里是为了让错误分类与基于策略的重试循环共置，并可被 SDK 及其他调用方复用。
 */
export interface RetryPolicy {
	enabled: boolean;
	/** 最大重试次数（0 表示不重试）。首次调用不计入重试次数。 */
	maxRetries: number;
	/** 基础延迟（毫秒）。每次重试的延迟为加抖动前的 `baseDelayMs * 2^(attempt-1)`。 */
	baseDelayMs: number;
}

/** `{@link retryAssistantCall}` 在每次重试前后可选触发的回调。 */
export interface RetryCallbacks {
	/** 每次重试退避休眠前触发（从 1 开始计数）。 */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** 退避休眠结束后、重试调用真正开始前触发。 */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** 循环结束时触发一次；若后续某次调用成功完成，则 `success` 为 `true`。 */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * 对单次产生 assistant 消息的调用，在遇到瞬时错误时执行有限次重试。
 *
 * 行为说明：
 * - 成功响应会立即返回。中止属于终态，永不重试；但如果它发生在某次重试已安排之后，
 *   则会被视为一次未成功的结束。若在退避休眠期间中止，也会被统一规范化为
 *   一个 `AssistantMessage` 的 aborted 结果，调用方无需关心取消发生在哪个阶段。
 * - 不可重试错误（由 {@link isRetryableAssistantError} 判定，包括配额/计费耗尽）
 *   会立即返回，以便确定性错误快速失败。
 * - 其余情况最多重试 `maxRetries` 次，并按指数退避；
 *   每次休眠前触发 `onRetryScheduled`，休眠后、真正发起重试前触发
 *   `onRetryAttemptStart`，循环结束时触发一次 `onRetryFinished`
 *   （无论最终是成功、耗尽重试次数还是在退避中被中止）。
 *
 * 当 `policy` 未定义或被禁用时，首次响应会原样返回，
 * 等价于直接调用 `produce()`。
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// 中止：终态但非成功结果。中止消息永不重试。
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// 成功：非 error、非 aborted 的响应原样返回。
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// 不可重试，或已耗尽重试预算：直接返回最终错误消息。
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = policy!.baseDelayMs * 2 ** (attempt - 1);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// 将重试退避期间的中止统一成与提供商流式中止相同的 AssistantMessage 形状，
		// 这样调用方无需区分取消具体发生在何时。
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				return { ...response, stopReason: "aborted", errorMessage: undefined };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * 判断失败的 assistant 消息是否像是提供商或传输层的瞬时错误，
 * 以便调用方决定是否应重启上一轮 assistant 输出。
 *
 * 这里不负责实现重试策略。调用方应先单独处理上下文溢出，
 * 再自行应用重试预算、退避与上报逻辑，然后决定是否重启该轮输出。
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
/** 模块职责：实现 packages/ai/src\utils\retry.ts 相关的模型、协议或工具逻辑。 */
