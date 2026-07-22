# Shell 别名

Pi 以非交互模式（`bash -c`）运行 bash，默认不会展开别名。

要启用 Shell 别名，请将以下内容添加到 `~/.pi/agent/settings.json`：

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\neval \"$(grep '^alias ' ~/.zshrc)\""
}
```

请根据使用的 Shell 配置调整路径（`~/.zshrc`、`~/.bashrc` 等）。
