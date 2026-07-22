/** 模块职责：实现 packages/agent/src\harness\types.ts 的 Agent 运行时逻辑。 */
import type {
	ImageContent,
	Model,
	Models,
	RetryPolicy,
	SimpleStreamOptions,
	TextContent,
	Transport,
	Usage,
} from "@earendil-works/pi-ai";
import type { AgentEvent, AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../index.ts";
import type { Session } from "./session/session.ts";

/** 可能失败的操作结果。预期内的失败以 `ok: false` 返回，而不是抛出。 */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** 创建成功的 {@link Result}。 */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

/** 创建失败的 {@link Result}。 */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

/** 返回成功值，或抛出失败错误。用于测试和明确的适配器边界。 */
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

/** 返回成功值或 `undefined`。仅允许对象值，以避免原始值的真值判断错误。 */
export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}

/** 将未知的抛出值规范化为 Error 实例，再作为带类型错误的 cause 使用。 */
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

/**
 * 从 `SKILL.md` 文件加载或由应用提供的技能。
 *
 * `name`、`description` 和 `filePath` 会按 agentskills.io 的建议，以 XML 格式块插入系统提示。
 * 使用 {@link formatSkillsForSystemPrompt} 生成兼容规范的系统提示块。
 */
export interface Skill {
	/** 用于查找和模型可见列表的稳定技能名称。 */
	name: string;
	/** 模型可见的简短说明，描述何时使用该技能。 */
	description: string;
	/** 完整的技能指令。 */
	content: string;
	/** 技能文件的绝对路径，用于模型可见位置和解析相对引用。 */
	filePath: string;
	/** 从模型可见技能列表中排除该技能，但仍允许应用显式调用。 */
	disableModelInvocation?: boolean;
}

/** 可格式化为提示并显式调用的提示模板。 */
export interface PromptTemplate {
	/** 用于查找或应用命令路由的稳定模板名称。 */
	name: string;
	/** 用于命令列表或自动补全的可选说明。 */
	description?: string;
	/** 模板内容。参数占位符由 `formatPromptTemplateInvocation` 格式化。 */
	content: string;
}

/** 提供给显式调用方法和系统提示回调的资源。 */
export interface AgentHarnessResources<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	/** 可供显式调用的提示模板。 */
	promptTemplates?: TPromptTemplate[];
	/** 可供模型使用和显式调用的技能。 */
	skills?: TSkill[];
}

/** 由应用框架管理、并在每回合创建快照的提供商请求选项。 */
export interface AgentHarnessStreamOptions {
	/** 转发给流函数的首选传输方式。 */
	transport?: Transport;
	/** 提供商请求超时时间，单位为毫秒。 */
	timeoutMs?: number;
	/** 提供商请求的最大重试次数。 */
	maxRetries?: number;
	/** 提供商请求的重试延迟可选上限。 */
	maxRetryDelayMs?: number;
	/** 与认证及生命周期标头合并的附加请求标头。 */
	headers?: Record<string, string>;
	/** 随请求转发的提供商元数据。 */
	metadata?: SimpleStreamOptions["metadata"];
	/** 提供商缓存保留提示。 */
	cacheRetention?: SimpleStreamOptions["cacheRetention"];
}

/** 提供商钩子针对单次请求返回的流选项补丁。 */
export interface AgentHarnessStreamOptionsPatch
	extends Omit<Partial<AgentHarnessStreamOptions>, "headers" | "metadata"> {
	/** 标头补丁。值为 `undefined` 时删除对应键；显式设置 `headers: undefined` 会清空所有标头。 */
	headers?: Record<string, string | undefined>;
	/** 元数据补丁。值为 `undefined` 时删除对应键；显式设置 `metadata: undefined` 会清空所有元数据。 */
	metadata?: Record<string, unknown | undefined>;
}

/** {@link FileSystem} 所寻址的文件系统对象类型。不会自动跟随符号链接。 */
export type FileKind = "file" | "directory" | "symlink";

/** {@link FileSystem} 文件操作返回的稳定、独立于后端的错误代码。 */
export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";

