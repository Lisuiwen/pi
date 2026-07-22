/** 模块职责：实现 packages/ai/src\api\bedrock-converse-stream.lazy.ts 相关的模型、协议或工具逻辑。 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * 通过变量形式的 specifier 加载 bedrock 实现，这样打包器
 * （浏览器 smoke、Bun compile）就无法沿着导入追踪到仅限 Node 的
 * AWS SDK。对 `.ts`/`.js` 的改写可让这一技巧同时在源码和
 * 构建产物中继续生效。
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let bedrockModuleOverride: ProviderStreams | undefined;

/**
 * 覆盖动态导入的 bedrock 实现。用于 Bun 二进制构建场景，
 * 因为变量 specifier 导入无法被打包；构建过程会改为注册
 * 一个静态导入的模块。
 */
export function setBedrockProviderModule(module: ProviderStreams): void {
	bedrockModuleOverride = module;
}

export const bedrockConverseStreamApi = (): ProviderStreams =>
	lazyApi(
		async () =>
			bedrockModuleOverride ?? ((await importNodeOnlyApi("./bedrock-converse-stream.ts")) as ProviderStreams),
	);
/** 模块职责：实现 packages/ai/src\api\bedrock-converse-stream.lazy.ts 相关的模型、协议或工具逻辑。 */
