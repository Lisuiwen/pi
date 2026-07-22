/** 模块职责：实现 packages/ai/src\providers\cloudflare-stream.ts 相关的模型、协议或工具逻辑。 */
import type { Api, Model, ProviderEnv, ProviderStreams } from "../types.ts";

const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

export function resolveCloudflareModel<TApi extends Api>(
	model: Model<TApi>,
	env: ProviderEnv | undefined,
): Model<TApi> {
	if (!env) return model;
	const baseUrl = model.baseUrl
		.replaceAll(`{${CLOUDFLARE_ACCOUNT_ID}}`, env[CLOUDFLARE_ACCOUNT_ID] ?? `{${CLOUDFLARE_ACCOUNT_ID}}`)
		.replaceAll(`{${CLOUDFLARE_GATEWAY_ID}}`, env[CLOUDFLARE_GATEWAY_ID] ?? `{${CLOUDFLARE_GATEWAY_ID}}`);
	return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}

/**
 * 包装 API 实现，使 Cloudflare account/gateway 端点中的占位符
 * 在派发前根据解析后的 provider 环境变量完成替换。
 */
export function cloudflareStreams(streams: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) =>
			streams.stream(resolveCloudflareModel(model, options?.env), context, options),
		streamSimple: (model, context, options) =>
			streams.streamSimple(resolveCloudflareModel(model, options?.env), context, options),
	};
}
/** 模块职责：实现 packages/ai/src\providers\cloudflare-stream.ts 相关的模型、协议或工具逻辑。 */
