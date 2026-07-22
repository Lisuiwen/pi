/** 模块职责：实现 packages/ai/src\auth\oauth\github-copilot.ts 相关的模型、协议或工具逻辑。 */
/**
 * GitHub Copilot 的 OAuth 流程。
 */

import { GITHUB_COPILOT_MODELS } from "../../providers/github-copilot.models.ts";
import type { AuthInteraction, OAuthAuth, OAuthCredential } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");

const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;
const COPILOT_API_VERSION = "2026-06-01";

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval?: number;
	expires_in: number;
};

type DeviceTokenSuccessResponse = {
	access_token: string;
	token_type?: string;
	scope?: string;
};

type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

function getUrls(domain: string): {
	deviceCodeUrl: string;
	accessTokenUrl: string;
	copilotTokenUrl: string;
} {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
		copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
	};
}

/**
 * 从 Copilot 令牌中解析 `proxy-ep`，并换算成 API 基础 URL。
 * 令牌格式示例：`tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...`
 * 返回值形如 `https://api.individual.githubcopilot.com`。
 */
function getBaseUrlFromToken(token: string): string | null {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	const proxyHost = match[1];
	// 将 `proxy.xxx` 转成 `api.xxx`。
	const apiHost = proxyHost.replace(/^proxy\./, "api.");
	return `https://${apiHost}`;
}

function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
	// 若已有令牌，则优先从 `proxy-ep` 中提取基础 URL。
	if (token) {
		const urlFromToken = getBaseUrlFromToken(token);
		if (urlFromToken) return urlFromToken;
	}
	// 企业实例或令牌解析失败时使用回退地址。
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function isSelectableCopilotModel(item: Record<string, unknown>): boolean {
	const policy = asRecord(item.policy);
	const capabilities = asRecord(item.capabilities);
	const supports = asRecord(capabilities?.supports);
	return item.model_picker_enabled === true && policy?.state !== "disabled" && supports?.tool_calls !== false;
}

function parseAvailableCopilotModelIds(raw: unknown): string[] {
	const data = asRecord(raw)?.data;
	if (!Array.isArray(data)) {
		throw new Error("Invalid Copilot models response");
	}

	const ids: string[] = [];
	for (const rawItem of data) {
		const item = asRecord(rawItem);
		const id = item?.id;
		if (typeof id === "string" && item && isSelectableCopilotModel(item)) {
			ids.push(id);
		}
	}
	return ids;
}

async function fetchAvailableGitHubCopilotModelIds(copilotToken: string, enterpriseDomain?: string): Promise<string[]> {
	const baseUrl = getGitHubCopilotBaseUrl(copilotToken, enterpriseDomain);
	const raw = await fetchJson(`${baseUrl}/models`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${copilotToken}`,
			...COPILOT_HEADERS,
			"X-GitHub-Api-Version": COPILOT_API_VERSION,
		},
		signal: AbortSignal.timeout(5000),
	});
	return parseAvailableCopilotModelIds(raw);
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

async function startDeviceFlow(domain: string): Promise<DeviceCodeResponse> {
	const urls = getUrls(domain);
	const data = await fetchJson(urls.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "GitHubCopilotChat/0.35.0",
		},
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			scope: "read:user",
		}),
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}

	const deviceCode = (data as Record<string, unknown>).device_code;
	const userCode = (data as Record<string, unknown>).user_code;
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	const interval = (data as Record<string, unknown>).interval;
	const expiresIn = (data as Record<string, unknown>).expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		(interval !== undefined && typeof interval !== "number") ||
		typeof expiresIn !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}

	// 该验证地址会在用户浏览器中打开；为避免 `open` 打开可执行文件等非 URL 内容，
	// 这里强制要求它必须是一个 URL。
	let parsedUri: URL;
	try {
		parsedUri = new URL(verificationUri);
	} catch {
		throw new Error("Untrusted verification_uri in device code response");
	}
	if (parsedUri.protocol !== "https:" && parsedUri.protocol !== "http:") {
		throw new Error("Untrusted verification_uri in device code response");
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: parsedUri.href,
		interval,
		expires_in: expiresIn,
	};
}

async function pollForGitHubAccessToken(
	domain: string,
	device: DeviceCodeResponse,
	signal?: AbortSignal,
): Promise<string> {
	const urls = getUrls(domain);
	return pollOAuthDeviceCodeFlow<string>({
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const raw = await fetchJson(urls.accessTokenUrl, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": "GitHubCopilotChat/0.35.0",
				},
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					device_code: device.device_code,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
			});

			if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
				return { status: "complete", value: (raw as DeviceTokenSuccessResponse).access_token };
			}

			if (raw && typeof raw === "object" && typeof (raw as DeviceTokenErrorResponse).error === "string") {
				const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
				if (error === "authorization_pending") {
					return { status: "pending" };
				}

				if (error === "slow_down") {
					return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
				}

				const descriptionSuffix = description ? `: ${description}` : "";
				return { status: "failed", message: `Device flow failed: ${error}${descriptionSuffix}` };
			}

			return { status: "failed", message: "Invalid device token response" };
		},
	});
}

async function refreshGitHubCopilotAccessToken(
	refreshToken: string,
	enterpriseDomain?: string,
): Promise<OAuthCredential> {
	const domain = enterpriseDomain || "github.com";
	const urls = getUrls(domain);

	const raw = await fetchJson(urls.copilotTokenUrl, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${refreshToken}`,
			...COPILOT_HEADERS,
		},
	});

	if (!raw || typeof raw !== "object") {
		throw new Error("Invalid Copilot token response");
	}

	const token = (raw as Record<string, unknown>).token;
	const expiresAt = (raw as Record<string, unknown>).expires_at;

	if (typeof token !== "string" || typeof expiresAt !== "number") {
		throw new Error("Invalid Copilot token response fields");
	}

	return {
		type: "oauth",
		refresh: refreshToken,
		access: token,
		expires: expiresAt * 1000 - 5 * 60 * 1000,
		enterpriseUrl: enterpriseDomain,
	};
}

