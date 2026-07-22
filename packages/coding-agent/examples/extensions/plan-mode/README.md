# 计划模式扩展

用于安全代码分析的只读探索模式。

## 功能

- **禁用内置写入工具**：禁用 edit/write，同时保留其他已启用工具
- **Bash 允许列表**：只允许只读 Bash 命令
- **计划提取**：从 `Plan:` 部分提取编号步骤
- **进度跟踪**：执行期间由小部件显示完成状态
- **[DONE:n] 标记**：显式跟踪步骤完成情况
- **会话持久化**：恢复会话后状态仍然保留

## 命令

- `/plan` - Toggle plan mode
- `/todos` - Show current plan progress
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## 用法

1. 使用 `/plan` 或 `--plan` 参数启用计划模式
2. 要求 Agent 分析代码并创建计划
3. Agent 应在 `Plan:` 标题下输出编号计划：

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. 出现提示时选择“Execute the plan”
5. 执行期间，Agent 使用 `[DONE:n]` 标签标记已完成步骤
6. 进度小部件显示完成状态

## 工作原理

### 计划模式（只读）
- 禁用内置 edit/write 工具
- 其他已启用工具仍可用
- Bash 命令经过允许列表过滤
- Agent 创建计划但不做修改

### 执行模式
- 恢复完整工具访问权限
- Agent 按顺序执行步骤
- 使用 `[DONE:n]` 标记跟踪完成情况
- 小部件显示进度

### 命令允许列表

安全命令（允许）：
- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

阻止的命令：
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