/** {@link FileSystem} 文件操作返回的错误。 */
export class FileError extends Error {
	/** 独立于后端的错误代码。 */
	public code: FileErrorCode;
	/** 与失败关联的绝对寻址路径（如有）。 */
	public path?: string;

	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}

/** {@link ExecutionEnv.exec} 返回的稳定、独立于后端的执行错误代码。 */
export type ExecutionErrorCode =
	| "aborted"
	| "timeout"
	| "shell_unavailable"
	| "spawn_error"
	| "callback_error"
	| "unknown";

/** {@link ExecutionEnv.exec} 返回的错误。 */
export class ExecutionError extends Error {
	/** 独立于后端的错误代码。 */
	public code: ExecutionErrorCode;

	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionError";
		this.code = code;
	}
}

/** 上下文压缩辅助函数返回的稳定错误代码。 */
export type CompactionErrorCode = "aborted" | "summarization_failed" | "invalid_session" | "unknown";

/** 上下文压缩辅助函数返回的错误。 */
export class CompactionError extends Error {
	/** 独立于后端的错误代码。 */
	public code: CompactionErrorCode;

	constructor(code: CompactionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "CompactionError";
		this.code = code;
	}
}

/** 分支摘要辅助函数返回的稳定错误代码。 */
export type BranchSummaryErrorCode = "aborted" | "summarization_failed" | "invalid_session";

/** 分支摘要辅助函数返回的错误。 */
export class BranchSummaryError extends Error {
	/** 独立于后端的错误代码。 */
	public code: BranchSummaryErrorCode;

	constructor(code: BranchSummaryErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "BranchSummaryError";
		this.code = code;
	}
}

export type SessionErrorCode =
	| "not_found"
	| "invalid_session"
	| "invalid_entry"
	| "invalid_fork_target"
	| "storage"
	| "unknown";

/** 会话存储、仓库和会话树操作抛出的错误。 */
export class SessionError extends Error {
	/** 会话子系统错误代码。 */
	public code: SessionErrorCode;

	constructor(code: SessionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionError";
		this.code = code;
	}
}

export type AgentHarnessErrorCode =
	| "busy"
	| "invalid_state"
	| "invalid_argument"
	| "session"
	| "hook"
	| "auth"
	| "compaction"
	| "branch_summary"
	| "unknown";

/** 具有稳定顶层分类的公开 AgentHarness 错误。 */
export class AgentHarnessError extends Error {
	public code: AgentHarnessErrorCode;

	constructor(code: AgentHarnessErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AgentHarnessError";
		this.code = code;
	}
}

/** {@link FileSystem} 中一个文件系统对象的元数据。 */
export interface FileInfo {
	/** {@link path} 的基本名称。 */
	name: string;
	/** 执行环境中经过语法规范化的绝对寻址路径。不跟随符号链接。 */
	path: string;
	/** 对象类型。不跟随符号链接目标；需要时显式使用 {@link FileSystem.canonicalPath}。 */
	kind: FileKind;
	/** 所寻址文件系统对象的大小，单位为字节。 */
	size: number;
	/** 自 Unix 纪元起的修改时间，单位为毫秒。 */
	mtimeMs: number;
}

/**
 * 应用框架使用的文件系统能力。
 *
 * 传给方法的路径可以是绝对路径，也可以相对于 {@link cwd}。文件操作返回的是文件系统命名空间中的寻址路径，
 * 除非由 {@link canonicalPath} 返回，否则不会通过符号链接规范化。
 *
 * 操作方法不得抛出异常或拒绝 Promise。包括意外后端故障在内的所有文件系统失败，都必须编码在返回的
 * {@link Result} 中。实现必须保持此约束。
 */
export interface FileSystem {
	/** 相对路径所基于的当前工作目录。 */
	cwd: string;

