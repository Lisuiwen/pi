/** 模块职责：实现 packages/ai/src\providers\zai-coding-cn.ts 相关的模型、协议或工具逻辑。 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ZAI_CODING_CN_MODELS } from "./zai-coding-cn.models.ts";

export function zaiCodingCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "zai-coding-cn",
		name: "Z.AI Coding CN",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		auth: { apiKey: envApiKeyAuth("Z.AI Coding CN API key", ["ZAI_CODING_CN_API_KEY"]) },
		models: Object.values(ZAI_CODING_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
/** 模块职责：实现 packages/ai/src\providers\zai-coding-cn.ts 相关的模型、协议或工具逻辑。 */
