# llama.cpp

Pi 支持 [llama.cpp](https://github.com/ggml-org/llama.cpp) 路由服务器。路由器可发现多个 GGUF 模型，并按需加载或卸载。

请使用支持路由器的最新 llama.cpp 构建版本。可参阅[构建说明](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)，或为你的平台安装[预构建版本](https://github.com/ggml-org/llama.cpp/releases)。

## 启动路由器

启动 `llama-server` 时不要指定 `--model` 或 `-m`。传入模型会启动单模型模式，而不是路由模式。

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

重要选项：

- `--models-dir ~/models` discovers local GGUF files.
- `--no-models-autoload` keeps loading explicit through `/llama`.
- `--jinja` enables compatible chat templates and tool calling.
- `-ngl 999` offloads as many layers as possible to the GPU.
- `-c 32768` sets the context window for each loaded model. Omit it to use the model's native context, which may require substantially more memory.

A single-file model can sit directly in the model directory. Put multimodal and multi-shard models in separate subdirectories:

```text
~/models/
├── llama-3.2-1b-Q4_K_M.gguf
├── gemma-3-4b-it-Q4_K_M/
│   ├── gemma-3-4b-it-Q4_K_M.gguf
│   └── mmproj-F16.gguf
└── large-model-Q4_K_M/
    ├── large-model-Q4_K_M-00001-of-00003.gguf
    ├── large-model-Q4_K_M-00002-of-00003.gguf
    └── large-model-Q4_K_M-00003-of-00003.gguf
```

手动添加文件后请重启路由器。有关每个模型的上下文大小和其他选项，请使用 [llama.cpp 模型预设](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets)。

## 配置 Pi

启动 Pi 并配置 provider：

```text
/login llama.cpp
```

输入路由器 URL 和可选 API 密钥。默认 URL 为 `http://127.0.0.1:8080`。

也可通过环境变量配置相同值，无需使用 `/login`：

```bash
export LLAMA_BASE_URL=http://127.0.0.1:8080
export LLAMA_API_KEY=optional-secret
pi
```

如果服务器使用 API 密钥，请使用匹配的 `--api-key` 值启动 `llama-server`。仅限本机访问时保留 `--host 127.0.0.1`。

## 管理模型

Run:

```text
/llama
```

- 选择未加载的模型以加载它。
- 选择已加载的模型以卸载它。
- 选择 **Download model…**，搜索 Hugging Face，然后选择仓库和量化版本。也可直接输入 `owner/repository[:quant]`。
- 加载或下载过程中按 Escape 确认取消。

Hugging Face search uses `HF_TOKEN` when set, then checks `$HF_TOKEN_PATH`, `$HF_HOME/token`, `$XDG_CACHE_HOME/huggingface/token`, and `~/.cache/huggingface/token`. Search also works without authentication, subject to lower rate limits. Pi warns before downloading gated repositories and links to their access page. The llama.cpp server performs the download, so its process must also have `HF_TOKEN` when the selected repository requires access.

如果已有其他模型加载，Pi 会询问先卸载还是保留。Pi 不会静默卸载模型，也不会删除模型文件。路由器可能与其他客户端共享，因此 `/llama` 始终显示路由器当前状态。

只有已加载的模型会出现在 `/model` 中。加载模型后运行 `/model`，为当前 Pi 会话选择它。

如果路由器断开连接，`/llama` 会显示 **Retry** 和 **Close**。Retry 会重新连接并刷新模型状态，不会重放中断的操作。

## 故障排除

Check that the router is reachable:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

- **`/llama` 中没有模型：** 检查 `--models-dir`、目录结构，然后重启路由器。
- **`/model` 中缺少模型：** 先用 `/llama` 加载它。
- **加载失败或占用内存过多：** 降低 `-c`，或卸载其他模型。
- **服务器不在路由模式：** 启动时不要使用 `--model`、`-m` 或 `-hf`。
