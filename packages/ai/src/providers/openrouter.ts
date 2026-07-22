/** 模块职责：实现 packages/ai/src\providers\openrouter.ts 相关的模型、协议或工具逻辑。 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENROUTER_MODELS } from "./openrouter.models.ts";

export function openrouterProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "openrouter",
		name: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		auth: { apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
		models: Object.values(OPENROUTER_MODELS),
		api: openAICompletionsApi(),
	});
}
/** 模块职责：实现 packages/ai/src\providers\openrouter.ts 相关的模型、协议或工具逻辑。 */
