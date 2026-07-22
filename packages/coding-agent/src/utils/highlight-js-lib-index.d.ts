/**
 * 模块职责：实现 coding-agent 源码模块「utils\highlight-js-lib-index.d.ts」，负责相关命令行、会话、工具或基础设施逻辑。
 */
declare module "highlight.js/lib/index.js" {
	interface HighlightResult {
		value: string;
	}

	interface HighlightOptions {
		language: string;
		ignoreIllegals?: boolean;
	}

	interface HighlightJs {
		highlight(code: string, options: HighlightOptions): HighlightResult;
		highlightAuto(code: string, languageSubset?: string[]): HighlightResult;
		getLanguage(name: string): unknown;
	}

	const hljs: HighlightJs;
	export default hljs;
}
