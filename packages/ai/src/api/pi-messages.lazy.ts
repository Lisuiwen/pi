/** 模块职责：实现 packages/ai/src\api\pi-messages.lazy.ts 相关的模型、协议或工具逻辑。 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const piMessagesApi = (): ProviderStreams => lazyApi(() => import("./pi-messages.ts"));
/** 模块职责：实现 packages/ai/src\api\pi-messages.lazy.ts 相关的模型、协议或工具逻辑。 */
