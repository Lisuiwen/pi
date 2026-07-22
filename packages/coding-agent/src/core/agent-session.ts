/**
 * 模块职责：实现 coding-agent 源码模块「core\agent-session.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
/**
 * AgentSession——Agent 生命周期和会话管理的核心抽象。
 *
 * 此类由所有运行模式（interactive、print、rpc）共享。
 * 它封装了：
 * - Agent 状态访问
 * - 带自动会话持久化的事件订阅
 * - 模型与思考等级管理
 * - 上下文压缩（手动和自动）
 * - Bash 执行
 * - 会话切换与分支管理
 *
 * 各模式使用此类，并在其上添加各自的 I/O 层。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

// ============================================================================
// 技能块解析
// ============================================================================

/** 从用户消息中解析出的技能块。 */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * 从消息文本中解析技能块。
 * 如果文本不包含技能块，则返回 null。
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** 扩展核心 AgentEvent 的会话专用事件。 */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" };

/** Agent 会话事件的监听函数。 */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// 类型
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** 使用 Ctrl+P 循环切换的模型（来自 --models 参数）。 */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** 扩展、技能、提示词、主题、上下文文件和系统提示词的资源加载器。 */
	resourceLoader: ResourceLoader;
	/** 在扩展系统之外注册的 SDK 自定义工具。 */
	customTools?: ToolDefinition[];
	/** coding-agent 内部使用的规范模型/认证运行时。 */
	modelRuntime: ModelRuntime;
	/** 初始启用的内置工具名称。默认值：[read, bash, edit, write]。 */
	initialActiveToolNames?: string[];
	/** 可选的工具名称允许列表。提供后只暴露这些工具。 */
	allowedToolNames?: string[];
	/** 可选的工具名称拒绝列表。提供后不暴露这些工具。 */
	excludedToolNames?: string[];
	/**
	 * 覆盖基础工具（适用于自定义运行时）。
	 *
	 * 内部会将这些工具合成为最小 ToolDefinition，使 AgentSession 即使在调用方提供普通
	 * AgentTool 实例时，也能维持以定义为先的注册表。
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** 供 Agent 访问当前 ExtensionRunner 的可变引用。 */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** 扩展绑定到此运行时时发出的会话启动事件元数据。 */
	sessionStartEvent?: SessionStartEvent;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** AgentSession.prompt() 的选项。 */
export interface PromptOptions {
	/** 是否展开基于文件的提示词模板（默认：true）。 */
	expandPromptTemplates?: boolean;
	/** 图片附件。 */
	images?: ImageContent[];
	/** 流式处理时消息的排队方式："steer"（打断）或 "followUp"（等待）。流式处理时必填。 */
	streamingBehavior?: "steer" | "followUp";
	/** 扩展输入事件处理器收到的输入来源。默认为 "interactive"。 */
	source?: InputSource;
	/** RPC 模式用于观察提示预检通过或拒绝结果的内部钩子。 */
	preflightResult?: (success: boolean) => void;
}

/** cycleModel() 的结果。 */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** 是在限定模型（--models 参数）中循环，还是在全部可用模型中循环。 */
	isScoped: boolean;
}

/** /session 命令使用的会话统计信息。 */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// 常量
// ============================================================================

/** 标准思考等级。 */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

