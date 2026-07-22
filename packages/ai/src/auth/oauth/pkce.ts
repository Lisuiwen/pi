/** 模块职责：实现 packages/ai/src\auth\oauth\pkce.ts 相关的模型、协议或工具逻辑。 */
/**
 * 基于 Web Crypto API 的 PKCE 工具函数。
 * 同时适用于 Node.js 20+ 与浏览器环境。
 */

/**
 * 将字节序列编码为 base64url 字符串。
 */
function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * 生成 PKCE 的 code verifier 与 challenge。
 * 依赖 Web Crypto API，以保持跨平台兼容性。
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// 生成随机 verifier。
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	// 计算 SHA-256 challenge。
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}
/** 模块职责：实现 packages/ai/src\auth\oauth\pkce.ts 相关的模型、协议或工具逻辑。 */
