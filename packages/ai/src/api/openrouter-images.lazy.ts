/** 模块职责：实现 packages/ai/src\api\openrouter-images.lazy.ts 相关的模型、协议或工具逻辑。 */
import type { ImagesModel, ProviderImages } from "../types.ts";

export const openrouterImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./openrouter-images.ts")).generateImages(
			model as ImagesModel<"openrouter-images">,
			context,
			options,
		),
});
/** 模块职责：实现 packages/ai/src\api\openrouter-images.lazy.ts 相关的模型、协议或工具逻辑。 */