/**
 * 刷新 GitHub Copilot 令牌。
 */
async function refreshGitHubCopilotToken(refreshToken: string, enterpriseDomain?: string): Promise<OAuthCredential> {
	const credentials = await refreshGitHubCopilotAccessToken(refreshToken, enterpriseDomain);
	return {
		...credentials,
		availableModelIds: await fetchAvailableGitHubCopilotModelIds(credentials.access, enterpriseDomain),
	};
}

/**
 * 为用户的 GitHub Copilot 账号启用某个模型。
 * 某些模型（如 Claude、Grok）必须先完成这一步才能使用。
 */
async function enableGitHubCopilotModel(token: string, modelId: string, enterpriseDomain?: string): Promise<boolean> {
	const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
	const url = `${baseUrl}/models/${modelId}/policy`;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				...COPILOT_HEADERS,
				"openai-intent": "chat-policy",
				"x-interaction-type": "chat-policy",
			},
			body: JSON.stringify({ state: "enabled" }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * 启用所有已知且可能需要策略确认的 GitHub Copilot 模型。
 * 在登录成功后调用，以尽量保证模型都可用。
 */
async function enableAllGitHubCopilotModels(token: string, enterpriseDomain?: string): Promise<void> {
	const models = Object.values(GITHUB_COPILOT_MODELS);
	await Promise.all(
		models.map(async (model) => {
			await enableGitHubCopilotModel(token, model.id, enterpriseDomain);
		}),
	);
}

async function loginGitHubCopilot(interaction: AuthInteraction): Promise<OAuthCredential> {
	const input = await interaction.prompt({
		type: "text",
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
	});
	if (interaction.signal?.aborted) throw new Error("Login cancelled");

	const trimmed = input.trim();
	const enterpriseDomain = normalizeDomain(input);
	if (trimmed && !enterpriseDomain) throw new Error("Invalid GitHub Enterprise URL/domain");
	const domain = enterpriseDomain || "github.com";

	const device = await startDeviceFlow(domain);
	interaction.notify({
		type: "device_code",
		userCode: device.user_code,
		verificationUri: device.verification_uri,
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
	});

	const githubAccessToken = await pollForGitHubAccessToken(domain, device, interaction.signal);
	const credentials = await refreshGitHubCopilotAccessToken(githubAccessToken, enterpriseDomain ?? undefined);
	interaction.notify({ type: "progress", message: "Enabling models..." });
	await enableAllGitHubCopilotModels(credentials.access, enterpriseDomain ?? undefined);
	return {
		...credentials,
		availableModelIds: await fetchAvailableGitHubCopilotModelIds(credentials.access, enterpriseDomain ?? undefined),
	};
}

function copilotEnterpriseDomain(credential: OAuthCredential): string | undefined {
	const enterpriseUrl = credential.enterpriseUrl;
	if (typeof enterpriseUrl !== "string" || !enterpriseUrl) return undefined;
	return normalizeDomain(enterpriseUrl) ?? undefined;
}

export const githubCopilotOAuth: OAuthAuth = {
	name: "GitHub Copilot",
	login: loginGitHubCopilot,
	refresh: (credential) => refreshGitHubCopilotToken(credential.refresh, copilotEnterpriseDomain(credential)),

	/** 为每次请求推导该凭据专属的代理端点。 */
	async toAuth(credential) {
		return {
			apiKey: credential.access,
			baseUrl: getGitHubCopilotBaseUrl(credential.access, copilotEnterpriseDomain(credential)),
		};
	},
};
/** 模块职责：实现 packages/ai/src\auth\oauth\github-copilot.ts 相关的模型、协议或工具逻辑。 */
