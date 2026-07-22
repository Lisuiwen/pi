/** 模块职责：实现 packages/ai/src\utils\overflow.ts 相关的模型、协议或工具逻辑。 */
import type { AssistantMessage } from "../types.ts";

/**
 * 用于检测不同提供商上下文溢出错误的正则模式。
 *
 * 这些模式匹配的是“输入超出模型上下文窗口”时返回的错误消息。
 *
 * 各提供商模式示例：
 *
 * - Anthropic: `"prompt is too long: 213462 tokens > 200000 maximum"`
 * - Anthropic: `"413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"`
 * - OpenAI: `"Your input exceeds the context window of this model"`
 * - OpenAI/LiteLLM: `"Requested token count exceeds the model's maximum context length of 131072 tokens"`
 * - OpenAI-compatible: `"Input length (265330) exceeds model's maximum context length (262144)."`
 * - Google: `"The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"`
 * - xAI: `"This model's maximum prompt length is 131072 but the request contains 537812 tokens"`
 * - Groq: `"Please reduce the length of the messages or completion"`
 * - OpenRouter: `"This endpoint's maximum context length is X tokens. However, you requested about Y tokens"`
 * - OpenRouter/Poolside: `"Input length X exceeds the maximum allowed input length of Y tokens."`
 * - Together AI: `"The input (X tokens) is longer than the model's context length (Y tokens)."`
 * - llama.cpp: `"the request exceeds the available context size, try increasing it"`
 * - LM Studio: `"tokens to keep from the initial prompt is greater than the context length"`
 * - GitHub Copilot: `"prompt token count of X exceeds the limit of Y"`
 * - MiniMax: `"invalid params, context window exceeds limit"`
 * - Kimi For Coding: `"Your request exceeded model token limit: X (requested: Y)"`
 * - DS4: `"Prompt has X tokens, but the configured context size is Y tokens"`
 * - Cerebras: `"400/413 status code (no body)"`
 * - Mistral: `"Prompt contains X tokens ... too large for model with Y maximum context length"`
 * - z.ai: 不一定报错，可能静默接受超限输入，此时通过 `usage.input > contextWindow` 检测
 * - Xiaomi MiMo: 会把输入截断到恰好填满 `contextWindow`，然后返回 `finish_reason: "length"`
 *   且 `output=0`（没有剩余空间生成输出）；通过 `stopReason === "length"`、输出为零、
 *   以及输入填满上下文窗口来判定
 * - DashScope/Qwen: `"Range of input length should be [1, X]"`（HTTP 400 invalid_parameter_error）
 * - Ollama: 有些部署会静默截断，有些则返回如 `"prompt too long; exceeded max context length by X tokens"` 的错误
 */
const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic token overflow
	/request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (most backends)
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	/prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
	/range of input length should be/i, // DashScope / Qwen Token Plan
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i, // Cerebras: 400/413 with no body
];

/**
 * 表示“并非上下文溢出”的错误模式（如限流、服务端错误）。
 * 只要错误消息命中这些模式，就会被排除在溢出检测之外，
 * 即使它同时也命中了 `OVERFLOW_PATTERNS`。
 *
 * 例如：Bedrock 会把限流错误格式化成
 * `"ThrottlingException: Too many tokens, please wait before trying again."`，
 * 如果没有这里的排除规则，它会误匹配 `/too many tokens/i` 溢出模式。
 */
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
	/rate limit/i, // Generic rate limiting
	/too many requests/i, // Generic HTTP 429 style
];

/**
 * 判断 assistant 消息是否表示一次上下文溢出错误。
 *
 * 这里处理三类情况：
 * 1. 基于错误消息的溢出：大多数提供商会返回 `stopReason === "error"`，
 *    并附带可识别的错误文本模式。
 * 2. 静默溢出：有些提供商会接受超限请求并正常返回；
 *    对这类情况，需要检查 `usage.input` 是否超过上下文窗口。
 * 3. 长度截断型溢出：有些提供商会把输入截到恰好装满上下文，
 *    导致输出空间为零，并以 `stopReason === "length"` 返回。
 *
 * ## 按提供商的可靠性
 *
 * **可靠检测（会返回带可识别消息的错误）：**
 * - Anthropic: `"prompt is too long: X tokens > Y maximum"` 或 `"request_too_large"`
 * - OpenAI（Completions / Responses）: `"exceeds the context window"`、`"exceeds the model's maximum context length of X tokens"` 或 `"exceeds model's maximum context length (X)"`
 * - Google Gemini: `"input token count exceeds the maximum"`
 * - xAI（Grok）: `"maximum prompt length is X but request contains Y"`
 * - Groq: `"reduce the length of the messages"`
 * - Cerebras: `400/413 status code (no body)`
 * - Mistral: `"Prompt contains X tokens ... too large for model with Y maximum context length"`
 * - OpenRouter（大多数后端）: `"maximum context length is X tokens"`
 * - OpenRouter/Poolside: `"Input length X exceeds the maximum allowed input length of Y tokens."`
 * - Together AI: `"The input (X tokens) is longer than the model's context length (Y tokens)."`
 * - llama.cpp: `"exceeds the available context size"`
 * - LM Studio: `"greater than the context length"`
 * - Kimi For Coding: `"exceeded model token limit: X (requested: Y)"`
 * - DS4: `"Prompt has X tokens, but the configured context size is Y tokens"`
 * - DashScope/Qwen: `"Range of input length should be [1, X]"`
 *
 * **不完全可靠的检测：**
 * - z.ai: 有时会静默接受超限输入（可通过 `usage.input > contextWindow` 检出），
 *   有时则返回限流错误。若要检测静默溢出，请传入 `contextWindow`。
 * - Xiaomi MiMo: 会把输入截到 `contextWindow`，再以 `stopReason === "length"` 且
 *   `output=0` 返回。若要检测，请传入 `contextWindow`，并使用“填满上下文且零输出”的信号。
 * - Ollama: 某些部署会静默截断输入，也可能返回匹配上述模式的显式溢出错误。
 *   静默截断目前仍无法在这里检测，因为我们不知道预期的 token 数。
 *
 * ## 自定义提供商
 *
 * 如果你通过 `settings.json` 添加了自定义模型，本函数可能无法识别它们的
 * 溢出错误。要补充支持，可按以下步骤操作：
 *
 * 1. 发送一个超出模型上下文窗口的请求
 * 2. 检查响应中的 `errorMessage`
 * 3. 编写一个能匹配该错误的正则
 * 4. 将该模式加入本文件的 `OVERFLOW_PATTERNS`，或者在调用本函数前自行检查 `errorMessage`
 *
 * @param message - 要检查的 assistant 消息
 * @param contextWindow - 可选的上下文窗口大小，用于检测静默溢出（如 z.ai）
 * @returns 若消息表示上下文溢出则返回 `true`
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// 情况 1：检查错误消息模式。
	if (message.stopReason === "error" && message.errorMessage) {
		// 跳过已知的非溢出错误模式（如节流 / 限流）。
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return true;
		}
	}

	// 情况 2：静默溢出（z.ai 风格）——请求成功，但 token 使用量超出上下文。
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	// 情况 3：`length` 终止型溢出（Xiaomi MiMo 风格）——服务端把超长输入截断到
	// 恰好塞满上下文窗口，导致没有空间生成输出。此时会返回 `stopReason === "length"`，
	// 且 `output=0`，并且 `input + cacheRead` 基本填满整个上下文窗口。
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}

	return false;
}

/**
 * 返回溢出检测模式，供测试使用。
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
/** 模块职责：实现 packages/ai/src\utils\overflow.ts 相关的模型、协议或工具逻辑。 */
