# 示例

展示 pi-coding-agent SDK 和扩展用法的示例代码。

## 目录

### [sdk/](sdk/)
通过 `createAgentSession()` 以编程方式使用。展示如何自定义模型、提示词、工具、扩展和会话管理。

### [extensions/](extensions/)
用于演示以下能力的示例扩展：
- 生命周期事件处理器（工具拦截、安全门禁、上下文修改）
- 自定义工具（待办列表、问题询问、子 Agent、输出截断）
- 命令和键盘快捷键
- 自定义 UI（页脚、页眉、编辑器、覆盖层）
- Git 集成（检查点、自动提交）
- 修改系统提示词和自定义上下文压缩
- 外部集成（SSH、文件监视器、系统主题同步）
- 自定义提供商（带自定义流式实现的 Anthropic、GitLab Duo）

## 文档

- [SDK Reference](sdk/README.md)
- [Extensions Documentation](../docs/extensions.md)
- [Skills Documentation](../docs/skills.md)
