/** 模块职责：实现 packages/ai/src\env-api-keys.ts 相关的模型、协议或工具逻辑。 */
// 切勿改为顶层导入，否则会破坏浏览器/Vite 构建
let _existsSync: typeof import("node:fs").existsSync | null = null;
let _homedir: typeof import("node:os").homedir | null = null;
let _join: typeof import("node:path").join | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_FS_SPECIFIER = "node:" + "fs";
const NODE_OS_SPECIFIER = "node:" + "os";
const NODE_PATH_SPECIFIER = "node:" + "path";

// 仅在 Node.js/Bun 环境中提前加载。
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	dynamicImport(NODE_FS_SPECIFIER).then((m) => {
		_existsSync = (m as typeof import("node:fs")).existsSync;
	});
	dynamicImport(NODE_OS_SPECIFIER).then((m) => {
		_homedir = (m as typeof import("node:os")).homedir;
	});
	dynamicImport(NODE_PATH_SPECIFIER).then((m) => {
		_join = (m as typeof import("node:path")).join;
	});
}

import type { KnownProvider, ProviderEnv } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

let cachedVertexAdcCredentialsExists: boolean | null = null;

function hasVertexAdcCredentials(env?: ProviderEnv): boolean {
	const explicitCredentialsPath = env?.GOOGLE_APPLICATION_CREDENTIALS;
	if (explicitCredentialsPath) {
		return _existsSync ? _existsSync(explicitCredentialsPath) : false;
	}

	if (cachedVertexAdcCredentialsExists === null) {
		// 如果 Node 模块尚未加载（启动时异步导入发生竞争），则返回 false 但不缓存，
		// 以便模块就绪后下次调用重试。仅在永远无法使用 fs 的浏览器环境中永久缓存 false。
		if (!_existsSync || !_homedir || !_join) {
			const isNode = typeof process !== "undefined" && (process.versions?.node || process.versions?.bun);
			if (!isNode) {
				// 已确定处于浏览器环境，可以安全地永久缓存 false
				cachedVertexAdcCredentialsExists = false;
			}
			return false;
		}

		// 优先检查 `GOOGLE_APPLICATION_CREDENTIALS` 环境变量（标准做法）。
		const gacPath = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
		if (gacPath) {
			cachedVertexAdcCredentialsExists = _existsSync(gacPath);
		} else {
			// 否则回退到默认 ADC 路径（按需求值）。
			cachedVertexAdcCredentialsExists = _existsSync(
				_join(_homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
	if (provider === "github-copilot") {
		return ["COPILOT_GITHUB_TOKEN"];
	}

	// `ANTHROPIC_OAUTH_TOKEN` 的优先级高于 `ANTHROPIC_API_KEY`。
	if (provider === "anthropic") {
		return ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
	}

	const envMap: Record<string, string> = {
		"ant-ling": "ANT_LING_API_KEY",
		"qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
		"qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
		openai: "OPENAI_API_KEY",
		"azure-openai-responses": "AZURE_OPENAI_API_KEY",
		nvidia: "NVIDIA_API_KEY",
		deepseek: "DEEPSEEK_API_KEY",
		google: "GEMINI_API_KEY",
		"google-vertex": "GOOGLE_CLOUD_API_KEY",
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		xai: "XAI_API_KEY",
		radius: "RADIUS_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
		zai: "ZAI_API_KEY",
		"zai-coding-cn": "ZAI_CODING_CN_API_KEY",
		mistral: "MISTRAL_API_KEY",
		minimax: "MINIMAX_API_KEY",
		"minimax-cn": "MINIMAX_CN_API_KEY",
		moonshotai: "MOONSHOT_API_KEY",
		"moonshotai-cn": "MOONSHOT_API_KEY",
		huggingface: "HF_TOKEN",
		fireworks: "FIREWORKS_API_KEY",
		together: "TOGETHER_API_KEY",
		opencode: "OPENCODE_API_KEY",
		"opencode-go": "OPENCODE_API_KEY",
		"kimi-coding": "KIMI_API_KEY",
		"cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
		"cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
		xiaomi: "XIAOMI_API_KEY",
		"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
		"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
		"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	};

	const envVar = envMap[provider];
	return envVar ? [envVar] : undefined;
}

/**
 * 查找当前已配置、可为提供商提供 API key 的环境变量。
 *
 * 此函数只返回真正的 API key 变量，特意排除 AWS 配置文件、AWS IAM 凭据
 * 以及 Google Application Default Credentials 这类环境凭据来源。
 */
export function findEnvKeys(provider: KnownProvider, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined {
	const envVars = getApiKeyEnvVars(provider);
	if (!envVars) return undefined;

	const found = envVars.filter((envVar) => !!getProviderEnvValue(envVar, env));
	return found.length > 0 ? found : undefined;
}

/**
 * 从已知环境变量（例如 `OPENAI_API_KEY`）中读取提供商的 API key。
 *
 * 对需要 OAuth 令牌的提供商不会返回 API key。
 */
export function getEnvApiKey(provider: KnownProvider, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
	const envKeys = findEnvKeys(provider, env);
	if (envKeys?.[0]) {
		return getProviderEnvValue(envKeys[0], env);
	}

	// Vertex AI 同时支持显式 API key 与 Application Default Credentials。
	// 通过 `gcloud auth application-default login` 配置认证。
	if (provider === "google-vertex") {
		const hasCredentials = hasVertexAdcCredentials(env);
		const hasProject = !!(
			getProviderEnvValue("GOOGLE_CLOUD_PROJECT", env) || getProviderEnvValue("GCLOUD_PROJECT", env)
		);
		const hasLocation = !!getProviderEnvValue("GOOGLE_CLOUD_LOCATION", env);

		if (hasCredentials && hasProject && hasLocation) {
			return "<authenticated>";
		}
	}

	if (provider === "amazon-bedrock") {
		// Amazon Bedrock 支持多种凭据来源：
		// 1. `AWS_PROFILE`：`~/.aws/credentials` 中的具名配置
		// 2. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`：标准 IAM 密钥
		// 3. `AWS_BEARER_TOKEN_BEDROCK`：Bedrock bearer 令牌
		// 4. `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`：ECS 任务角色
		// 5. `AWS_CONTAINER_CREDENTIALS_FULL_URI`：ECS 任务角色（完整 URI）
		// 6. `AWS_WEB_IDENTITY_TOKEN_FILE`：IRSA（Kubernetes 服务账户的 IAM 角色）
		if (
			getProviderEnvValue("AWS_PROFILE", env) ||
			(getProviderEnvValue("AWS_ACCESS_KEY_ID", env) && getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env)) ||
			getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", env) ||
			getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", env) ||
			getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_FULL_URI", env) ||
			getProviderEnvValue("AWS_WEB_IDENTITY_TOKEN_FILE", env)
		) {
			return "<authenticated>";
		}
	}

	return undefined;
}
/** 模块职责：实现 packages/ai/src\env-api-keys.ts 相关的模型、协议或工具逻辑。 */
