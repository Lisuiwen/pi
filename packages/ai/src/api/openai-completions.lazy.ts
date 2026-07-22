/** 模块职责：实现 packages/ai/src\api\openai-completions.lazy.ts 相关的模型、协议或工具逻辑。 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAICompletionsApi = (): ProviderStreams => lazyApi(() => import("./openai-completions.ts"));
/** 模块职责：实现 packages/ai/src\api\openai-completions.lazy.ts 相关的模型、协议或工具逻辑。 */