	/** 返回绝对寻址路径，不要求路径存在，也不解析符号链接。 */
	absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** 在文件系统命名空间中连接路径片段，不要求结果存在。 */
	joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** 读取 UTF-8 文本文件。 */
	readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** 读取 UTF-8 文本行。读取 `maxLines` 行后实现应停止。 */
	readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>>;
	/** 读取二进制文件。 */
	readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>>;
	/** 创建或覆盖文件；后端支持时同时创建父目录。 */
	writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	/** 创建文件或向文件追加内容；后端支持时同时创建父目录。 */
	appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	/** 返回所寻址路径的元数据，不跟随符号链接。 */
	fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>>;
	/** 列出目录的直属子项，不跟随符号链接。 */
	listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>>;
	/** 返回现有路径的规范路径，并在支持时解析符号链接。 */
	canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** 路径不存在时返回 false；权限失败等其他错误返回 {@link FileError}。 */
	exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>>;
	/** 创建目录。默认值：`recursive: true`，无中止信号。 */
	createDir(
		path: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>>;
	/** 删除文件或目录。默认值：`recursive: false`、`force: false`，无中止信号。 */
	remove(
		path: string,
		options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>>;
	/** 创建临时目录并返回其绝对路径。默认值：`prefix: "tmp-"`，无中止信号。 */
	createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** 创建临时文件并返回其绝对路径。默认值：`prefix: ""`、`suffix: ""`，无中止信号。 */
	createTempFile(options?: {
		prefix?: string;
		suffix?: string;
		abortSignal?: AbortSignal;
	}): Promise<Result<string, FileError>>;

	/** 释放文件系统资源。必须尽力执行，且不得抛出异常或拒绝 Promise。 */
	cleanup(): Promise<void>;
}

/** {@link Shell.exec} 的选项。 */
export interface ShellExecOptions {
	/** 命令工作目录。相对路径基于 {@link ExecutionEnv.cwd} 解析，默认为 {@link ExecutionEnv.cwd}。 */
	cwd?: string;
	/** 命令的附加环境变量。其值会覆盖环境默认值，默认不覆盖。 */
	env?: Record<string, string>;
	/** 超时时间，单位为秒。命令超过该时长时实现应返回超时错误，默认不超时。 */
	timeout?: number;
	/** 用于终止命令的中止信号，默认无中止信号。 */
	abortSignal?: AbortSignal;
	/** 每当产生 stdout 数据块时调用。 */
	onStdout?: (chunk: string) => void;
	/** 每当产生 stderr 数据块时调用。 */
	onStderr?: (chunk: string) => void;
}

/** 应用框架使用的 shell 执行能力。 */
export interface Shell {
	/** 在 {@link FileSystem.cwd} 中执行 shell 命令，除非提供 `options.cwd`。 */
	exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>;
	/** 释放 shell 资源。必须尽力执行，且不得抛出异常或拒绝 Promise。 */
	cleanup(): Promise<void>;
}

/** 应用框架使用的文件系统和进程执行环境。 */
export interface ExecutionEnv extends FileSystem, Shell {}

export interface SessionTreeEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends SessionTreeEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionTreeEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionTreeEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface ActiveToolsChangeEntry extends SessionTreeEntryBase {
	type: "active_tools_change";
	activeToolNames: string[];
}

export interface CompactionEntry<T = unknown> extends SessionTreeEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId?: string;
	tokensBefore: number;
	retainedTail?: AgentMessage[];
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionTreeEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionTreeEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface CustomMessageEntry<T = unknown> extends SessionTreeEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export interface LabelEntry extends SessionTreeEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface SessionInfoEntry extends SessionTreeEntryBase {
	type: "session_info"; // 旧名称，为向后兼容而保留
	name?: string;
}

export interface LeafEntry extends SessionTreeEntryBase {
	type: "leaf";
	targetId: string | null;
}

export type SessionTreeEntry =
	| MessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| ActiveToolsChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| LeafEntry;

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
	activeToolNames: string[] | null;
}

export interface SessionStats {
	messageCount: number;
	cachedTokens: number;
	uncachedTokens: number;
	totalTokens: number;
	costTotal: number;
}

export interface SessionMetadata {
	id: string;
	createdAt: string;
}

export interface JsonlSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	parentSessionPath?: string;
	metadata?: Record<string, unknown>;
}

export interface SessionEntryCursorOptions {
	afterEntrySeq?: number;
	limit?: number;
}

