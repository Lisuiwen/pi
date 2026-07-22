/** 模块职责：实现 packages/ai/src\api\openai-prompt-cache.ts 相关的模型、协议或工具逻辑。 */
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
/** 模块职责：实现 packages/ai/src\api\openai-prompt-cache.ts 相关的模型、协议或工具逻辑。 */
