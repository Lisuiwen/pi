/**
 * 模块职责：实现 coding-agent 源码模块「core\model-resolver.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
/**
 * 模型解析、范围界定和初始选择
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type KnownProvider, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ModelRuntime } from "./model-runtime.ts";

/** 每个已知提供商的默认模型 ID */
export const defaultModelPerProvider: Record<KnownProvider, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	"ant-ling": "Ring-2.6-1T",
	anthropic: "claude-opus-4-8",
	openai: "gpt-5.5",
	"azure-openai-responses": "gpt-5.4",
	"openai-codex": "gpt-5.5",
	radius: "auto",
	nvidia: "nvidia/nemotron-3-super-120b-a12b",
	deepseek: "deepseek-v4-pro",
	google: "gemini-3.1-pro-preview",
	"google-vertex": "gemini-3.1-pro-preview",
	"github-copilot": "gpt-5.4",
	openrouter: "moonshotai/kimi-k2.6",
	"vercel-ai-gateway": "zai/glm-5.1",
	xai: "grok-4.5",
	groq: "openai/gpt-oss-120b",
	cerebras: "zai-glm-4.7",
	zai: "glm-5.1",
	"zai-coding-cn": "glm-5.1",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.7",
	moonshotai: "kimi-k2.6",
	"moonshotai-cn": "kimi-k2.6",
	huggingface: "moonshotai/Kimi-K2.6",
	fireworks: "accounts/fireworks/models/kimi-k2p6",
	together: "moonshotai/Kimi-K2.6",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k2.6",
	"kimi-coding": "kimi-for-coding",
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
	"qwen-token-plan": "qwen3.7-max",
	"qwen-token-plan-cn": "qwen3.7-max",
	xiaomi: "mimo-v2.5-pro",
	"xiaomi-token-plan-cn": "mimo-v2.5-pro",
	"xiaomi-token-plan-ams": "mimo-v2.5-pro",
	"xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

export interface ScopedModel {
	model: Model<Api>;
	/** 在模式中显式指定的思考级别（例如 `model:high`），否则为 undefined */
	thinkingLevel?: ThinkingLevel;
}

/**
 * 检查模型 ID 是否像别名（即没有日期后缀）的辅助函数
 * 日期后缀通常采用 `-20241022` 或 `-20250929` 格式
 */
function isAlias(id: string): boolean {
	// 检查 ID 是否以 `-latest` 结尾
	if (id.endsWith("-latest")) return true;

	// 检查 ID 是否以日期模式（`-YYYYMMDD`）结尾
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

/**
 * 查找与模型引用精确匹配的模型。
 * 支持裸 model ID，也支持规范的 `provider/modelId` 引用。
 * 使用裸 model ID 匹配时，会拒绝跨提供商的歧义匹配。
 */
export function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return providerMatches[0];
			}
			if (providerMatches.length > 1) {
				return undefined;
			}
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * 尝试从可用模型列表中匹配给定模式。
 * 返回匹配的模型；如果没有匹配项，则返回 undefined。
 */
function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactMatch) {
		return exactMatch;
	}

	// 没有精确匹配项，回退到部分匹配
	const matches = availableModels.filter(
		(m) =>
			m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
	);

	if (matches.length === 0) {
		return undefined;
	}

	// 分为别名和带日期的版本
	const aliases = matches.filter((m) => isAlias(m.id));
	const datedVersions = matches.filter((m) => !isAlias(m.id));

	if (aliases.length > 0) {
		// 优先选择别名；如果有多个别名，则选择排序最靠后的一个
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	} else {
		// 没有别名，选择最新的带日期版本
		datedVersions.sort((a, b) => b.id.localeCompare(a.id));
		return datedVersions[0];
	}
}

export interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** 在模式中显式指定的思考级别，否则为 undefined */
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
}

function buildFallbackModel(provider: string, modelId: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const providerModels = availableModels.filter((m) => m.provider === provider);
	if (providerModels.length === 0) return undefined;

	const defaultId = defaultModelPerProvider[provider as KnownProvider];
	const baseModel = defaultId
		? (providerModels.find((m) => m.id === defaultId) ?? providerModels[0])
		: providerModels[0];

	return {
		...baseModel,
		id: modelId,
		name: modelId,
	};
}

/**
 * 解析模式，从中提取模型和思考级别。
 * 支持 ID 中包含冒号的模型（例如 OpenRouter 的 `:exacto` 后缀）。
 *
 * 算法：
 * 1. 尝试将完整模式作为模型进行匹配
 * 2. 如果找到，则返回该模型并将思考级别设为 `off`
 * 3. 如果未找到且包含冒号，则在最后一个冒号处分割：
 *    - 如果后缀是有效的思考级别，则使用该级别并递归处理前缀
 *    - 如果后缀无效，则发出警告，并以 `off` 级别递归处理前缀
 *
 * @internal 仅为测试而导出
 */
