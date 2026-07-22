<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 默认情况下，来自新贡献者的新问题和 PR 会自动关闭。维护人员每天都会审查自动关闭的问题。参见 [CONTRIBUTING.md](CONTRIBUTING.md) 。

# Pi Agent Harness

这是 Pi 代理工具项目的所在地，包括我们的自扩展编码代理。

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**：交互式编码 Agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**：支持工具调用和状态管理的 Agent 运行时
* **[@earendil-works/pi-ai](packages/ai)**：统一的多提供商 LLM API（OpenAI、Anthropic、Google 等）

要了解有关 Pi 的更多信息：

* [Visit pi.dev](https://pi.dev) ，带有演示的项目网站
* [Read the documentation](https://pi.dev/docs/latest) ，但你也可以要求代理自行解释

## 所有套餐

| 包 | 说明 |
|---------|-------------|
| ** [@earendil-works/pi-ai](packages/ai) ** |统一多提供商LLM API（OpenAI、Anthropic、Google等）|
| ** [@earendil-works/pi-agent-core](packages/agent) ** |具有工具调用和状态管理功能的代理运行时 |
| ** [@earendil-works/pi-coding-agent](packages/coding-agent) ** |互动编码代理CLI |
| ** [@earendil-works/pi-tui](packages/tui) ** |具有差异化渲染的终端 UI 库 |

有关 Slack/聊天自动化和工作流程，请参阅 [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat) 。

## 权限和容器化

 Pi 不包含用于限制文件系统、进程、网络或凭据访问的内置权限系统。默认情况下，它以启动它的用户和进程的权限运行。

如果您需要更强的边界，请容器化或沙箱 Pi 。请参阅 [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) 了解三种模式：

- **Gondolin 扩展**：在主机上保留 `pi` 和提供商身份验证，同时将内置工具和 `!` 命令路由到本地 Linux 微虚拟机中。
- **Plain Docker**：在本地容器中运行整个 `pi` 进程以进行简单隔离。
- **OpenShell**：在策略控制的沙箱中运行整个 `pi` 进程。## 贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解贡献指南，请参阅 [AGENTS.md](AGENTS.md) 了解项目特定规则（适用于人类和代理）。  Pi 的长期计划也可以在 [RFCs](https://rfc.earendil.com/keyword/pi/) 中找到。

## 开发

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```
## 从发布源构建独立的二进制文件

GitHub 版本包括由该版本的 `SHA256SUMS` 文件涵盖的版本化源存档。提取它并运行与官方独立二进制文件相同的构建脚本：

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --platform linux-x64 --out "$PWD/out"
```
该脚本安装依赖项、构建 monorepo、编译 Bun 可执行文件并暂存其运行时资产。单独提供依赖项的包维护者可以通过 `--skip-install --skip-deps` 。

## 供应链强化

我们将 npm 依赖项更改视为已审核的代码更改。

- 直接外部依赖项固定到确切的版本。内部工作区包保留版本范围。
- `.npmrc` 设置 `save-exact=true` 和 `min-release-age=2` 以避免在 npm 解析期间当天依赖项发布。
- `package-lock.json` 是依赖事实。除非设置了 `PI_ALLOW_LOCKFILE_CHANGE=1`，否则预提交会阻止意外的锁定文件提交。
- `npm run check` 验证固定的直接依赖、本机 TypeScript 导入兼容性以及生成的编码代理收缩包装。
- 已发布的 CLI 软件包包括从根锁定文件生成的 `packages/coding-agent/npm-shrinkwrap.json` ，用于为 npm 用户固定传递依赖。
- 发布冒烟测试使用 `npm run release:local` 来构建、打包和创建隔离的 npm 以及在标记发布之前在存储库外部安装的 Bun。
- 本地版本安装、记录的 npm 安装和 `pi update --self` 在支持的情况下使用 `--ignore-scripts`。
- CI 与 `npm ci --ignore-scripts` 一起安装，预定的 GitHub 工作流程运行 `npm audit --omit=dev` 和 `npm audit signatures --omit=dev`。
- Shrinkwrap 生成具有明确的依赖生命周期脚本允许列表；新的生命周期脚本 deps 在经过审核之前无法通过检查。

## 分享您的 OSS 编码代理会话

如果您使用 Pi 或其他编码代理进行开源工作，请分享您的会话。

公共 OSS 会话数据有助于通过实际任务、工具使用、故障和修复（而不是玩具基准）来改进编码代理。

有关完整说明，请参阅 [this post on X](https://x.com/badlogicgames/status/2037811643774652911) 。

要发布会话，请使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) 。阅读其 README.md 以获取设置说明。您所需要的只是一个 Hugging Face 帐户、Hugging Face CLI 和 `pi-share-hf` 。

您还可以观看 [this video](https://x.com/badlogicgames/status/2041151967695634619) ，其中我展示了如何发布我的 `pi-mono` 会话。

我定期在这里发布我自己的 `pi-mono` 工作会议：

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono) 

## 许可证

麻省理工学院

 <p align="center"> 
   <a href="https://pi.dev"> pi.dev </a> 域名由以下人士慷慨捐赠
   <br /> <br /> 
   <a href="https://exe.dev"> <img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /> <br /> exe.dev </a> 
 </p>
