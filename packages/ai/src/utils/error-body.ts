/** 模块职责：实现 packages/ai/src\utils\error-body.ts 相关的模型、协议或工具逻辑。 */
// 统一规范化各提供商的 HTTP 错误对象。
//
// 代理或网关后的端点可能返回非 2xx 响应，而提供商 SDK 无法将响应体并入 `error.message`。
// SDK 错误对象仍包含 HTTP 状态和原始/解析后的响应体，但字段名因 SDK 而异。
// 只读取 `error.message` 的 catch 逻辑会丢失响应体，产生“403 status code (no body)”等模糊信息，
// 甚至退化为“Unknown: UnknownError”。
//
// `normalizeProviderError` 探测已知 SDK（Mistral、`openai`、`@google/genai`、AWS Bedrock）的字段形状，
// 返回各提供商可拼接到展示文本中的结构。`messageCarriesBody` 标记 Anthropic / `@google/genai`
// 的正常路径：SDK 已将响应体并入消息，提供商可直接保留而不重复输出。

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError {
	/** 从 SDK 错误对象提取到的 HTTP 状态码（若存在）。 */
	status?: number;
	/** 原始 HTTP 响应体中的原因文本，已裁剪首尾空白并按上限截断。 */
	body?: string;
	/** `error.message`；若抛出的不是 `Error`，则为 `safeJsonStringify(error)`。 */
	message: string;
	/** 若 `message` 已包含响应体内容，则为 `true`（无需再额外拼接 body）。 */
	messageCarriesBody: boolean;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return {
		status,
		body,
		message: error.message,
		messageCarriesBody,
	} satisfies NormalizedProviderError;
}

/**
 * 探测 HTTP 状态码，按 SDK 字段顺序命中第一个数值字段即返回：
 * `statusCode`（Mistral）→ `status`（`openai`、`@google/genai`）→
 * `$metadata.httpStatusCode`（Bedrock）→ `$response.statusCode`（Bedrock）。
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

/**
 * 探测原始响应体原因，按 SDK 字段顺序命中第一个可用值即返回：
 * `body` 字符串（Mistral）→ `error` 解析后的 JSON 响应体对象
 * （`openai` SDK 的 `this.error`）→ `$response.body`（Bedrock）。
 * 空对象会被视为“没有响应体”，避免把空解析结果显示为 `"{}"`。
 * 选中的响应体会按长度上限截断。
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isNonEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

/**
 * 根据规范化错误对象拼接展示字符串。若消息本身已包含响应体
 * （Anthropic / `@google/genai` 的正常路径），或未提取到 body/status，
 * 则原样返回消息；否则会展示状态码与响应体，并可选加上提供商前缀。
 *
 * - 无前缀：`"<status>: <body>"`
 * - 有前缀：`"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		return prefix !== undefined && norm.status !== undefined
			? `${prefix} (${norm.status}): ${norm.message}`
			: norm.message;
	}
	return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
/** 模块职责：实现 packages/ai/src\utils\error-body.ts 相关的模型、协议或工具逻辑。 */
