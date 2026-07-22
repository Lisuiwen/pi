/**
 * 模块职责：实现 coding-agent 源码模块「utils\pi-user-agent.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
export function getPiUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `pi/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
