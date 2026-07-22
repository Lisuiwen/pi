# tmux 设置

Pi 可以在 tmux 中运行，但 tmux 默认会剥离某些按键的修饰键信息。未配置时，`Shift+Enter` 和 `Ctrl+Enter` 通常无法与普通 `Enter` 区分。

## 推荐配置

将以下内容添加到 `~/.tmux.conf`：

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

然后完全重启 tmux：

```bash
tmux kill-server
tmux
```

当 Kitty 键盘协议不可用时，Pi 会自动请求扩展按键报告。使用 `extended-keys-format csi-u` 时，tmux 以 CSI-u 格式转发修饰键，这是最可靠的配置。该选项需要 tmux 3.5 或更高版本。

## 为什么推荐 `csi-u`

仅设置 `extended-keys on` 时，tmux 默认使用 `extended-keys-format xterm`。应用请求扩展按键报告后，修饰键会以 xterm `modifyOtherKeys` 格式转发。

使用 `extended-keys-format csi-u` 时，按键会以 CSI-u 格式转发。

Pi 支持两种格式，但推荐使用 `csi-u`。

## 修复内容

没有 tmux 扩展按键时，带修饰键的 Enter 会退化为传统序列。这会影响默认按键绑定（`Enter` 提交，`Shift+Enter` 换行）以及使用修饰键 Enter 的自定义绑定。

## 要求

- tmux 3.5 或更高版本（运行 `tmux -V` 检查）
- 支持扩展按键的终端模拟器（Ghostty、Kitty、iTerm2、WezTerm、Windows Terminal）

tmux 3.2 至 3.4 可省略 `extended-keys-format csi-u`；Pi 仍支持 tmux 默认的 xterm `modifyOtherKeys` 格式。
