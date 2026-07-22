/** 模块职责：实现 packages/ai/src\auth\helpers.ts 相关的模型、协议或工具逻辑。 */
import type { ApiKeyAuth, OAuthAuth } from "./types.ts";

/**
 * 标准 API key 认证：优先使用已存储凭据中的 key，否则解析第一个已设置的环境变量。
 * 包含一个提示输入 key 的 `login`。采用非标准解析方式（提供商环境变量、环境文件、IAM）
 * 的提供商需自行实现 `ApiKeyAuth`。
 */
export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	return {
		name,
		login: async (interaction) => {
			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}
			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			return undefined;
		},
	};
}

/**
 * 包装动态导入的 `OAuthAuth`，使提供商定义无需导入实现即可声明支持 OAuth。
 * 流程会在首次调用 `login`/`refresh`/`toAuth` 时加载；调用方通过打包器无法静态分析的
 * 动态导入（变量模块说明符，参见 Bedrock 惰性包装器），避免将仅限 Node 的流程代码打入包中。
 */
export function lazyOAuth(input: { name: string; loginLabel?: string; load: () => Promise<OAuthAuth> }): OAuthAuth {
	let promise: Promise<OAuthAuth> | undefined;
	const loaded = () => {
		promise ??= input.load();
		return promise;
	};
	return {
		name: input.name,
		loginLabel: input.loginLabel,
		login: async (interaction) => (await loaded()).login(interaction),
		refresh: async (credential) => (await loaded()).refresh(credential),
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
/** 模块职责：实现 packages/ai/src\auth\helpers.ts 相关的模型、协议或工具逻辑。 */
