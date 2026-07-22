/** 模块职责：实现 packages/agent/src\stream-fn.ts 的 Agent 运行时逻辑。 */
import type { StreamFn } from "./types.ts";

let defaultStreamFn: StreamFn | undefined;

/** 配置调用方省略 streamFn 时，Agent 与底层循环使用的默认流函数。 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
	defaultStreamFn = streamFn;
}

export function getDefaultStreamFn(): StreamFn {
	if (!defaultStreamFn) {
		throw new Error("No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().");
	}
	return defaultStreamFn;
}
