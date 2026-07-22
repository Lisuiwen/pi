/** 模块职责：实现 packages/ai/src\utils\text.ts 相关的模型、协议或工具逻辑。 */
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "../types.ts";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** 从消息内容中提取文本块，并按分隔符拼接。 */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}
/** 模块职责：实现 packages/ai/src\utils\text.ts 相关的模型、协议或工具逻辑。 */
