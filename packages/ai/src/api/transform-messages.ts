/** 模块职责：实现 packages/ai/src\api\transform-messages.ts 相关的模型、协议或工具逻辑。 */
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * 为跨 provider 兼容性规范化工具调用 ID。
 * OpenAI Responses API 生成的 ID 可能有 450+ 个字符，并包含 `|` 等特殊字符。
 * Anthropic API 要求 ID 匹配 ^[a-zA-Z0-9_-]+$（最长 64 个字符）。
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// 建立原始工具调用 ID 到规范化 ID 的映射表
	const toolCallIdMap = new Map<string, string>();
	// 规范化无类型调用方（自定义工具、手工构造的历史记录、旧会话文件）
	// 传入的 null/undefined content，让下游代码可以依赖类型契约。
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

	// 第一遍：转换消息（不支持图片时降级、处理 thinking 块、规范化工具调用 ID）
	const transformed = imageAwareMessages.map((msg) => {
		// 用户消息原样透传
		if (msg.role === "user") {
			return msg;
		}

		// 处理 toolResult 消息：若存在映射，则规范化 toolCallId
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// assistant 消息需要检查是否要转换
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Redacted thinking 是不透明的加密内容，只对同一模型有效。
					// 跨模型时丢弃它，以避免 API 报错。
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					// 对于同一模型：保留带 signature 的 thinking 块（重放时需要），
					// 即使 thinking 文本为空也保留（OpenAI 加密 reasoning）
					if (isSameModel && block.thinkingSignature) return block;
					// 跳过空 thinking 块，其余转换为纯文本
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// 第二遍：为孤立的工具调用插入合成的空工具结果
	// 这样既能保留 thinking signature，也满足 API 要求
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// 如果存在上一个 assistant 留下的孤立工具调用，现在插入合成结果
			insertSyntheticToolResults();

			// 完全跳过报错或中止的 assistant 消息。
			// 这些是不应重放的不完整轮次：
			// - 可能只含部分内容（只有 reasoning 没有 message、未完成的工具调用）
			// - 重放它们可能触发 API 错误（例如 OpenAI 的 “reasoning without following item”）
			// - 模型应从最后一个有效状态重新尝试
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// 跟踪这条 assistant 消息中的工具调用
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// 用户消息打断了工具流，需要为孤立调用插入合成结果
			insertSyntheticToolResults();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// 如果会话在仍有未解决工具调用时结束，则此处立即合成结果。
	insertSyntheticToolResults();

	return result;
}
/** 模块职责：实现 packages/ai/src\api\transform-messages.ts 相关的模型、协议或工具逻辑。 */
