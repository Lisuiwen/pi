> pi 可以创建提示词模板。让它为你的工作流构建一个模板。

# 提示词模板

提示词模板是可展开为完整提示词的 Markdown 片段。在编辑器中输入 `/name` 调用模板，其中 `name` 是去掉 `.md` 后缀的文件名。

## 位置

Pi 从以下位置加载提示词模板：

- Global: `~/.pi/agent/prompts/*.md`
- Project: `.pi/prompts/*.md` (only after the project is trusted)
- Packages: `prompts/` directories or `pi.prompts` entries in `package.json`
- Settings: `prompts` array with files or directories
- CLI: `--prompt-template <path>` (repeatable)

使用 `--no-prompt-templates` 禁用发现。

## 格式

```markdown
---
description: Review staged git changes
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors
- Security issues
- Error handling gaps
```

- 文件名会成为命令名。例如 `review.md` 变为 `/review`。
- `description` 可选。缺失时使用第一行非空文本。
- `argument-hint` 可选。设置后，自动补全下拉框会在描述前显示提示。

### 参数提示

在 frontmatter 中使用 `argument-hint`，即可在自动补全中显示预期参数。必需参数使用 `<尖括号>`，可选参数使用 `[方括号]`：

```markdown
---
description: Review PRs from URLs with structured issue and code analysis
argument-hint: "<PR-URL>"
---
```

This renders in the autocomplete dropdown as:

```
→ pr   <PR-URL>       — Review PRs from URLs with structured issue and code analysis
  is   <issue>        — Analyze GitHub issues (bugs or feature requests)
  wr   [instructions] — Finish the current task end-to-end
  cl   — Audit changelog entries before release
```

## 用法

在编辑器中输入 `/` 加模板名。自动补全会显示可用模板及描述。

```
/review                           # Expands review.md
/component Button                 # Expands with argument
/component Button "click handler" # Multiple arguments
```

## 参数

模板支持位置参数、默认值和简单切片：

- `$1`, `$2`, ... positional args
- `$@` or `$ARGUMENTS` for all args joined
- `${1:-default}` uses arg 1 when present/non-empty, otherwise `default`
- `${@:-default}` or `${ARGUMENTS:-default}` uses all arguments when present/non-empty, otherwise `default`
- `${@:N}` for args from the Nth position (1-indexed)
- `${@:N:L}` for `L` args starting at N

Example:

```markdown
---
description: Create a component
---
Create a React component named $1 with features: $@
```

默认值适用于可选参数：

```markdown
Summarize the current state in ${1:-7} bullet points.
```

Usage: `/component Button "onClick handler" "disabled support"`

## 加载规则

- `prompts/` 中的模板发现不会递归子目录。
- 如需使用子目录中的模板，请通过 `prompts` 设置或包清单显式添加。
