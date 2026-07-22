/** 模块职责：实现 packages/ai/src\api\google-generative-ai.lazy.ts 相关的模型、协议或工具逻辑。 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleGenerativeAIApi = (): ProviderStreams => lazyApi(() => import("./google-generative-ai.ts"));
/** 模块职责：实现 packages/ai/src\api\google-generative-ai.lazy.ts 相关的模型、协议或工具逻辑。 */
