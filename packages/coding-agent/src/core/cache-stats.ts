/**
 * 模块职责：实现 coding-agent 源码模块「core\cache-stats.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

/**
 * 提示缓存 TTL：空闲时间超过此值时，值得将其提示为缓存未命中的可能原因。
 * Anthropic 的默认缓存 TTL 为 5 分钟。
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** 每轮未命中量不超过此值时，视为缓存断点粒度带来的噪声。 */
const NOISE_FLOOR_TOKENS = 1024;

/** 单条助手消息中计入统计的缓存未命中。 */
export interface CacheMiss {
	/** 上一轮提示中存在、但本轮未从缓存读取的提示 token 数。 */
	missedTokens: number;
	/** 相比完全命中缓存而额外支付的美元金额；定价未知时为 0。 */
	missedCost: number;
	/** 距离上次请求（即最后一次刷新缓存）的毫秒数。 */
	idleMs: number;
	/** 相比上次请求更换了模型时为 true。 */
	modelChanged: boolean;
}

export interface CacheWasteTotals {
	missedTokens: number;
	missedCost: number;
	/** 计入统计的未命中次数（超过噪声下限的轮次）。 */
	missCount: number;
}

/** 由 ModelRuntime 实现的最小定价查询接口。费用单位为美元/百万 token。 */
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

/** 扫描过程中遇到的最后一个请求；其提示中的所有内容都应已缓存。 */
interface PreviousRequest {
	promptTokens: number;
	modelKey: string;
	timestamp: number;
	/**
	 * 粘性标记：本次扫描片段中的某个较早请求报告过缓存活动。
	 * 用于区分仅报告缓存读取的提供商（OpenAI 风格，不报告写入）发生完全未命中，
	 * 与提供商从不报告缓存的情况。
	 */
	reportedCache: boolean;
}

/**
 * 计算单条助手消息相对上一个请求的缓存未命中情况。
 * 以下情况不计入统计并返回 undefined：第一轮、重置之后、从未报告缓存活动
 * （提供商不支持缓存），或未命中量低于噪声下限。
 */
function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// 仅当此前报告过缓存活动时，缓存量为零的轮次才计入统计：
	// 对仅报告缓存读取的提供商而言，这是完全未命中；对从不报告缓存的提供商而言，
	// 该值没有意义。
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		return undefined;
	}

	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

	// 额外费用 = 未命中 token 按实际付费费率（input/cacheWrite，含写入溢价）计费，
	// 而不是按缓存读取费率计费。未命中 token 只会落入 input 或 cacheWrite 分组，
	// 因此可直接从本消息的费用明细中获得实际费率。
	const paidTokens = usage.input + usage.cacheWrite;
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	const readPerToken =
		usage.cacheRead > 0
			? usage.cost.cacheRead / usage.cacheRead
			: (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;

	return {
		missedTokens,
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		idleMs: Math.max(0, message.timestamp - prev.timestamp),
		modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
	};
}

function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return {
		promptTokens,
		modelKey: `${message.provider}/${message.model}`,
		timestamp: message.timestamp,
		reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
	};
}

function scan(
	entries: SessionEntry[],
	models: ModelPriceSource,
): { prev: PreviousRequest | undefined; totals: CacheWasteTotals; misses: Map<AssistantMessage, CacheMiss> } {
	let prev: PreviousRequest | undefined;
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
	const misses = new Map<AssistantMessage, CacheMiss>();

	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// 上下文确实发生了变化；下一轮提示是新内容，而非重复计费的内容。
			// 切换模型不在豁免范围内：它会对完整提示重新计费，应计入统计。
			prev = undefined;
			continue;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			const miss = detectMiss(prev, entry.message, models);
			if (miss) {
				totals.missedTokens += miss.missedTokens;
				totals.missedCost += miss.missedCost;
				totals.missCount += 1;
				misses.set(entry.message, miss);
			}
			prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
		}
	}
	return { prev, totals, misses };
}

/**
 * 整个会话的累计缓存浪费：本应作为缓存读取（已存在于上一轮提示中），
 * 却被重新计费的提示 token。
 */
export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}

/**
 * 会话中所有计入统计的缓存未命中，以产生相应费用的助手消息（按引用）为键。
 * 从条目重建聊天（恢复会话、压缩后重建）时，用于重新推导转录提示。
 */
export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}

/**
 * 检测刚完成的助手消息是否发生缓存未命中。
 * `entries` 此时不得包含 `message`（message_end 在持久化之前触发）。
 */
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	return detectMiss(scan(entries, models).prev, message, models);
}
