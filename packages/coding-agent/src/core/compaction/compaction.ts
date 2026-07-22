/**
 * 模块职责：实现 coding-agent 源码模块「core\compaction\compaction.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
/**
 * 长会话的上下文压缩。
 *
 * 上下文压缩逻辑的纯函数。会话管理器负责 I/O，压缩后重新加载会话。
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText, type RetryCallbacks, type RetryPolicy, retryAssistantCall } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
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
// 文件操作跟踪
// ============================================================================

/** 存储在 CompactionEntry.details 中、用于文件跟踪的详细信息。 */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * 从消息和此前的压缩条目中提取文件操作。
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// 从上一次压缩的 details 中收集（如果由 pi 生成）
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// 保留 fromHook 字段以兼容会话文件
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// 从消息中的工具调用提取
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// 消息提取
// ============================================================================

/**
 * 如果条目会产生 AgentMessage，则提取该消息。
 * 对不参与 LLM 上下文的条目返回 undefined。
 */
function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return sessionEntryToContextMessages(entry)[0];
}

/** compact() 的结果——SessionManager 保存时添加 uuid/parentUuid。 */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	/** 生成此摘要的 LLM 调用用量（如果有）。 */
	usage?: Usage;
	/** 扩展专用数据（例如 ArtifactIndex、结构化压缩的版本标记）。 */
	details?: T;
}

function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

// ============================================================================
// 类型
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// token 计算
// ============================================================================

/**
 * 根据用量计算上下文 token 总数。
 * 优先使用原生 totalTokens 字段，否则根据各组成部分计算。
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * 获取助手消息中的用量（如果有）。
 * 跳过已中止、错误和用量全为零的消息，因为它们没有有效用量数据。
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * 从会话条目中查找最后一个有效的助手消息用量。
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * 根据消息估算上下文 token；如果存在最后一个助手用量，则使用它。
 * 如果最后一个用量后还有消息，则使用 estimateTokens 估算其 token。
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * 根据上下文用量检查是否应触发压缩。
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// 切分点检测
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * 使用“字符数/4”的启发式方法估算消息 token 数。
 * 这是保守估算（会高估 token）。
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

function isCutPointMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant":
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") {
		return false;
	}
	return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}

/**
 * 查找有效切分点：上下文可见的类用户消息或助手消息的索引。
 * 绝不在工具结果处切分（工具结果必须紧随对应工具调用）。
 * 在包含工具调用的助手消息处切分时，其工具结果位于后方并会被保留。
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type === "compaction") {
			continue;
		}
		if (sessionEntryToContextMessages(entry).some(isCutPointMessage)) {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * 查找包含给定条目索引的轮次中，作为轮次起点且在上下文可见的用户角色消息。
 * 如果该索引之前找不到轮次起点，则返回 -1。
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) {
			return i;
		}
	}
	return -1;
}

export interface CutPointResult {
	/** 要保留的第一个条目索引。 */
	firstKeptEntryIndex: number;
	/** 被切分轮次的起始用户消息索引；未切分时为 -1。 */
	turnStartIndex: number;
	/** 此切分是否拆开一个轮次（切分点不是用户消息）。 */
	isSplitTurn: boolean;
}

/**
 * 在会话条目中查找可保留约 `keepRecentTokens` 的切分点。
 *
 * 算法：从最新消息开始反向遍历，累加估算的消息大小。
 * 累加值达到 keepRecentTokens 时停止，并在该处切分。
 *
 * 可以在用户消息或助手消息处切分（绝不在工具结果处切分）。在包含工具调用的
 * 助手消息处切分时，其工具结果位于后方并会被保留。
 *
 * 返回包含以下字段的 CutPointResult：
 * - firstKeptEntryIndex：开始保留的条目索引
 * - turnStartIndex：在轮次中间切分时，该轮次的起始用户消息索引
 * - isSplitTurn：是否在轮次中间切分
 *
 * 仅考虑 `startIndex` 与 `endIndex` 之间的条目（不含 endIndex）。
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// 从最新消息开始反向遍历，累加估算的消息大小
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // 默认从第一条消息（非文件头）开始保留

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const messageTokens = sessionEntryToContextMessages(entry).reduce(
			(sum, message) => sum + estimateTokens(message),
			0,
		);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;

		// 检查是否已超过预算
		if (accumulatedTokens >= keepRecentTokens) {
			// 查找此条目处或之后最近的有效切分点
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// 从 cutIndex 向后扫描，纳入不影响上下文的相邻元数据条目。
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// 遇到压缩边界或上下文可见条目时停止。
		if (prevEntry.type === "compaction" || sessionEntryToContextMessages(prevEntry).length > 0) {
			break;
		}
		cutIndex--;
	}

	// 判断是否拆分了轮次
	const cutEntry = entries[cutIndex];
	const startsTurn = isTurnStartEntry(cutEntry);
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

// ============================================================================
// 摘要生成
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers, env };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

/**
 * 所有压缩/分支摘要调用的统一入口。使用 {@link retryAssistantCall} 包装单次 LLM 调用，
 * 使瞬时流中断（例如 `terminated`、socket 关闭）遵循已配置的重试策略，而不会在首次尝试时
 * 使整个压缩失败。确定性错误和中止会立即返回（参阅 {@link retryAssistantCall}）。
 */
