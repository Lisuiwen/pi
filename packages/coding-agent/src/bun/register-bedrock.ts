/**
 * 模块职责：实现 coding-agent 源码模块「bun\register-bedrock.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";

setBedrockProviderModule(bedrockProviderModule);
