/**
 * 模块职责：实现 coding-agent 源码模块「extensions\index.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [{ name: "llama.cpp", factory: llamaExtension, hidden: true }];