export async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const produce = async (): Promise<AssistantMessage> =>
		streamFn ? (await streamFn(model, context, options)).result() : completeSimple(model, context, options);
	return retryAssistantCall(produce, retry, options.signal, callbacks);
}

/**
 * 使用 LLM 生成对话摘要。
 * 如果提供 previousSummary，则使用更新提示词进行合并。
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<string> {
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
		)
	).text;
}

/** 生成或更新对话摘要，并返回提供商返回的用量数据。 */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<{ text: string; usage: Usage }> {
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	// 存在此前摘要时使用更新提示词，否则使用初始提示词
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// 将对话序列化为文本，避免模型尝试继续对话
	// 先转换为 LLM 消息（处理 bashExecution、custom 等自定义类型）
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);

	// 构建提示词，并用标签包裹对话
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions = createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel);

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
		streamFn,
		retry,
		callbacks,
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	const textContent = contentText(response.content);

	return { text: textContent, usage: response.usage };
}

// ============================================================================
// 压缩准备（供扩展使用）
// ============================================================================

export interface CompactionPreparation {
	/** 要保留的第一个条目的 UUID。 */
	firstKeptEntryId: string;
	/** 将被摘要并丢弃的消息。 */
	messagesToSummarize: AgentMessage[];
	/** 将转换为轮次前缀摘要的消息（拆分轮次时）。 */
	turnPrefixMessages: AgentMessage[];
	/** 是否拆分轮次（切分点位于轮次中间）。 */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** 上次压缩的摘要，用于迭代更新。 */
	previousSummary?: string;
	/** 从 messagesToSummarize 提取的文件操作。 */
	fileOps: FileOperations;
	/** 来自 settings.jsonl 的压缩设置。 */
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// 获取第一个保留条目的 UUID
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // 会话需要迁移
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// 要摘要的消息（生成摘要后丢弃）
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// 用于轮次前缀摘要的消息（拆分轮次时）
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	// 从消息和上次压缩中提取文件操作
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// 拆分轮次时，也从轮次前缀提取文件操作
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// 主压缩函数
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * 使用准备好的数据生成压缩摘要。
 * 返回 CompactionResult；SessionManager 保存时添加 uuid/parentUuid。
 *
 * @param preparation - prepareCompaction() 预先计算的准备数据
 * @param customInstructions - 摘要的可选自定义重点
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// 生成摘要并合并为一个摘要
	let summary: string;
	let summaryUsage: Usage;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				streamFn,
				env,
				retry,
				callbacks,
			);
			historyText = historyResult.text;
			historyUsage = historyResult.usage;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			streamFn,
			retry,
			callbacks,
		);
		// 合并为单个摘要
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
		summaryUsage = historyUsage ? combineUsage(historyUsage, turnPrefixResult.usage) : turnPrefixResult.usage;
	} else {
		// 仅生成历史摘要
		const result = await generateSummaryWithUsage(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
		);
		summary = result.text;
		summaryUsage = result.usage;
	}

	// 计算文件列表并追加到摘要
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: summaryUsage,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * 为轮次前缀生成摘要（拆分轮次时）。
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	env?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<{ text: string; usage: Usage }> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	); // 为轮次前缀使用较小预算
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel),
		streamFn,
		retry,
		callbacks,
	);

	if (response.stopReason === "error") {
		throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return {
		text: contentText(response.content),
		usage: response.usage,
	};
}