export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
	// 首先尝试精确匹配
	const exactMatch = tryMatchModel(pattern, availableModels);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
	}

	// 没有匹配项；如果存在冒号，则尝试在最后一个冒号处分割
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		// 没有冒号，说明该模式不匹配任何模型
		return { model: undefined, thinkingLevel: undefined, warning: undefined };
	}

	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	if (isValidThinkingLevel(suffix)) {
		// 有效的思考级别：递归处理前缀并使用该级别
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			// 仅当内部递归未发出警告时才使用该思考级别
			return {
				model: result.model,
				thinkingLevel: result.warning ? undefined : suffix,
				warning: result.warning,
			};
		}
		return result;
	} else {
		// 后缀无效
		const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
		if (!allowFallback) {
			// 在严格模式（CLI `--model` 解析）下，将其视为 model ID 的一部分并返回失败。
			// 这样可避免意外解析为其他模型。
			return { model: undefined, thinkingLevel: undefined, warning: undefined };
		}

		// 模型范围模式：递归处理前缀并发出警告
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			return {
				model: result.model,
				thinkingLevel: undefined,
				warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			};
		}
		return result;
	}
}

/**
 * 将模型模式解析为实际的 Model 对象，并可指定思考级别
 * 格式为 `pattern:level`，其中 `:level` 可选
 * 对每个模式查找所有匹配模型，并选择最佳版本：
 * 1. 优先选择别名（例如 `claude-sonnet-4-5`），而非带日期的版本（`claude-sonnet-4-5-20250929`）
 * 2. 如果没有别名，则选择最新的带日期版本
 *
 * 支持 ID 中包含冒号的模型（例如 OpenRouter 的 `model:exacto`）。
 * 算法会先尝试匹配完整模式，再逐步移除冒号后缀以寻找匹配项。
 */
export interface ModelScopeDiagnostic {
	type: "warning";
	message: string;
	pattern: string;
}

export interface ResolveModelScopeResult {
	scopedModels: ScopedModel[];
	diagnostics: ModelScopeDiagnostic[];
}

export async function resolveModelScopeWithDiagnostics(
	patterns: string[],
	modelRuntime: ModelRuntime,
): Promise<ResolveModelScopeResult> {
	const availableModels = [...(await modelRuntime.getAvailable())];
	const scopedModels: ScopedModel[] = [];
	const diagnostics: ModelScopeDiagnostic[] = [];

	for (const pattern of patterns) {
		// 检查模式是否包含 glob 字符
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// 提取可选的思考级别后缀（例如 `provider/*:high`）
			const colonIdx = pattern.lastIndexOf(":");
			let globPattern = pattern;
			let thinkingLevel: ThinkingLevel | undefined;

			if (colonIdx !== -1) {
				const suffix = pattern.substring(colonIdx + 1);
				if (isValidThinkingLevel(suffix)) {
					thinkingLevel = suffix;
					globPattern = pattern.substring(0, colonIdx);
				}
			}

			// 按 `provider/modelId` 格式或仅按 model ID 匹配
			// 因此 `*sonnet*` 无需写成 `anthropic/*sonnet*` 也能匹配
			const matchingModels = availableModels.filter((m) => {
				const fullId = `${m.provider}/${m.id}`;
				return minimatch(fullId, globPattern, { nocase: true }) || minimatch(m.id, globPattern, { nocase: true });
			});

			if (matchingModels.length === 0) {
				diagnostics.push({ type: "warning", message: `No models match pattern "${pattern}"`, pattern });
				continue;
			}

			for (const model of matchingModels) {
				if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
					scopedModels.push({ model, thinkingLevel });
				}
			}
			continue;
		}

		const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);

		if (warning) {
			diagnostics.push({ type: "warning", message: warning, pattern });
		}

		if (!model) {
			diagnostics.push({ type: "warning", message: `No models match pattern "${pattern}"`, pattern });
			continue;
		}

		// 避免重复
		if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
			scopedModels.push({ model, thinkingLevel });
		}
	}

	return { scopedModels, diagnostics };
}

export async function resolveModelScope(patterns: string[], modelRuntime: ModelRuntime): Promise<ScopedModel[]> {
	const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime);
	for (const diagnostic of diagnostics) {
		console.warn(chalk.yellow(`Warning: ${diagnostic.message}`));
	}
	return scopedModels;
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/**
	 * 适合在 CLI 中显示的错误消息。
	 * 设置该字段时，model 为 undefined。
	 */
	error: string | undefined;
}