export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
	getMetadata(): Promise<TMetadata>;
	getLeafId(): Promise<string | null>;
	/** 持久化记录当前会话树叶节点的 leaf 条目。 */
	setLeafId(leafId: string | null): Promise<void>;
	createEntryId(): Promise<string>;
	appendEntry(entry: SessionTreeEntry): Promise<void>;
	getEntry(id: string): Promise<SessionTreeEntry | undefined>;
	findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>>;
	getLabel(id: string): Promise<string | undefined>;
	getSessionName(): Promise<string | undefined>;
	getSessionStats(): Promise<SessionStats>;
	getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]>;
	getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]>;
}

export type { Session } from "./session/session.ts";

export interface SessionCreateOptions {
	id?: string;
}

export interface SessionForkOptions {
	entryId?: string;
	position?: "before" | "at";
	id?: string;
}

export interface SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	list(options?: TListOptions): Promise<TMetadata[]>;
	delete(metadata: TMetadata): Promise<void>;
	fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}

export interface JsonlSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
	parentSessionPath?: string;
	metadata?: Record<string, unknown>;
}

export interface JsonlSessionListOptions {
	cwd?: string;
}

export interface JsonlSessionRepoApi
	extends SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions> {}

export type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";

export type PendingSessionWrite = SessionTreeEntry extends infer TEntry
	? TEntry extends SessionTreeEntry
		? Omit<TEntry, "id" | "parentId" | "timestamp">
		: never
	: never;

export interface QueueUpdateEvent {
	type: "queue_update";
	steer: AgentMessage[];
	followUp: AgentMessage[];
	nextTurn: AgentMessage[];
}

export interface SavePointEvent {
	type: "save_point";
	hadPendingMutations: boolean;
}

export interface AbortEvent {
	type: "abort";
	clearedSteer: AgentMessage[];
	clearedFollowUp: AgentMessage[];
}

export interface SettledEvent {
	type: "settled";
	nextTurnCount: number;
}

export interface BeforeAgentStartEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
	systemPrompt: string;
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
}

export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	model: Model<any>;
	sessionId: string;
	streamOptions: AgentHarnessStreamOptions;
}

export interface BeforeProviderPayloadEvent {
	type: "before_provider_payload";
	model: Model<any>;
	payload: unknown;
}

export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface ToolResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: Array<TextContent | ImageContent>;
	details: unknown;
	isError: boolean;
	usage?: Usage;
}

export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionTreeEntry[];
	customInstructions?: string;
	signal: AbortSignal;
}

export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromHook: boolean;
}

export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromHook?: boolean;
}

