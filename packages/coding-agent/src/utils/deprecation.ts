/**
 * 模块职责：实现 coding-agent 源码模块「utils\deprecation.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
import chalk from "chalk";

const emittedDeprecationWarnings = new Set<string>();

export function warnDeprecation(message: string): void {
	if (emittedDeprecationWarnings.has(message)) return;
	emittedDeprecationWarnings.add(message);
	console.warn(chalk.yellow(`Deprecation warning: ${message}`));
}

/** Clear deprecation warning state. Exported for tests. */
export function clearDeprecationWarningsForTests(): void {
	emittedDeprecationWarnings.clear();
}
