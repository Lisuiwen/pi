# Windows 设置

Pi 在 Windows 上需要 bash shell。检查位置依次为：

1. `~/.pi/agent/settings.json` 中的自定义路径
2. Git Bash（`C:\\Program Files\\Git\\bin\\bash.exe`）
3. PATH 中的 `bash.exe`（Cygwin、MSYS2、WSL）

对大多数用户而言，安装 [Git for Windows](https://git-scm.com/download/win) 即可。

## 自定义 Shell 路径

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
