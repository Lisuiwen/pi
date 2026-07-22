/** 模块职责：实现 packages/ai/src\utils\provider-env.ts 相关的模型、协议或工具逻辑。 */
import type { ProviderEnv } from "../types.ts";

let procEnvCache: Map<string, string> | null = null;

/**
 * 针对 https://github.com/oven-sh/bun/issues/27802 的回退逻辑。
 * 某些 Linux 沙箱中的 Bun 编译产物会暴露一个空的 `process.env`，
 * 即使 `/proc/self/environ` 实际上仍包含环境变量。
 *
 * 这里有意复制 `packages/coding-agent/src/bun/restore-sandbox-env.ts`
 * 中的 `restoreSandboxEnv()` 逻辑。`ai` 包可能被直接使用，
 * 不一定经过那个入口，因此提供商环境变量解析不能依赖
 * `process.env` 已被提前修补。
 */
function getBunSandboxEnvValue(name: string): string | undefined {
	if (typeof process === "undefined" || !process.versions?.bun || Object.keys(process.env).length > 0) {
		return undefined;
	}

	if (procEnvCache === null) {
		procEnvCache = new Map();
		try {
			const { readFileSync } = require("node:fs") as {
				readFileSync(path: string, encoding: BufferEncoding): string;
			};
			const data = readFileSync("/proc/self/environ", "utf-8");
			for (const entry of data.split("\0")) {
				const idx = entry.indexOf("=");
				if (idx > 0) {
					procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
				}
			}
		} catch {
			// `/proc/self/environ` 可能不存在，或当前进程无权读取。
		}
	}

	return procEnvCache.get(name);
}

/**
 * 依次从作用域覆盖值、常规 `process.env`，以及为直接 `pi-ai`
 * 使用方准备的 Bun 沙箱回退逻辑中解析提供商环境变量。
 */
export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
	return (
		env?.[name] ||
		(typeof process !== "undefined" ? process.env[name] : undefined) ||
		getBunSandboxEnvValue(name) ||
		undefined
	);
}
/** 模块职责：实现 packages/ai/src\utils\provider-env.ts 相关的模型、协议或工具逻辑。 */