// ============================================================================
// AgentSession 类
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// 事件订阅状态
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** 跟踪待处理的 steering 消息以供 UI 显示，送达后移除。 */
	private _steeringMessages: string[] = [];
	/** 跟踪待处理的 follow-up 消息以供 UI 显示，送达后移除。 */
	private _followUpMessages: string[] = [];
	/** 已排队、将在下一条用户提示中作为上下文（"asides"）一并包含的消息。 */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// 上下文压缩状态
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;

	// 分支摘要状态
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// 重试状态
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash 执行状态
	private _bashAbortController: AbortController | undefined = undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// 扩展系统
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;

	// 供扩展 getTools/setTools 使用的工具注册表
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// 基础系统提示词（不含扩展追加内容）——用于每轮应用最新的追加内容
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		// 始终订阅 Agent 事件以供内部处理
		// （会话持久化、扩展、自动压缩和重试逻辑）
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result?.auth.apiKey) {
			return {
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const result = await this._modelRuntime.getAuth(model);
			return result
				? { apiKey: result.auth.apiKey, headers: withoutDeletedHeaders(result.auth.headers), env: result.env }
				: {};
		} catch {
			return {};
		}
	}

	/**
	 * 在 Agent 实例上安装一次工具钩子。
	 *
	 * 回调在执行时读取 `this._extensionRunner`，因此重新加载扩展时可替换为新运行器，
	 * 无需重新安装钩子。扩展专用工具包装器仍负责使已注册工具适配扩展上下文；
	 * 工具调用和工具结果的拦截现在在此处完成，而不是在包装器中完成。
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_result")) {
				return undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
				usage: result.usage,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
				usage: hookResult.usage,
			};
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// 事件订阅
	// =========================================================================

	/** 向所有监听器发出事件。 */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	// 跟踪最后一条助手消息，用于自动压缩检查
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Agent 事件的内部处理器——由订阅和重连逻辑共享。 */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// 用户消息开始时，检查它是否来自任一队列，并在发出事件前将其移除
		// 以确保 UI 能看到更新后的队列状态
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// 先检查 steering 队列
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// 再检查 follow-up 队列
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// 先向扩展发出事件
		await this._emitExtensionEvent(event);

		// 通知所有监听器
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// 处理会话持久化
		if (event.type === "message_end") {
			// 检查是否为扩展发出的自定义消息
			if (event.message.role === "custom") {
				// 持久化为 CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// 普通 LLM 消息——持久化为 SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// 其他消息类型（bashExecution、compactionSummary、branchSummary）在别处持久化

			// 跟踪助手消息以进行自动压缩（在 agent_end 时检查）
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecoveryAttempted = false;
				}

				// 助手成功响应后立即重置重试计数器
				// 防止一次轮次中的多个 LLM 调用累积重试次数
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** 查找 Agent 状态中的最后一条助手消息（包括已中止的消息）。 */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// agent-core 在发出 message_end 前，会把最终消息对象存入自身状态。
		// SessionManager 稍后在 _handleAgentEvent() 中使用 event.message 完成持久化。
		// 原地修改此对象可让 Agent 状态、后续 turn/agent 事件、监听器，以及最终的
		// SessionManager.appendMessage(event.message) 持久化保持同步。
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** 根据 Agent 事件发出扩展事件。 */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// 未指定类型的扩展处理器可能返回 content 为 null 或缺失的消息；
				// 在此规范化，避免其进入 Agent 状态或会话历史。
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * 订阅 Agent 事件。
	 * 会话持久化在内部处理（在 message_end 时保存消息）。
	 * 可以添加多个监听器。返回当前监听器的取消订阅函数。
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// 返回当前监听器的取消订阅函数
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * 暂时断开 Agent 事件订阅。
	 * 用户监听器会保留，并在重新订阅后继续接收事件。
	 * 内部用于需要暂停事件处理的操作。
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * 在 _disconnectFromAgent() 后重新连接 Agent 事件。
	 * 保留所有现有监听器。
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // 已连接
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * 移除所有监听器并断开 Agent 连接。
	 * 完全结束会话时调用此方法。
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// 即使中止钩子抛出异常，释放操作也必须成功。
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// 只读状态访问
	// =========================================================================

	/** 完整的 Agent 状态。 */
	get state(): AgentState {
		return this.agent.state;
	}

	/** 当前模型（尚未选择时可能为 undefined）。 */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** 当前思考等级。 */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** 会话当前是否正在处理 Agent 运行或运行后的继续操作。 */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** 会话是否没有活跃的 Agent 运行、重试、自动压缩或排队的继续操作。 */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/** 当前生效的系统提示词（包括扩展对当前轮次所做的修改）。 */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** 当前重试次数（未重试时为 0）。 */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * 获取当前启用的工具名称。
	 * 返回当前在 Agent 上设置的工具名称。
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * 获取所有已配置工具，包括名称、描述、参数 schema、提示词准则和来源元数据。
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * 按名称设置启用的工具。
	 * 只能启用注册表中的工具，未知工具名称将被忽略。
	 * 同时重建系统提示词以反映新工具集。
	 * 更改将在下一个 Agent 轮次生效。
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// 使用新工具集重建基础系统提示词
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** 当前是否正在执行上下文压缩或分支摘要。 */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** 所有消息，包括 BashExecutionMessage 等自定义类型。 */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** 当前 steering 模式。 */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** 当前 follow-up 模式。 */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** 当前会话文件路径；禁用会话时为 undefined。 */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** 当前会话 ID。 */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** 当前会话显示名称（如果已设置）。 */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** 用于循环切换的限定模型（来自 --models 参数）。 */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** 更新用于循环切换的限定模型。 */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** 基于文件的提示词模板。 */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// 提示处理
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
			await this._emitAgentSettled();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// Agent 循环会在发出 agent_end 前清空两个队列。此处存在的消息由
		// agent_end 扩展处理器排入队列，需要继续运行。
		return this.agent.hasQueuedMessages();
	}

	/**
	 * 向 Agent 发送提示。
	 * - 立即处理扩展命令（通过 pi.registerCommand 注册），即使正在流式处理
	 * - 默认展开基于文件的提示词模板
	 * - 流式处理期间，根据 streamingBehavior 选项通过 steer() 或 followUp() 排队
	 * - 发送前验证模型和 API key（非流式处理时）
	 * @throws 流式处理时未指定 streamingBehavior 则抛出 Error
	 * @throws 非流式处理时未选择模型或没有可用 API key 则抛出 Error
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// 优先处理扩展命令（即使正在流式处理也立即执行）
			// 扩展命令通过 pi.sendMessage() 自行管理 LLM 交互
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// 扩展命令已执行，无需发送提示
					preflightResult?.(true);
					return;
				}
			}

			// 发出输入事件供扩展拦截（在技能/模板展开前）
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// 展开技能命令（/skill:name args）和提示词模板（/template args）
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// 流式处理时，根据选项通过 steer() 或 followUp() 排队
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// 在新提示前刷新所有待处理的 Bash 消息
			this._flushPendingBashMessages();

			// 验证模型
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// 发送前检查是否需要压缩（可捕获已中止的响应）。
			// 用户的新提示将在下方发送，因此此处不要调用 agent.continue()。
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			// 构建消息数组（先放自定义消息，如有；再放用户消息）
			messages = [];

			// 添加用户消息
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// 将所有待处理的 "nextTurn" 消息与用户消息一并注入上下文
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// 发出 before_agent_start 扩展事件
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// 添加扩展提供的所有自定义消息
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// 未指定类型的扩展可能传入 null 或缺失的 content；在接收时规范化。
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// 应用扩展修改后的系统提示词，或重置为基础提示词
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// 确保使用基础提示词（避免沿用上一轮的修改）
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		await this._runAgentPrompt(messages);
	}

	/**
	 * 尝试执行扩展命令。找到并执行命令时返回 true。
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// 解析命令名称和参数
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// 从扩展运行器获取命令上下文（包括会话控制方法）
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// 通过扩展运行器发出错误
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * 将技能命令（/skill:name args）展开为完整内容。
	 * 如果不是技能命令或未找到技能，则返回原始文本。
	 * 文件读取失败时通过扩展运行器发出错误。
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // 未知技能，原样传递

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// 像扩展命令一样发出错误
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // 出错时返回原文
		}
	}

	/**
	 * Agent 运行时将 steering 消息排入队列。
	 * 在当前助手轮次执行完工具调用后、下一次 LLM 调用前送达。
	 * 展开技能命令和提示词模板；遇到扩展命令时抛出错误。
	 * @param images 消息中可包含的图片附件
	 * @throws 文本是扩展命令时抛出 Error
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// 检查扩展命令（扩展命令不能排队）
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// 展开技能命令和提示词模板
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * 将 follow-up 消息排队，待 Agent 完成后处理。
	 * 仅当 Agent 不再有工具调用或 steering 消息时送达。
	 * 展开技能命令和提示词模板；遇到扩展命令时抛出错误。
	 * @param images 消息中可包含的图片附件
	 * @throws 文本是扩展命令时抛出 Error
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// 检查扩展命令（扩展命令不能排队）
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// 展开技能命令和提示词模板
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * 内部方法：将 steering 消息排队（已展开，不检查扩展命令）。
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * 内部方法：将 follow-up 消息排队（已展开，不检查扩展命令）。
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * 如果文本是扩展命令，则抛出错误。
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * 向会话发送自定义消息，并创建 CustomMessageEntry。
	 *
	 * 处理三种情况：
	 * - 正在流式处理：消息排队，循环从队列取出时处理
	 * - 非流式处理 + triggerTurn：追加到状态/会话并启动新轮次
	 * - 非流式处理 + 不触发：追加到状态/会话，但不启动轮次
	 *
	 * @param message 包含 customType、content、display、details 的自定义消息
	 * @param options.triggerTurn 为 true 且不在流式处理时，触发新的 LLM 轮次
	 * @param options.deliverAs 送达模式："steer"、"followUp" 或 "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// 未指定类型的扩展可能传入 null 或缺失的 content；在接收时规范化。
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * 向 Agent 发送用户消息。始终触发一个轮次。
	 * Agent 正在流式处理时，使用 deliverAs 指定消息的排队方式。
	 *
	 * @param content 用户消息内容（字符串或内容数组）
	 * @param options.deliverAs 流式处理时的送达模式："steer" 或 "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// 将内容规范化为文本字符串和可选图片
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// 使用 expandPromptTemplates: false 调用 prompt()，跳过命令处理和模板展开
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * 清空并返回所有排队消息。
	 * 用户中止时，可用于将消息恢复到编辑器。
	 * @returns 包含 steering 和 followUp 数组的对象
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** 待处理消息数量（包括 steering 和 follow-up）。 */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** 获取待处理的 steering 消息（只读）。 */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** 获取待处理的 follow-up 消息（只读）。 */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * 中止当前操作，并等待 Agent 进入空闲状态。
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// 模型管理
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * 直接设置模型。
	 * 验证认证已配置，并保存到会话和设置中。
	 * @throws 模型未配置认证时抛出 Error
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// 根据新模型的能力重新限制思考等级
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * 循环切换到下一个/上一个模型。
	 * 如果存在限定模型（来自 --models 参数）则使用限定模型，否则使用所有可用模型。
	 * @param direction - "forward"（默认）或 "backward"
	 * @returns 新模型信息；只有一个可用模型时返回 undefined
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const checks = await Promise.all(
			this._scopedModels.map(async (scoped) => ({
				scoped,
				auth: await this._modelRuntime.checkAuth(scoped.model.provider),
			})),
		);
		const scopedModels = checks.filter(({ auth }) => auth !== undefined).map(({ scoped }) => scoped);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// 应用模型
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// 应用思考等级。
		// - 限定模型显式指定的思考等级覆盖当前会话等级
		// - 限定模型的思考等级为 undefined 时，继承当前会话偏好
		// setThinkingLevel 会根据模型能力限制等级。
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRuntime.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// 根据新模型的能力重新限制思考等级
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// 思考等级管理
	// =========================================================================

	/**
	 * 设置思考等级。
	 * 根据可用思考等级和模型能力限制取值。
	 * 仅当等级确实改变时保存到会话和设置中。
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// 仅在确实改变时持久化
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * 循环切换到下一个思考等级。
	 * @returns 新等级；模型不支持思考时返回 undefined
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * 获取当前模型可用的思考等级。
	 * 提供商会在内部将等级限制为具体模型支持的范围。
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * 检查当前模型是否支持思考/推理。
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// 队列模式管理
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * 设置 steering 消息模式。
	 * 保存到设置中。
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * 设置 follow-up 消息模式。
	 * 保存到设置中。
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// 上下文压缩
	// =========================================================================

	/**
	 * 手动压缩会话上下文。
	 * 首先中止当前 Agent 操作。
	 * @param customInstructions 可选的压缩摘要指令
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		this._disconnectFromAgent();
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// 检查无法压缩的原因
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// 扩展提供的压缩内容
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// 生成压缩结果
				const result = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason: "manual" }),
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// 获取为扩展事件保存的压缩条目
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
		}
	}

	/**
	 * 取消正在进行的压缩（手动或自动）。
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * 取消正在进行的分支摘要。
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * 检查是否需要压缩，并在需要时执行。
	 * 在 agent_end 之后、提交提示之前调用。
	 *
	 * 两种情况：
	 * 1. 溢出：LLM 返回上下文溢出错误，从 Agent 状态移除错误消息、执行压缩并自动重试
	 * 2. 阈值：上下文超过阈值，执行压缩但不自动重试（由用户手动继续）
	 *
	 * @param assistantMessage 要检查的助手消息
	 * @param skipAbortedCheck 为 false 时包含已中止的消息（用于提示前检查）。默认值：true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// 如果消息已中止（用户取消）则跳过，除非 skipAbortedCheck 为 false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// 如果消息来自不同模型，则跳过溢出检查。
		// 这会处理用户从较小上下文模型（例如 opus）切换到较大上下文模型（例如 codex）的情况：
		// 旧模型的溢出错误不应触发新模型的压缩。
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// 如果此助手消息早于最近的压缩边界，则跳过压缩检查。
		// 这样可防止压缩前的陈旧用量/错误在压缩后的第一条提示中再次触发压缩。
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// 情况 1：溢出——LLM 返回上下文溢出错误，或报告的用量超过配置窗口。
		// 超过配置窗口的成功响应应执行压缩，但不能重试：助手回答已经完成，
		// agent.continue() 无法从助手消息继续。
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			const willRetry = assistantMessage.stopReason !== "stop";

			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// 从 Agent 状态移除错误消息（它已保存到会话历史中，
			// 但重试上下文中不应包含它）
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// 情况 2：阈值——上下文正在变大
		// 对错误消息或用量全为零的消息，根据最后一个有效响应估算。
		// 这样，即使会话持续遇到 API 错误（例如 529）或异常的零用量响应，
		// 仍可执行压缩且不会重置上下文计数。
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // 完全没有用量数据
			// 验证用量来源位于压缩之后。保留的压缩前消息包含反映旧（更大）上下文的陈旧用量，
			// 会在一次压缩刚完成后误触发新的压缩。
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * 内部方法：执行自动压缩并发出事件。
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		let started = false;

		try {
			if (!this.model) {
				return false;
			}

			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			let env: Record<string, string> | undefined;
			if (this.agent.streamFunction === streamSimple) {
				const authResult = await this._modelRuntime.getAuth(this.model);
				if (!authResult?.auth.apiKey) return false;
				apiKey = authResult.auth.apiKey;
				headers = withoutDeletedHeaders(authResult.auth.headers);
				env = authResult.env;
			} else {
				({ apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model));
			}

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			this._emit({ type: "compaction_start", reason });
			this._autoCompactionAbortController = new AbortController();
			started = true;

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// 扩展提供的压缩内容
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// 生成压缩结果
				const compactResult = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason }),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// 获取为扩展事件保存的压缩条目
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// 自动压缩可能在 follow-up、steering 或自定义消息等待期间完成。
			// 继续运行一次，以便送达排队消息。
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			if (started) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						reason === "overflow"
							? `Context overflow recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
				});
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * 切换自动压缩设置。
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** 是否启用自动压缩。 */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// 自动重试
	// =========================================================================

	/**
	 * 检查错误是否可重试（过载、速率限制、服务器错误）。
	 * 上下文溢出错误不可重试（改由压缩处理）。
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// 上下文溢出由压缩处理，而不是重试。
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * 压缩和分支摘要调用共享的重试策略与回调。
	 * 使用与 Agent 轮次重试相同的 `settings.retry` 预算/退避策略，避免一次瞬时流中断
	 * 导致整个操作失败。`source` 携带 TUI 渲染重试并重建底层指示器所需的上下文。
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * 为可重试错误准备带指数退避的继续操作。
	 * @returns 调用方应继续运行 Agent 时为 true，否则为 false
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// 保留已完成的尝试次数，以便运行后处理能够发出最终失败事件。
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// 从 Agent 状态移除错误消息（保留在会话历史中）
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// 按指数退避等待（可中止）
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// 等待期间被中止——发出结束事件，让 UI 能够清理
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * 取消正在进行的重试。
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** 当前是否正在自动重试。 */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** 是否启用自动重试。 */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * 切换自动重试设置。
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash 执行
	// =========================================================================

	/**
	 * 执行 Bash 命令。
	 * 将结果添加到 Agent 上下文和会话中。
	 * @param command 要执行的 Bash 命令
	 * @param onChunk 可选的输出流式回调
	 * @param options.excludeFromContext 为 true 时，不向 LLM 发送命令输出（!! 前缀）
	 * @param options.operations 用于远程执行的自定义 BashOperations
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		this._bashAbortController = new AbortController();

		// 应用已配置的命令前缀（例如用于支持别名的 "shopt -s expand_aliases"）
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: this._bashAbortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortController = undefined;
		}
	}

	/**
	 * 在会话历史中记录 Bash 执行结果。
	 * 供 executeBash 和自行处理 Bash 执行的扩展使用。
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// Agent 正在流式处理时延迟添加，避免破坏 tool_use/tool_result 顺序
		if (this.isStreaming) {
			// 排队等待，将在 agent_end 时刷新
			this._pendingBashMessages.push(bashMessage);
		} else {
			// 立即添加到 Agent 状态
			this.agent.state.messages.push(bashMessage);

			// 保存到会话
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * 取消正在运行的 Bash 命令。
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	/** 当前是否有 Bash 命令正在运行。 */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	/** 是否有等待刷新的 Bash 消息。 */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * 将待处理的 Bash 消息刷新到 Agent 状态和会话中。
	 * 在 Agent 轮次完成后调用，以维持正确的消息顺序。
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// 添加到 Agent 状态
			this.agent.state.messages.push(bashMessage);

			// 保存到会话
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// 会话管理
	// =========================================================================

	/**
	 * 设置当前会话的显示名称。
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// 树导航
	// =========================================================================

	/**
	 * 导航到会话树中的另一个节点。
	 * 与创建新会话文件的 fork() 不同，此操作仍使用同一文件。
	 *
	 * @param targetId 要导航到的条目 ID
	 * @param options.summarize 用户是否要为离开的分支生成摘要
	 * @param options.customInstructions 摘要器的自定义指令
	 * @param options.replaceInstructions 为 true 时，customInstructions 替换默认提示词
	 * @param options.label 要附加到分支摘要条目的标签
	 * @returns 包含 editorText（目标为用户消息时）和 cancelled 状态的结果
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// 已在目标节点时不执行操作
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// 生成摘要需要模型
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// 收集要摘要的条目（从旧叶节点到共同祖先）
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// 准备事件数据——保持可变，以便扩展覆盖
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// 为摘要操作设置中止控制器
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// 发出 session_before_tree 事件
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// 允许扩展覆盖指令和标签
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// 必要时运行默认摘要器
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// 根据目标类型确定新的叶节点位置
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// 用户消息：叶节点 = 父节点（根节点时为 null），文本放入编辑器
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// 自定义消息：叶节点 = 父节点（根节点时为 null），文本放入编辑器
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// 非用户消息：叶节点 = 选中节点
				newLeafId = targetId;
			}

			// 切换叶节点（可以带摘要，也可以不带）
			// 摘要附加到导航目标位置（newLeafId），而不是旧分支
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// 在目标位置创建摘要（根节点时可以为 null）
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// 将标签附加到摘要条目
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// 无摘要且导航到根节点——重置叶节点
				this.sessionManager.resetLeaf();
			} else {
				// 无摘要且导航到非根节点
				this.sessionManager.branch(newLeafId);
			}

			// 不生成摘要时将标签附加到目标条目（没有摘要条目可附加）
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// 更新 Agent 状态
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// 发出 session_tree 事件
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// 向自定义工具发出事件

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * 从会话获取所有用户消息，供 fork 选择器使用。
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * 获取会话统计信息。聚合所有会话条目（包括已压缩掉的历史），
	 * 因此 token/费用总计反映整个会话中的实际计费量。
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// 压缩后，最后一条助手用量反映的是压缩前的上下文大小。
		// 只能信任最近一次压缩之后响应的助手消息中的用量。
		// 如果不存在此类消息，则在下一次 LLM 响应前无法确定上下文 token 数。
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// 检查压缩边界后是否存在有效的助手用量
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * 将会话导出为 HTML。
	 * @param outputPath 可选输出路径（默认为会话目录）
	 * @returns 导出文件的路径
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// 如果存在扩展运行器，则创建工具渲染器（用于自定义工具的 HTML 渲染）
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * 将当前会话分支导出为 JSONL 文件。
	 * 先写入会话头，再写入当前分支路径上的所有条目。
	 * @param outputPath 目标文件路径。省略时在 cwd 中生成带时间戳的文件。
	 * @returns 解析后的输出文件路径
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// 重新串联 parentId，形成线性序列
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// 工具方法
	// =========================================================================

	/**
	 * 获取最后一条助手消息的文本内容。
	 * 供 /copy 命令使用。
	 * @returns 文本内容；不存在助手消息时返回 undefined
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// 跳过没有内容的已中止消息
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// 扩展系统
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * 检查扩展是否具有特定事件类型的处理器。
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * 获取扩展运行器（用于设置 UI 上下文和错误处理器）。
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
