/**
 * 模块职责：实现 coding-agent 源码模块「core\experimental.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.PI_EXPERIMENTAL === "1";
}
