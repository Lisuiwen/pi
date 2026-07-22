/** 模块职责：实现 packages/ai/src\auth\types.ts 相关的模型、协议或工具逻辑。 */
import type { ProviderEnv, ProviderHeaders } from "../types.ts";

/**
 * 单次模型请求的认证信息。无法表示为 `apiKey`、`headers` 或 `baseUrl` 的值属于提供商配置，而非认证。
 */
export interface ModelAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
}

/**
 * 持久化的 API key 凭据。`env` 保存提供商范围的环境/配置值，例如 Cloudflare 账户或网关 ID。
 */
export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: ProviderEnv;
}

/** 扩展兼容流程返回的 OAuth 令牌数据。 */
export interface OAuthCredentials {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

/** 持久化的标准 OAuth 凭据。 */
export interface OAuthCredential extends OAuthCredentials {
	type: "oauth";
}

/** 每个提供商一个带类型标签的凭据，即当前 auth.json 的结构。 */
export type Credential = ApiKeyCredential | OAuthCredential;

/** 用于账户/状态枚举的非敏感凭据元数据。 */
export interface CredentialInfo {
	providerId: string;
	type: Credential["type"];
}

/**
 * 由应用侧管理的凭据存储，以 `Provider.id` 为键，每个提供商一条凭据。
 * `modify` 是唯一写入路径，因此所有变更都必须经过串行化的
 * 读-改-写流程；`Models.getAuth()` 会在 `modify` 内执行 OAuth 刷新，
 * 以避免并发请求重复刷新同一个已轮换令牌。应用在登录后通过
 * `modify(provider.id, async () => credential)` 持久化凭据。
 * 登录/退出流程也由应用侧编排。
 *
 * 错误语义：缺失条目时，`read` 应解析为 `undefined`。各方法仅在
 * 存储失败时拒绝；`Models` 会把这类拒绝包装为代码为 `"auth"` 的
 * `ModelsError`。尽力而为的存储实现同样有效，例如只提供内存视图、
 * 并在内部记录持久化错误的实现（如 coding-agent 的 AuthStorage）。
 */
export interface CredentialStore {
	/**
 * 读取已保存的凭据（可能已过期），用于展示/状态；请求认证由 `Models.getAuth()` 解析。
	 */
	read(providerId: string): Promise<Credential | undefined>;

	/**
 * 列出凭据元数据，不解析或暴露密钥。列出时不得执行配置的 API key 命令。
	 */
	list(): Promise<readonly CredentialInfo[]>;

	/**
 * 序列化写入（唯一写入路径）。`fn` 会看到当前凭据，以支持刷新及刷新期间登录；
 * 返回新凭据，或返回 undefined 保持条目不变。
 * 按提供商 ID 互斥；后端支持时跨进程互斥（例如文件锁）。解析为写入后的凭据，`fn` 的拒绝会向上传递。
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined>;

	/** 删除凭据（退出登录）；实现应与 `modify` 串行化。 */
	delete(providerId: string): Promise<void>;
}

/** 认证解析所需的环境访问接口，可注入测试和浏览器环境。 */
export interface AuthContext {
	env(name: string): Promise<string | undefined>;
	/** 检查文件是否存在，支持前导 `~`；浏览器中始终返回 false。 */
	fileExists(path: string): Promise<boolean>;
}

/** 模型认证解析结果。 */
export interface AuthResult {
	auth: ModelAuth;
	/** 从凭据与环境上下文中解析出的提供商级环境变量/配置值。 */
	env?: ProviderEnv;
	/** 用于状态界面的可读来源标签，例如 `"ANTHROPIC_API_KEY"`、`"OAuth"`、`"~/.aws/credentials"`。 */
	source?: string;
}

export interface AuthCheck {
	source?: string;
	type: "api_key" | "oauth";
}

export type AuthType = "api_key" | "oauth";

/**
 * 登录期间展示给用户的提示。`signal` 允许流程在某个外部事件已完成该步骤时，
 * 取消仍在等待的提示；例如 `manual_code` 提示与回调服务器并行等待时，
 * 一旦回调先返回，就会中止该提示。
 */
export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
);

export interface AuthInfoLink {
	url: string;
	label?: string;
}

export type AuthEvent =
	| { type: "info"; message: string; links?: readonly AuthInfoLink[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

/**
 * 同时服务于 API key 与 OAuth 流程的登录交互回调。
 *
 * `prompt()` 返回用户输入或选择的字符串（`select` 返回选项 id）。
 * 取消或中止时会拒绝。`signal` 用于中止整个登录流程；单次提示的取消则
 * 使用 `AuthPrompt.signal`。
 */
export interface AuthInteraction {
	signal?: AbortSignal;

	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}

/**
 * API key 认证：可同时使用已存储的 key、提供商级环境值以及环境来源
 * （环境变量、AWS profile、ADC 文件等）。仅依赖环境来源的提供商可省略 `login`。
 */
export interface ApiKeyAuth {
	/** 展示名称，例如 `"Anthropic API key"`。 */
	name: string;

	/** 交互式配置入口（提示输入 key 或提供商环境值）。缺失表示仅依赖环境来源。 */
	login?(interaction: AuthInteraction): Promise<ApiKeyCredential>;

	/**
	 * 可选的无副作用可用性检查。当 `resolve()` 可能执行命令或进行其他
	 * 请求时工作时，应提供此方法。缺失时，`Models` 会通过解析认证来检查可用性。
	 */
	check?(input: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthCheck | undefined>;

	/**
	 * 从已存储凭据和/或环境来源解析认证，并按字段合并
	 * （`credential.key ?? env("...")`、`credential.env?.NAME ?? env("...")`）。
	 * 返回 `undefined` 表示未配置。解析范围限定在提供商级；
	 * 模型级端点准备发生在认证解析之后。
	 */
	resolve(input: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthResult | undefined>;
}

/**
 * OAuth 认证。将 `refresh` 与 `toAuth` 分离后，`Models` 可以掌控带锁的
 * 刷新流程：`refresh` 产出新凭据，`toAuth` 则基于最终存储下来的凭据派生请求认证。
 */
export interface OAuthAuth {
	/** 展示名称，例如 `"Anthropic (Claude Pro/Max)"`。 */
	name: string;

	/** 订阅登录选项的选择器标签，例如 `"Sign in with SuperGrok or X Premium"`。 */
	loginLabel?: string;

	login(interaction: AuthInteraction): Promise<OAuthCredential>;

	/**
	 * 用刷新令牌换取新凭据。该调用会访问网络；失败时抛错
	 * （如 `invalid_grant` 等）。`Models` 会在存储锁内执行它。
	 */
	refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;

	/**
	 * 从有效凭据无副作用地派生请求认证。
	 * 这也覆盖按凭据变化的 `baseUrl`（如 GitHub Copilot）。之所以是异步，
	 * 是为了让惰性包装器能在首次使用时再加载实现。
	 */
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

/**
 * 提供商认证配置。`apiKey` 与 `oauth` 至少要有一个：即便是仅依赖环境凭据的
 * 提供商或无密钥的本地服务，也会通过 `apiKey` 认证的 `resolve()` 来报告
 * 该提供商是否已配置。
 */
export interface ProviderAuth {
	apiKey?: ApiKeyAuth;
	oauth?: OAuthAuth;
}
/** 模块职责：实现 packages/ai/src\auth\types.ts 相关的模型、协议或工具逻辑。 */
