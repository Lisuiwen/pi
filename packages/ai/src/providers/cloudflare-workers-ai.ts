/** 模块职责：实现 packages/ai/src\providers\cloudflare-workers-ai.ts 相关的模型、协议或工具逻辑。 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { cloudflareWorkersAIAuth } from "./cloudflare-auth.ts";
import { cloudflareStreams } from "./cloudflare-stream.ts";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "./cloudflare-workers-ai.models.ts";

export function cloudflareWorkersAIProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "cloudflare-workers-ai",
		name: "Cloudflare Workers AI",
		auth: { apiKey: cloudflareWorkersAIAuth() },
		models: Object.values(CLOUDFLARE_WORKERS_AI_MODELS),
		api: cloudflareStreams(openAICompletionsApi()),
	});
}
/** 模块职责：实现 packages/ai/src\providers\cloudflare-workers-ai.ts 相关的模型、协议或工具逻辑。 */
