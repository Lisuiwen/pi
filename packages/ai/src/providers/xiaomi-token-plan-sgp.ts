/** 模块职责：实现 packages/ai/src\providers\xiaomi-token-plan-sgp.ts 相关的模型、协议或工具逻辑。 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { XIAOMI_TOKEN_PLAN_SGP_MODELS } from "./xiaomi-token-plan-sgp.models.ts";

export function xiaomiTokenPlanSgpProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "xiaomi-token-plan-sgp",
		name: "Xiaomi Token Plan SGP",
		baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
		auth: { apiKey: envApiKeyAuth("Xiaomi Token Plan SGP API key", ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"]) },
		models: Object.values(XIAOMI_TOKEN_PLAN_SGP_MODELS),
		api: openAICompletionsApi(),
	});
}
/** 模块职责：实现 packages/ai/src\providers\xiaomi-token-plan-sgp.ts 相关的模型、协议或工具逻辑。 */
