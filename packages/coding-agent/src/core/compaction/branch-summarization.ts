/**
 * 模块职责：实现 coding-agent 源码模块「core\compaction\branch-summarization.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
/**
 * 用于树导航的分支摘要。
 *
 * 当导航到会话树中的不同点时，这会生成
 * 留下的分支的摘要，这样上下文就不会丢失。
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
// 类型
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	usage?: Usage;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** 存储在 BranchSummaryEntry.details 中的详细信息用于文件跟踪 */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

export interface BranchPreparation {
	/** 提取用于摘要的消息，按时间顺序*/
	messages: AgentMessage[];
	/** 从工具调用中提取的文件操作*/
	fileOps: FileOperations;
	/** 消息中的估计token总数*/
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** 按时间顺序总结的条目 */
	entries: SessionEntry[];
	/** 新旧位置之间的共同祖先（如果有）*/
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** 用于总结的模型*/
	model: Model<any>;
	/** 模型的 API 密钥 */
	apiKey?: string;
	/** 模型的请求标头*/
	headers?: Record<string, string>;
	/** 模型的提供者范围环境值 */
	env?: Record<string, string>;
	/** 取消的中止信号*/
	signal: AbortSignal;
	/** 可选的自定义摘要说明*/
	customInstructions?: string;
	/** 如果 true，customInstructions 将替换默认提示而不是附加 */
	replaceInstructions?: boolean;
	/** 为提示 + LLM 响应保留的token（默认 16384）*/
	reserveTokens?: number;
	/** 可选的会话流功能。 用于保留 SDK 请求行为而不改变代理状态。 */
	streamFn?: StreamFn;
	/** 针对暂时性汇总错误的重试策略。重用coding-agent的“settings.retry”。 */
	retry?: RetryPolicy;
	/** 用于重试报告的可选回调（例如 TUI 重试指示器）。 */
	callbacks?: RetryCallbacks;
}

// ============================================================================
// 参赛作品集
// ============================================================================

/**
 * 收集从一个位置导航到另一位置时应汇总的条目。
 *
 * 从 oldLeafId 回到具有 targetId 的共同祖先，收集条目
 * 一路上。不会在压实边界处停止 - 这些边界都包括在内并且它们的
 * 摘要成为上下文。
 *
 * @param session - 会话管理器（只读访问）
 * @param oldLeafId - 当前位置（我们从哪里导航）
 * @param targetId - 目标位置（我们导航到的位置）
 * @returns Entries 总结一下和共同的祖先
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// 如果没有旧的立场，没有什么可总结的
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// 找到共同祖先（两条路径上的最深节点）
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath 是根优先，因此向后迭代以找到最深的共同祖先
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// 将旧叶中的条目收集回共同祖先
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// 反转以获取时间顺序
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// 消息转换入口
// ============================================================================

/**
 * 从会话条目中提取 AgentMessage。
 * 与compaction.ts中的getMessageFromEntry类似，但也处理压缩条目。
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// 跳过工具结果 - 上下文位于助手的工具调用中
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// 这些对对话内容没有贡献
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			return undefined;
	}
}

/**
 * 使用token预算准备汇总条目。
 *
 * 将条目从最新到最旧，添加消息，直到达到代币预算。
 * 这确保了当分支太长时我们保留最新的上下文。
 *
 * 还从以下位置收集文件操作：
 * - 助理消息中的工具调用
 * - 现有的branch_summary条目的详细信息（用于累积跟踪）
 *
 * @param entries - 按时间顺序排列的条目
 * @param tokenBudget - 包含的最大token数（0 = 无限制）
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// 第一遍：从所有条目收集文件操作（即使它们不符合代币预算）
	// 这确保我们从嵌套分支摘要中捕获累积文件跟踪
	// 仅从 pi 生成的摘要中提取（fromHook !== true），而不是扩展生成的摘要
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// 修改后的文件将被编辑和写入以进行正确的重复数据删除
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// 第二遍：从最新到最旧，添加消息直到token预算
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// 从助手消息中提取文件操作（工具调用）
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);

		// 添加前检查预算
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// 如果这是一个摘要条目，请尝试将其放入其中，因为它是重要的上下文
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// 停止 - 我们已经达到预算了
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// ============================================================================
// 摘要生成
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
 * 生成废弃分支条目的摘要。
 *
 * @param entries - 总结会议条目（按时间顺序）
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

	// 代币预算 = 上下文窗口减去提示预留空间 + 响应
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// 转换为LLM兼容消息，然后序列化为文本
	// 序列化会阻止模型将其视为继续对话
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// 构建提示
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

	// 致电LLM进行总结。更喜欢会话流功能所以SDK
	// 请求行为（超时、重试、归因标头）保持一致
	// 无需运行代理状态/事件。通过completeSummarization重试
	// 因此瞬态流丢弃会重用配置的重试策略。
	const context = { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages };
	const requestOptions: SimpleStreamOptions = { apiKey, headers, env, signal, maxTokens: 2048 };
	const response = await completeSummarization(model, context, requestOptions, streamFn, retry, callbacks);

	// 检查是否中止或出错
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Summarization failed" };
	}

	let summary = contentText(response.content);

	// 前置序言以提供有关分支摘要的上下文
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// 计算文件列表并附加到摘要中
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		usage: response.usage,
		readFiles,
		modifiedFiles,
	};
}
