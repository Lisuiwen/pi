/** 模块职责：实现 packages/ai/src\providers\radius.ts 相关的模型、协议或工具逻辑。 */
import { piMessagesApi } from "../api/pi-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadRadiusOAuth } from "../auth/oauth/load.ts";
import type { Provider } from "../models.ts";
import {
	DEFAULT_RADIUS_GATEWAY,
	getRadiusModels,
	getRadiusModelsFromConfig,
	loadRadiusGatewayConfig,
	normalizeRadiusGatewayUrl,
} from "./radius-config.ts";

export interface RadiusProviderOptions {
	id?: string;
	name?: string;
	gateway?: string;
}

/** 使用持久化且动态刷新目录的 Radius 网关提供商。 */
export function radiusProvider(options: RadiusProviderOptions = {}): Provider<"pi-messages"> {
	const id = options.id ?? "radius";
	const name = options.name ?? "Radius";
	const gateway = normalizeRadiusGatewayUrl(options.gateway ?? DEFAULT_RADIUS_GATEWAY);
	let models = getRadiusModels(id, undefined);
	let inflightRefresh: Promise<void> | undefined;
	const streams = piMessagesApi();

	return {
		id,
		name,
		auth: {
			apiKey: envApiKeyAuth("Radius API key", ["RADIUS_API_KEY"]),
			oauth: lazyOAuth({ name, load: () => loadRadiusOAuth({ name, gateway }) }),
		},
		getModels: () => models,
		refreshModels: (context) => {
			inflightRefresh ??= (async () => {
				try {
					const stored = await context.store.read();
					if (stored) models = stored.models.filter((model) => model.provider === id) as typeof models;

					// 导入旧版（使用 ModelsStore 之前）Radius 实现缓存的目录。
					if (!stored && context.credential?.type === "oauth") {
						const legacy = getRadiusModels(id, context.credential);
						if (legacy.length > 0) {
							models = legacy;
							await context.store.write({ models: legacy, checkedAt: Date.now() });
						}
					}

					if (!context.allowNetwork || context.signal?.aborted) return;
					const apiKey =
						context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
					const config = await loadRadiusGatewayConfig(gateway, apiKey, context.signal);
					if (context.signal?.aborted) return;
					models = getRadiusModelsFromConfig(id, config);
					await context.store.write({ models, checkedAt: Date.now() });
				} finally {
					inflightRefresh = undefined;
				}
			})();
			return inflightRefresh;
		},
		stream: (model, context, streamOptions) => streams.stream(model, context, streamOptions),
		streamSimple: (model, context, streamOptions) => streams.streamSimple(model, context, streamOptions),
	};
}
/** 模块职责：实现 packages/ai/src\providers\radius.ts 相关的模型、协议或工具逻辑。 */
