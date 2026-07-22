/** 模块职责：实现 packages/ai/src\api\google-vertex.lazy.ts 相关的模型、协议或工具逻辑。 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleVertexApi = (): ProviderStreams => lazyApi(() => import("./google-vertex.ts"));
/** 模块职责：实现 packages/ai/src\api\google-vertex.lazy.ts 相关的模型、协议或工具逻辑。 */
