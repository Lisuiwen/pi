/** 模块职责：实现 packages/ai/src\utils\sanitize-unicode.ts 相关的模型、协议或工具逻辑。 */
/**
 * 移除字符串中未成对出现的 Unicode 代理项字符。
 *
 * 未成对代理项（例如没有对应低位代理项 `0xDC00-0xDFFF` 的高位代理项
 * `0xD800-0xDBFF`，或反过来）会导致许多 API 提供商在 JSON 序列化时出错。
 *
 * 合法的 emoji 和其他基本多文种平面之外的字符都会使用正确配对的代理项，
 * 因此不会受此函数影响。
 *
 * @param text - 要清洗的文本
 * @returns 移除未成对代理项后的文本
 *
 * @example
 * // 会保留合法的 emoji（即已正确配对的代理项）
 * sanitizeSurrogates("Hello 🙈 World") // => "Hello 🙈 World"
 *
 * // 会移除未成对的高位代理项
 * const unpaired = String.fromCharCode(0xD83D); // 没有对应低位代理项的高位代理项
 * sanitizeSurrogates(`Text ${unpaired} here`) // => "Text  here"
 */
export function sanitizeSurrogates(text: string): string {
	// 替换未成对的高位代理项（后面没有低位代理项的 0xD800-0xDBFF）。
	// 替换未成对的低位代理项（前面没有高位代理项的 0xDC00-0xDFFF）。
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
/** 模块职责：实现 packages/ai/src\utils\sanitize-unicode.ts 相关的模型、协议或工具逻辑。 */
