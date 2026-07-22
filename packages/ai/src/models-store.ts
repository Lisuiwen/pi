/** 模块职责：实现 packages/ai/src\models-store.ts 相关的模型、协议或工具逻辑。 */
import type { Api, Model } from "./types.ts";

export interface ModelsStoreEntry {
	models: readonly Model<Api>[];
	/** 远端目录 `Last-Modified` 响应头对应的 Unix 时间戳。 */
	lastModified?: number;
	/** 最近一次远端检查完成时的 Unix 时间戳。 */
	checkedAt?: number;
}

/** 以提供商 ID 为键的持久化模型目录存储。 */
export interface ModelsStore {
	read(providerId: string): Promise<ModelsStoreEntry | undefined>;
	write(providerId: string, entry: ModelsStoreEntry): Promise<void>;
	delete(providerId: string): Promise<void>;
}

/** 绑定到单个提供商的 `ModelsStore` 视图。提供商不能访问其他提供商的目录。 */
export interface ProviderModelsStore {
	read(): Promise<ModelsStoreEntry | undefined>;
	write(entry: ModelsStoreEntry): Promise<void>;
	delete(): Promise<void>;
}

export class InMemoryModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		const entry = this.entries.get(providerId);
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string): Promise<void> {
		this.entries.delete(providerId);
	}
}
/** 模块职责：实现 packages/ai/src\models-store.ts 相关的模型、协议或工具逻辑。 */