/**
 * 根据 CLI 标志解析单个模型。
 *
 * 支持：
 * - `--provider <provider> --model <pattern>`
 * - `--model <provider>/<pattern>`
 * - 模糊匹配（规则与模型范围解析相同：先匹配精确 ID，再匹配部分 ID/名称）
 *
 * 注意：此函数本身不会应用思考级别，但可能会从 `<pattern>:<thinking>` 中
 * *解析*并返回思考级别，以便调用方应用。
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	cliThinking?: ThinkingLevel;
	modelRuntime: ModelRuntime;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, cliThinking, modelRuntime } = options;

	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	// 重要：此处使用*所有*模型，而不仅是已预先配置身份验证的模型。
	// 这样首次设置时也可使用 `--api-key`。
	const availableModels = [...modelRuntime.getModels()];
	if (availableModels.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	// 构建规范的提供商查找表（不区分大小写）
	const providerMap = new Map<string, string>();
	for (const m of availableModels) {
		providerMap.set(m.provider.toLowerCase(), m.provider);
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	// 如果未显式指定 `--provider`，先尝试按 `provider/model` 格式解释。
	// 如果第一个斜杠前的前缀与已知提供商匹配，则优先采用这种解释，
	// 而不是匹配 ID 中本身含有斜杠的模型。
	// 例如，`zai/glm-5` 应解析为 provider=zai、model=glm-5，而不是解析为
	// model ID 为 `zai/glm-5` 的 vercel-ai-gateway 模型。
	let pattern = cliModel;
	let inferredProvider = false;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
				inferredProvider = true;
			}
		}
	}

	// 如果未能根据斜杠推断提供商，则不推断提供商，直接尝试精确匹配。
	// 这可处理 ID 本身含有斜杠的模型（例如 OpenRouter 风格的 ID）。
	if (!provider) {
		const lower = cliModel.toLowerCase();
		const exact = availableModels.find(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
	}

	if (cliProvider && provider) {
		// 如果两者均已提供，则移除提供商前缀，以兼容 `--model <provider>/<pattern>`
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	const candidates = provider ? availableModels.filter((m) => m.provider === provider) : availableModels;
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
		allowInvalidThinkingLevelFallback: false,
	});

	if (model) {
		// 如果提供商推断匹配到未经身份验证的 provider/model 组合，则优先选择
		// 一个已通过身份验证且与原始 model ID 精确匹配的模型。这样既能在可用时
		// 优先采用 `provider/model` 语法，也能处理 model ID 本身以已知提供商名称
		// 开头的模型（例如 commandcode 的 model ID `xiaomi/mimo-v2.5-pro`）。
		if (inferredProvider) {
			const rawExactMatches = availableModels.filter(
				(m) => m.id.toLowerCase() === cliModel.toLowerCase() && !modelsAreEqual(m, model),
			);
			if (rawExactMatches.length > 0 && !modelRuntime.hasConfiguredAuth(model.provider)) {
				const authenticatedRawMatches = rawExactMatches.filter((m) => modelRuntime.hasConfiguredAuth(m.provider));
				if (authenticatedRawMatches.length === 1) {
					return {
						model: authenticatedRawMatches[0],
						thinkingLevel: undefined,
						warning: undefined,
						error: undefined,
					};
				}
			}
		}
		return { model, thinkingLevel, warning, error: undefined };
	}

	// 如果根据斜杠推断出提供商，但在该提供商中没有匹配项，
	// 则回退为：将完整输入作为原始 model ID，在所有模型中匹配。
	// 这可处理 `openai/gpt-4o:extended` 一类 OpenRouter 风格的 ID：其中 `openai`
	// 看起来像提供商，但完整字符串实际上是 openrouter 上的 model ID。
	if (inferredProvider) {
		const lower = cliModel.toLowerCase();
		const exact = availableModels.find(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
		// 还要针对所有模型，以完整输入调用 parseModelPattern
		const fallback = parseModelPattern(cliModel, availableModels, {
			allowInvalidThinkingLevelFallback: false,
		});
		if (fallback.model) {
			return {
				model: fallback.model,
				thinkingLevel: fallback.thinkingLevel,
				warning: fallback.warning,
				error: undefined,
			};
		}
	}

	if (provider) {
		// 构建回退模型前，先从模式中解析思考级别后缀，
		// 但仅在未显式提供 `--thinking` 时这样做。
		// 例如 `zai-org/GLM-5.1-FP8:high` → modelId=`zai-org/GLM-5.1-FP8`，fallbackThinking=`high`
		let fallbackPattern = pattern;
		let fallbackThinking: ThinkingLevel | undefined;
		if (!cliThinking) {
			const lastColon = pattern.lastIndexOf(":");
			if (lastColon !== -1) {
				const suffix = pattern.substring(lastColon + 1);
				if (isValidThinkingLevel(suffix)) {
					fallbackPattern = pattern.substring(0, lastColon);
					fallbackThinking = suffix;
				}
			}
		}

		const fallbackModel = buildFallbackModel(provider, fallbackPattern, availableModels);
		if (fallbackModel) {
			const requestedThinking = cliThinking ?? fallbackThinking;
			const model =
				requestedThinking && requestedThinking !== "off" ? { ...fallbackModel, reasoning: true } : fallbackModel;
			const fallbackWarning = warning
				? `${warning} Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`
				: `Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`;
			return { model, thinkingLevel: fallbackThinking, warning: fallbackWarning, error: undefined };
		}
	}

	const display = provider ? `${provider}/${pattern}` : cliModel;
	return {
		model: undefined,
		thinkingLevel: undefined,
		warning,
		error: `Model "${display}" not found. Use --list-models to see available models.`,
	};
}

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
}

/**
 * 根据优先级找到要使用的初始模型：
 * 1. CLI 参数（提供者 + 模型）
 * 2. 模型范围中的第一个模型（如果不是继续/恢复会话）
 * 3. 从会话中恢复（如果继续/恢复）
 * 4. 设置中保存的默认模型
 * 5. 第一个具有有效 API key 的可用模型
 */
