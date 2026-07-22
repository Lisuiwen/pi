/**
 * 模块职责：实现 coding-agent 源码模块「core\bash-executor.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
/**
 * 支持流式输出和取消操作的 Bash 命令执行器。
 *
 * 此模块提供统一的 Bash 执行实现，用于：
 * - 交互模式和 RPC 模式中的 AgentSession.executeBash()
 * - 需要执行 Bash 的模式所发起的直接调用
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// 类型
// ============================================================================

export interface BashExecutorOptions {
	/** 用于接收流式输出块（已清理）的回调 */
	onChunk?: (chunk: string) => void;
	/** 用于取消操作的 AbortSignal */
	signal?: AbortSignal;
}

export interface BashResult {
	/** 合并后的 stdout 和 stderr 输出（已清理，可能已截断） */
	output: string;
	/** 进程退出码（被终止或取消时为 undefined） */
	exitCode: number | undefined;
	/** 命令是否通过信号取消 */
	cancelled: boolean;
	/** 输出是否已截断 */
	truncated: boolean;
	/** 包含完整输出的临时文件路径（输出超过截断阈值时存在） */
	fullOutputPath?: string;
}

// ============================================================================
// 实现
// ============================================================================

/**
 * 使用自定义 BashOperations 执行 Bash 命令。
 * 用于远程执行（SSH、容器等）。
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;

	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		const id = randomBytes(8).toString("hex");
		tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
		tempFileStream = createWriteStream(tempFilePath);
		for (const chunk of outputChunks) {
			tempFileStream.write(chunk);
		}
	};

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// 清理输出：移除 ANSI、替换二进制乱码并规范化换行符
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// 超过阈值后开始写入临时文件
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// 维护滚动缓冲区
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// 将数据流式传给回调
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		if (truncationResult.truncated) {
			ensureTempFile();
		}
		if (tempFileStream) {
			tempFileStream.end();
		}
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		// 检查是否因取消操作而失败
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				ensureTempFile();
			}
			if (tempFileStream) {
				tempFileStream.end();
			}
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		if (tempFileStream) {
			tempFileStream.end();
		}

		throw err;
	}
}
