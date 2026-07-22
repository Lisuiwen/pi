/** 模块职责：实现 packages/ai/src\providers\moonshotai.ts 相关的模型、协议或工具逻辑。 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MOONSHOTAI_MODELS } from "./moonshotai.models.ts";

export function moonshotaiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "moonshotai",
		name: "Moonshot AI",
		baseUrl: "https://api.moonshot.ai/v1",
		auth: { apiKey: envApiKeyAuth("Moonshot AI API key", ["MOONSHOT_API_KEY"]) },
		models: Object.values(MOONSHOTAI_MODELS),
		api: openAICompletionsApi(),
	});
}
/** 模块职责：实现 packages/ai/src\providers\moonshotai.ts 相关的模型、协议或工具逻辑。 */