export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelRuntime: ModelRuntime;
}): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelRuntime,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	// 1. CLI 参数优先
	if (cliProvider && cliModel) {
		const resolved = resolveCliModel({
			cliProvider,
			cliModel,
			modelRuntime,
		});
		if (resolved.error) {
			console.error(chalk.red(resolved.error));
			process.exit(1);
		}
		if (resolved.model) {
			return { model: resolved.model, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
		}
	}

	// 2. 使用模型范围中的第一个模型（继续/恢复会话时跳过）
	if (scopedModels.length > 0 && !isContinuing) {
		return {
			model: scopedModels[0].model,
			thinkingLevel: scopedModels[0].thinkingLevel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	// 3. 如果已配置身份验证，尝试使用设置中保存的默认模型
	if (defaultProvider && defaultModelId) {
		const found = modelRuntime.getModel(defaultProvider, defaultModelId);
		if (found && modelRuntime.hasConfiguredAuth(found.provider)) {
			model = found;
			if (defaultThinkingLevel) {
				thinkingLevel = defaultThinkingLevel;
			}
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	// 4. 尝试使用第一个具有有效 API key 的可用模型
	const availableModels = [...(await modelRuntime.getAvailable())];

	if (availableModels.length > 0) {
		// 尝试从已知提供商中找到默认模型
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				return { model: match, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
			}
		}

		// 如果没有找到默认模型，则使用第一个可用模型
		return { model: availableModels[0], thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 5. 未找到模型
	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

/**
 * 从会话中恢复模型；无法恢复时回退到可用模型
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRuntime: ModelRuntime,
): Promise<{ model: Model<Api> | undefined; fallbackMessage: string | undefined }> {
	const restoredModel = modelRuntime.getModel(savedProvider, savedModelId);

	// 检查恢复的模型是否存在且仍已配置身份验证
	const hasConfiguredAuth = restoredModel ? modelRuntime.hasConfiguredAuth(restoredModel.provider) : false;

	if (restoredModel && hasConfiguredAuth) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		return { model: restoredModel, fallbackMessage: undefined };
	}

	// 未找到模型或没有 API key，执行回退
	const reason = !restoredModel ? "model no longer exists" : "no auth configured";

	if (shouldPrintMessages) {
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	// 如果已有模型，则将其用作回退模型
	if (currentModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		return {
			model: currentModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	// 尝试查找任意可用模型
	const availableModels = [...(await modelRuntime.getAvailable())];

	if (availableModels.length > 0) {
		// 尝试从已知提供商中找到默认模型
		let fallbackModel: Model<Api> | undefined;
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				fallbackModel = match;
				break;
			}
		}

		// 如果没有找到默认模型，则使用第一个可用模型
		if (!fallbackModel) {
			fallbackModel = availableModels[0];
		}

		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		return {
			model: fallbackModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	// 没有可用模型
	return { model: undefined, fallbackMessage: undefined };
}
