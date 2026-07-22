/**
 * 模块职责：实现 coding-agent 源码模块「core\models-store.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
import { join } from "node:path";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";

type StoredModels = Record<string, ModelsStoreEntry>;

export class InMemoryCodingAgentModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		return this.entries.get(providerId);
	}

	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		this.entries.set(providerId, entry);
	}

	async delete(providerId: string): Promise<void> {
		this.entries.delete(providerId);
	}
}

/** 使用锁保护、以 JSON 为后端的存储，用于动态刷新的提供商目录。 */
export class FileModelsStore implements ModelsStore {
	private readonly storage: AuthStorageBackend;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.storage = new FileAuthStorageBackend(path);
	}

	private parse(content: string | undefined): StoredModels {
		return content ? (JSON.parse(content) as StoredModels) : {};
	}

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		return this.storage.withLock((content) => ({
			result: structuredClone(this.parse(content)[providerId]),
		}));
	}

	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			current[providerId] = structuredClone(entry);
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		});
	}

	async delete(providerId: string): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			delete current[providerId];
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		});
	}
}
