/** 模块职责：实现 packages/ai/src\api\anthropic-messages.lazy.ts 相关的模型、协议或工具逻辑。 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const anthropicMessagesApi = (): ProviderStreams => lazyApi(() => import("./anthropic-messages.ts"));
/** 模块职责：实现 packages/ai/src\api\anthropic-messages.lazy.ts 相关的模型、协议或工具逻辑。 */
