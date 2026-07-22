/**
 * 模块职责：实现 packages/tui/src/editor-component.ts 中的核心功能。
 */

import type { AutocompleteProvider } from "./autocomplete.ts";
import type { Component } from "./tui.ts";

/**
 * Interface for custom editor components.
 *
 * 此allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
export interface EditorComponent extends Component {
	// =========================================================================
	// Core text access (required)
	// =========================================================================

	/** 获取当前文本内容 */
	getText(): string;

	/** 设置当前文本内容 */
	setText(text: string): void;

	/** 处理原始终端输入（按键、粘贴序列等） */
	handleInput(data: string): void;

	// =========================================================================
	// Callbacks (required)
	// =========================================================================

	/** 用户提交时调用（例如 Enter 键） */
	onSubmit?: (text: string) => void;

	/** 文本变化时调用 */
	onChange?: (text: string) => void;

	// =========================================================================
	// History support (optional)
	// =========================================================================

	/** 将文本加入历史记录以支持上下导航 */
	addToHistory?(text: string): void;

	// =========================================================================
	// Advanced text manipulation (optional)
	// =========================================================================

	/** Insert text at current cursor position */
	insertTextAtCursor?(text: string): void;

	/**
	 * 获取 text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	// =========================================================================
	// Autocomplete support (optional)
	// =========================================================================

	/** 设置自动补全提供器 */
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	// =========================================================================
	// Appearance (optional)
	// =========================================================================

	/** 边框颜色函数 */
	borderColor?: (str: string) => string;

	/** 设置水平内边距 */
	setPaddingX?(padding: number): void;

	/** 设置 max visible items in autocomplete dropdown */
	setAutocompleteMaxVisible?(maxVisible: number): void;
}
