import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type { CreateModelsOptions } from "./models.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ImagesOptions, ProviderImages } from "./types.ts";

/**
 * 图像生成提供商：对应文本侧的 `Provider`。
 * 负责维护 id/name 元数据、认证、模型列表与生成行为。
 */
export interface ImagesProvider {
	readonly id: string;
	readonly name: string;

	/**
	 * 必填：`apiKey` 与 `oauth` 至少提供一个。语义与聊天提供商一致；
	 * 当提供商未配置时，`ImagesModels.getAuth()` 返回 `undefined`。
	 */
	readonly auth: ProviderAuth;

	/**
	 * 同步返回当前已知模型。静态提供商直接返回其目录；
	 * 动态提供商返回最近一次 `refreshModels()` 后的列表
	 * （首次刷新前为空）。不得抛错；若实现抛错，
	 * `ImagesModels` 会将其视为“没有模型”。
	 */
	getModels(): readonly ImagesModel<ImagesApi>[];

	/**
	 * 仅动态提供商使用：拉取并更新模型列表。允许因网络等原因拒绝；
	 * 一旦拒绝，模型列表保持上一次已知状态，后续调用可继续重试。
	 */
	refreshModels?(): Promise<void>;

	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/**
 * 图像生成提供商的运行时集合，并附带认证应用与生成便捷方法：
 * 对应文本侧的 `Models`。
 */
export interface ImagesModels {
	getProviders(): readonly ImagesProvider[];
	getProvider(id: string): ImagesProvider | undefined;

	/**
	 * 同步读取单个提供商或全部提供商的最近已知模型列表。
	 * 尽力而为：某个提供商的 `getModels()` 若抛错，则视为该提供商没有模型。
	 */
	getModels(provider?: string): readonly ImagesModel<ImagesApi>[];

	/** 基于最近已知列表进行同步运行时模型查找。 */
	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined;

	/**
	 * 触发动态提供商重新拉取模型列表。若指定提供商 id，
	 * 该提供商拉取失败时会以 `ModelsError`（`"model_source"`）拒绝；
	 * 未指定时则并发刷新全部提供商，并采用尽力而为策略。
	 * 静态提供商（无 `refreshModels`）会被跳过。
	 */
	refresh(provider?: string): Promise<void>;

	/**
	 * 通过提供商 id 或图像模型解析请求认证。契约与 `Models.getAuth()` 相同：
	 * 未知或未配置时返回 `undefined`，真实失败时以
	 * `ModelsError`（`"oauth"`/`"auth"`）拒绝。
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/**
	 * 通过所属提供商生成图像，并在发送前完成认证解析与合并
	 * （显式传入的选项按字段优先）。该方法永不拒绝；
	 * 失败时会返回 `stopReason: "error"` 的 `AssistantImages`。
	 */
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

export interface MutableImagesModels extends ImagesModels {
	/** 按 `provider.id` 插入或替换。提供商 id 全局唯一。 */
	setProvider(provider: ImagesProvider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

class ImagesModelsImpl implements MutableImagesModels {
	private providers = new Map<string, ImagesProvider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: ImagesProvider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly ImagesProvider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): ImagesProvider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly ImagesModel<ImagesApi>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: ImagesModel<ImagesApi>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// 尽力而为：实现不规范的提供商视为没有模型。
			}
		}
		return models;
	}

	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	async refresh(provider?: string): Promise<void> {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry?.refreshModels) return;
			try {
				await entry.refreshModels();
			} catch (error) {
				if (error instanceof ModelsError) throw error;
				throw new ModelsError("model_source", `Model refresh failed for ${provider}`, { cause: error });
			}
			return;
		}

		// 这里不会向外拒绝：异步映射会把实现不规范提供商的同步抛错转成 rejection，
		// 而 allSettled 会完整吞并这些结果。
		await Promise.allSettled(Array.from(this.providers.values(), async (entry) => entry.refreshModels?.()));
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | ImagesModel<ImagesApi>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		return resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
	}

	async generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages> {
		try {
			const provider = this.providers.get(model.provider);
			if (!provider) {
				throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
			}

			const resolution = await this.getAuth(model, {
				apiKey: options?.apiKey,
				env: options?.env,
			});
			const auth = resolution?.auth;
			if (!auth) {
				return provider.generateImages(model, context, options);
			}

			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

			// 显式请求选项按字段优先；`headers` 与 `env` 则按键合并。
			const apiKey = options?.apiKey ?? auth.apiKey;
			const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
			const env =
				resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;

			return await provider.generateImages(requestModel, context, { ...options, apiKey, headers, env });
		} catch (error) {
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				output: [],
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
		}
	}
}

export function createImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	return new ImagesModelsImpl(options);
}

export interface CreateImagesProviderOptions {
	id: string;
	/** 展示名称。默认值为 `id`。 */
	name?: string;
	/** 必填：每个提供商都必须定义认证语义，包括仅依赖环境或无需密钥的提供商。 */
	auth: ProviderAuth;
	/** 初始模型列表（纯动态提供商可传空数组）。 */
	models: readonly ImagesModel<ImagesApi>[];
	/**
	 * 动态提供商：拉取当前模型列表。成功后会写回缓存；
	 * 并发调用会共享同一个进行中的请求。允许拒绝：
	 * 此时缓存仍保持最近一次已知状态，拒绝会透传给
	 * `refreshModels()` 的调用方（`ImagesModels.refresh(provider)`
	 * 会将其包装为 `ModelsError("model_source")`），后续调用可再次重试。
	 */
	refreshModels?: () => Promise<readonly ImagesModel<ImagesApi>[]>;
	api: ProviderImages;
}

/** 从各组成部分构建一个图像生成提供商。 */
export function createImagesProvider(input: CreateImagesProviderOptions): ImagesProvider {
	let models = input.models;
	let inflightRefresh: Promise<void> | undefined;
	const refreshModels = input.refreshModels;

	return {
		id: input.id,
		name: input.name ?? input.id,
		auth: input.auth,
		getModels: () => models,
		refreshModels: refreshModels
			? () => {
					inflightRefresh ??= (async () => {
						try {
							models = await refreshModels();
						} finally {
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		generateImages: (model, context, options) => input.api.generateImages(model, context, options),
	};
}
