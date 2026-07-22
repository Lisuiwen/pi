#!/usr/bin/env node
/**
 * 模块职责：实现 coding-agent 源码模块「cli.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
/**
 * 命令行入口 for the refactored 编码代理.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// 在供应商 SDK 发起请求前配置 undici 的全局调度器。
// SettingsManager 加载全局和项目设置后应用运行时配置。
configureHttpDispatcher();

main(process.argv.slice(2));
