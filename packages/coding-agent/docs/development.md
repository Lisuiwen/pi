# 开发

更多指南请参阅 [AGENTS.md](https://github.com/earendil-works/pi-mono/blob/main/AGENTS.md)。

## 设置

```bash
git clone https://github.com/earendil-works/pi-mono
cd pi-mono
npm install
npm run build
```

从源码运行：

```bash
/path/to/pi-mono/pi-test.sh
```

脚本可从任意目录运行。Pi 会保留调用者的当前工作目录。

## 分叉 / 重新品牌化

Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

为分叉版本修改 `name`、`configDir` 和 `bin` 字段。这会影响 CLI 横幅、配置路径和环境变量名称。

## 路径解析

有三种执行模式：npm 安装、独立二进制文件、从源码使用 tsx 运行。

处理包资源时**始终使用 `src/config.ts`**：

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

不要直接使用 `__dirname` 访问包资源。

## 调试命令

`/debug`（隐藏命令）会写入 `~/.pi/agent/pi-debug.log`：
- 带 ANSI 代码的 TUI 渲染行
- 发送给 LLM 的最近消息

## 测试

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## 项目结构

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
