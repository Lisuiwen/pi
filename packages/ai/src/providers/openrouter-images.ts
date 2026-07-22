/** 模块职责：实现 packages/ai/src\providers\openrouter-images.ts 相关的模型、协议或工具逻辑。 */
import { openrouterImagesApi } from "../api/openrouter-images.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { IMAGE_MODELS } from "../image-models.generated.ts";
import { createImagesProvider, type ImagesProvider } from "../images-models.ts";

export function openrouterImagesProvider(): ImagesProvider {
	return createImagesProvider({
		id: "openrouter",
		name: "OpenRouter",
		auth: { apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
		models: Object.values(IMAGE_MODELS.openrouter),
		api: openrouterImagesApi(),
	});
}
/** 模块职责：实现 packages/ai/src\providers\openrouter-images.ts 相关的模型、协议或工具逻辑。 */
