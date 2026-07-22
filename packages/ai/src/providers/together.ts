/** 模块职责：实现 packages/ai/src\providers\together.ts 相关的模型、协议或工具逻辑。 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { TOGETHER_MODELS } from "./together.models.ts";

export function togetherProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "together",
		name: "Together",
		baseUrl: "https://api.together.ai/v1",
		auth: { apiKey: envApiKeyAuth("Together API key", ["TOGETHER_API_KEY"]) },
		models: Object.values(TOGETHER_MODELS),
		api: openAICompletionsApi(),
	});
}
/** 模块职责：实现 packages/ai/src\providers\together.ts 相关的模型、协议或工具逻辑。 */
