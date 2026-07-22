/** 模块职责：实现 packages/ai/src\auth\credential-store.ts 相关的模型、协议或工具逻辑。 */
import type { Credential, CredentialInfo, CredentialStore } from "./types.ts";

/**
 * 默认的内存凭据存储。应用可注入持久化存储。
 * 以 `Provider.id` 为键，每个提供商保存一个凭据；参见 `CredentialStore`。
 * 每个提供商的写操作通过 Promise 链串行执行。
 */
export class InMemoryCredentialStore implements CredentialStore {
	private credentials = new Map<string, Credential>();
	private chains = new Map<string, Promise<unknown>>();

	/** 按提供商 id 串行执行任务。 */
	private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = (async () => {
			await previous.catch(() => {});
			return task();
		})();
		this.chains.set(
			providerId,
			next.catch(() => {}),
		);
		return next;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.credentials.get(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.enqueue(providerId, async () => {
			const current = this.credentials.get(providerId);
			const next = await fn(current);
			if (next !== undefined) this.credentials.set(providerId, next);
			return next ?? current;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.enqueue(providerId, async () => {
			this.credentials.delete(providerId);
		});
	}
}
/** 模块职责：实现 packages/ai/src\auth\credential-store.ts 相关的模型、协议或工具逻辑。 */
