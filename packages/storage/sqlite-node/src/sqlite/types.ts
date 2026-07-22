/**
 * 模块职责：实现 packages/storage/sqlite-node/src/sqlite/types.ts 中的核心功能。
 */

import type { FileSystem, SessionCreateOptions, SessionMetadata, SessionRepo } from "@earendil-works/pi-agent-core";

/** ……的结果：已准备 SQLite 语句的执行结果. */
export interface SqliteRunResult {
	/** 数量：语句变更的行数. */
	changes: number;
	/** 后端提供的插入行 ID. */
	lastInsertRowid?: number;
}

/** 已准备的SQLite SQLite 会话后端使用的语句能力. */
export interface SqliteStatement {
	run(...params: unknown[]): Promise<SqliteRunResult>;
	get<TRow extends object>(...params: unknown[]): Promise<TRow | undefined>;
	all<TRow extends object>(...params: unknown[]): Promise<TRow[]>;
}

/** SQLite SQLite 会话后端使用的数据库能力. */
export interface SqliteDatabase {
	exec(sql: string): Promise<void>;
	prepare(sql: string): SqliteStatement;
	transaction<T>(fn: () => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

export interface SqliteDatabaseFactory {
	open(path: string): Promise<SqliteDatabase>;
}

export interface SqliteSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	parentSessionId?: string;
	metadata?: Record<string, unknown>;
}

export interface SqliteSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
	parentSessionId?: string;
	metadata?: Record<string, unknown>;
}

export interface SqliteSessionListOptions {
	cwd?: string;
}

export interface SqliteSessionBackendOptions {
	kind: "sqlite";
	databasePath: string;
}

export interface SqliteSessionRepoApi
	extends SessionRepo<SqliteSessionMetadata, SqliteSessionCreateOptions, SqliteSessionListOptions> {}

export type SqliteSessionRepoEnv = Pick<FileSystem, "absolutePath" | "createDir" | "exists">;
