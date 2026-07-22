/**
 * 模块职责：实现会话树导航所需的分支摘要逻辑。
 */
/**
 * 为会话树导航生成分支摘要。
 *
 * 导航到会话树中的其他位置时，为即将离开的分支生成摘要，
 * 以免丢失上下文。
 */

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type { Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { completeSummarization, estimateTokens } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// 类型定义
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	usage?: Usage;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** 存储在 BranchSummaryEntry.details 中、用于跟踪文件的详细信息 */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

export interface BranchPreparation {
	/** 从条目中提取出的待摘要消息，按时间顺序排列 */
	messages: AgentMessage[];
	/** 从工具调用中提取出的文件操作 */
	fileOps: FileOperations;
	/** 消息的预估 token 总数 */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** 待摘要的条目，按时间顺序排列 */
	entries: SessionEntry[];
	/** 旧位置与新位置之间的共同祖先（如果存在） */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** 用于生成摘要的模型 */
	model: Model<any>;
	/** 模型的 API 密钥 */
	apiKey?: string;
	/** 向模型发送的请求标头 */
	headers?: Record<string, string>;
	/** 模型提供商作用域内的环境变量值 */
	env?: Record<string, string>;
	/** 用于取消操作的中止信号 */
	signal: AbortSignal;
	/** 可选的自定义摘要指令 */
	customInstructions?: string;
	/** 若为 true，customInstructions 将替换默认提示词，而不是追加到默认提示词之后 */
	replaceInstructions?: boolean;
	/** 为提示词和 LLM 响应预留的 token 数（默认 16384） */
	reserveTokens?: number;
	/** 可选的会话流函数，用于保留 SDK 的请求行为，同时不修改 Agent 状态。 */
	streamFn?: StreamFn;
	/** 针对暂时性摘要错误的重试策略。复用 coding-agent 的 `settings.retry`。 */
	retry?: RetryPolicy;
	/** 用于报告重试状态的可选回调（例如 TUI 重试指示器）。 */
	callbacks?: RetryCallbacks;
}

// ============================================================================
// 条目收集
// ============================================================================

/**
 * 收集从一个位置导航到另一个位置时应纳入摘要的条目。
 *
 * 从 oldLeafId 向上遍历至其与 targetId 的共同祖先，并沿途收集条目。
 * 遍历不会在压缩边界处停止——这些压缩条目也会被纳入，
 * 其中的摘要将成为上下文。
 *
 * @param session - 会话管理器（只读访问）
 * @param oldLeafId - 当前位置（导航的起点）
 * @param targetId - 目标位置（导航的终点）
 * @returns 待摘要的条目及共同祖先
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// 若不存在原位置，则没有需要摘要的内容
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// 查找共同祖先（两条路径中共有的最深节点）
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath 从根节点开始排列，因此反向迭代以查找最深的共同祖先
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// 从原叶节点向上收集条目，直至共同祖先
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// 反转数组，使条目按时间顺序排列
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// 条目到消息的转换
// ============================================================================

/**
 * 从会话条目中提取 AgentMessage。
 * 与 compaction.ts 中的 getMessageFromEntry 类似，但还会处理压缩条目。
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// 跳过工具结果——所需上下文已包含在助手消息的工具调用中
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// 这些条目不会为对话内容提供信息
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			return undefined;
	}
}

/**
 * 按 token 预算准备待摘要条目。
 *
 * 按从新到旧的顺序遍历条目并添加消息，直至达到 token 预算。
 * 这样可以确保分支过长时仍保留最新的上下文。
 *
 * 同时从以下位置收集文件操作：
 * - 助手消息中的工具调用
 * - 现有 branch_summary 条目的 details（用于累计跟踪）
 *
 * @param entries - 按时间顺序排列的条目
 * @param tokenBudget - 最多可纳入的 token 数（0 表示不限制）
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// 第一遍：从所有条目中收集文件操作（即使条目超出 token 预算）
	// 这样可以从嵌套的分支摘要中取得累计的文件跟踪信息
	// 仅从 pi 生成的摘要中提取（fromHook !== true），不处理扩展生成的摘要
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// 修改过的文件会同时计入编辑和写入操作，以便正确去重
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// 第二遍：从新到旧遍历条目并添加消息，直至达到 token 预算
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// 从助手消息的工具调用中提取文件操作
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);

		// 添加消息前检查预算
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// 若当前条目是摘要，则尽量纳入，因为它包含重要上下文
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// 已达到预算，停止继续添加
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// ============================================================================
// 生成摘要
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * 为已离开的分支条目生成摘要。
 *
 * @param entries - 待摘要的会话条目（按时间顺序排列）
 * @param options - 生成选项
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const {
		model,
		apiKey,
		headers,
		env,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = 16384,
		streamFn,
		retry,
		callbacks,
	} = options;

	// token 预算 = 上下文窗口大小 - 为提示词和响应预留的空间
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// 转换为 LLM 兼容消息，再序列化为文本
	// 序列化可防止模型将其视为需要继续的对话
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// 构建提示词
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// 调用 LLM 生成摘要。优先使用会话流函数，使 SDK 的
	// 请求行为（超时、重试、归因标头）保持一致，
	// 且无需经过 Agent 状态/事件。重试由 completeSummarization 执行，
	// 因而暂时性的流中断会复用已配置的重试策略。
	const context = { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages };
	const requestOptions: SimpleStreamOptions = { apiKey, headers, env, signal, maxTokens: 2048 };
	const response = await completeSummarization(model, context, requestOptions, streamFn, retry, callbacks);

	// 检查请求是否已中止或发生错误
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Summarization failed" };
	}

	let summary = contentText(response.content);

	// 在摘要前添加序言，以说明分支摘要的上下文
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// 计算文件列表并追加到摘要中
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		usage: response.usage,
		readFiles,
		modifiedFiles,
	};
}