export interface RetryScheduledEvent {
	type: "retry_scheduled";
	operation: "compaction" | "branch_summary";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

export interface RetryAttemptStartEvent {
	type: "retry_attempt_start";
	operation: "compaction" | "branch_summary";
}

export interface RetryFinishedEvent {
	type: "retry_finished";
	operation: "compaction" | "branch_summary";
}

export interface ModelUpdateEvent {
	type: "model_update";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: "set" | "restore";
}

export interface ThinkingLevelUpdateEvent {
	type: "thinking_level_update";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

export interface ToolsUpdateEvent {
	type: "tools_update";
	toolNames: string[];
	previousToolNames: string[];
	activeToolNames: string[];
	previousActiveToolNames: string[];
	source: "set" | "restore";
}

export interface ResourcesUpdateEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	type: "resources_update";
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	previousResources: AgentHarnessResources<TSkill, TPromptTemplate>;
}

export type AgentHarnessOwnEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> =
	| QueueUpdateEvent
	| SavePointEvent
	| AbortEvent
	| SettledEvent
	| BeforeAgentStartEvent<TSkill, TPromptTemplate>
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderPayloadEvent
	| AfterProviderResponseEvent
	| ToolCallEvent
	| ToolResultEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent
	| RetryScheduledEvent
	| RetryAttemptStartEvent
	| RetryFinishedEvent
	| ModelUpdateEvent
	| ThinkingLevelUpdateEvent
	| ResourcesUpdateEvent<TSkill, TPromptTemplate>
	| ToolsUpdateEvent;

export type AgentHarnessEvent<TSkill extends Skill = Skill, TPromptTemplate extends PromptTemplate = PromptTemplate> =
	| AgentEvent
	| AgentHarnessOwnEvent<TSkill, TPromptTemplate>;

export interface BeforeAgentStartResult {
	messages?: AgentMessage[];
	systemPrompt?: string;
}

export interface ContextResult {
	messages: AgentMessage[];
}

export interface BeforeProviderRequestResult {
	streamOptions?: AgentHarnessStreamOptionsPatch;
}

export interface BeforeProviderPayloadResult {
	payload: unknown;
}

export interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

export interface ToolResultPatch {
	content?: Array<TextContent | ImageContent>;
	details?: unknown;
	isError?: boolean;
	usage?: Usage;
	terminate?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactResult;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
		/** 生成此摘要的 LLM 调用用量（如有）。 */
		usage?: Usage;
	};
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export type AgentHarnessEventResultMap = {
	before_agent_start: BeforeAgentStartResult | undefined;
	context: ContextResult | undefined;
	before_provider_request: BeforeProviderRequestResult | undefined;
	before_provider_payload: BeforeProviderPayloadResult | undefined;
	after_provider_response: undefined;
	tool_call: ToolCallResult | undefined;
	tool_result: ToolResultPatch | undefined;
	session_before_compact: SessionBeforeCompactResult | undefined;
	session_compact: undefined;
	session_before_tree: SessionBeforeTreeResult | undefined;
	session_tree: undefined;
	retry_scheduled: undefined;
	retry_attempt_start: undefined;
	retry_finished: undefined;
	model_update: undefined;
	thinking_level_update: undefined;
	resources_update: undefined;
	tools_update: undefined;
	queue_update: undefined;
	save_point: undefined;
	abort: undefined;
	settled: undefined;
};

export interface AgentHarnessPromptOptions {
	images?: ImageContent[];
}

export interface AbortResult {
	clearedSteer: AgentMessage[];
	clearedFollowUp: AgentMessage[];
}

export interface CompactResult {
	summary: string;
	firstKeptEntryId?: string;
	tokensBefore: number;
	/** 生成此摘要的 LLM 调用用量（如有）。 */
	usage?: Usage;
	retainedTail?: AgentMessage[];
	details?: unknown;
}

export interface NavigateTreeResult {
	cancelled: boolean;
	editorText?: string;
	summaryEntry?: BranchSummaryEntry;
}

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface CompactionPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	retainedTail: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	fileOps: FileOperations;
	settings: CompactionSettings;
}

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionTreeEntry[];
	userWantsSummary: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface GenerateBranchSummaryOptions {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	signal: AbortSignal;
	customInstructions?: string;
	replaceInstructions?: boolean;
	reserveTokens?: number;
}

export interface BranchSummaryResult {
	summary: string;
	usage?: Usage;
	readFiles: string[];
	modifiedFiles: string[];
}

export interface AgentHarnessOptions<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	env: ExecutionEnv;
	session: Session;
	/**
	 * 所有模型请求（回合流式传输、上下文压缩、分支摘要）使用的提供商集合。
	 * 认证通过各提供商自身的 auth 解析。
	 */
	models: Models;
	tools?: TTool[];
	/**
	 * 提供给显式调用方法和系统提示回调的具体资源。
	 * 应用负责加载或重新加载资源，并应使用新值调用 `setResources()`。
	 */
	resources?: AgentHarnessResources<TSkill, TPromptTemplate>;
	systemPrompt?:
		| string
		| ((context: {
				env: ExecutionEnv;
				session: Session;
				model: Model<any>;
				thinkingLevel: ThinkingLevel;
				activeTools: TTool[];
				resources: AgentHarnessResources<TSkill, TPromptTemplate>;
		  }) => string | Promise<string>);
	/** 精选的流/提供商请求选项，在回合开始时创建快照。 */
	streamOptions?: AgentHarnessStreamOptions;
	/** 生成上下文压缩和分支摘要请求时使用的可选重试策略。 */
	retry?: RetryPolicy;
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

export type { AgentHarness } from "./agent-harness.ts";
