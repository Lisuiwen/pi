/** 模块职责：实现 packages/ai/src\utils\typebox-helpers.ts 相关的模型、协议或工具逻辑。 */
import { type TUnsafe, Type } from "typebox";

/**
 * 创建与 Google API 及其他不支持 `anyOf`/`const` 模式的提供商兼容的字符串枚举 schema。
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "要执行的运算"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as any,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
/** 模块职责：实现 packages/ai/src\utils\typebox-helpers.ts 相关的模型、协议或工具逻辑。 */
