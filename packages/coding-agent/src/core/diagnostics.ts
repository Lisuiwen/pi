/**
 * 模块职责：实现 coding-agent 源码模块「core\diagnostics.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
export interface ResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme";
	name: string; // 技能名称、命令/工具/标志名称、提示名称或主题名称
	winnerPath: string;
	loserPath: string;
	winnerSource?: string; // 例如： "npm:foo", "git:...", "local"
	loserSource?: string;
}

export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: ResourceCollision;
}
