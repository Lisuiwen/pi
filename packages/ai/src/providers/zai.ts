/** 模块职责：实现 packages/ai/src\providers\zai.ts 相关的模型、协议或工具逻辑。 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ZAI_MODELS } from "./zai.models.ts";

export function zaiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "zai",
		name: "Z.AI",
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		auth: { apiKey: envApiKeyAuth("Z.AI API key", ["ZAI_API_KEY"]) },
		models: Object.values(ZAI_MODELS),
		api: openAICompletionsApi(),
	});
}
/** 模块职责：实现 packages/ai/src\providers\zai.ts 相关的模型、协议或工具逻辑。 */
