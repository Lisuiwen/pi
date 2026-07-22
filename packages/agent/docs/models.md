# Models 架构

本文档描述下一阶段 `pi-ai` 模型/提供商重构的目标设计，说明期望形态而非当前实现，内容应足以从全新会话开始实施。

目标：

- `Models` 是只负责运行时集合管理的提供商容器。
- 具体提供商拥有元数据、认证、模型列表和流式行为。
- API 实现在 `src/api/` 下，可复用且按需加载。
- 具体提供商工厂位于 `src/providers/` 下。
- 用户只能导入需要的提供商。
- 导入提供商不能提前加载重量级 SDK。
- 动态模型列表是一等能力：读取同步返回已知列表，抓取通过显式异步 `refresh` 完成。
- `models.json` 和扩展通过包装提供商实现叠加，而不是临时修改提供商内部状态。
- 旧全局 API 仅通过显式且临时的 `/compat` 入口保留。

本阶段 `pi-ai` 的非目标：

- 暂不迁移 coding-agent 的 `ModelRegistry`。
- 不在 `Models` 内保留流式/API 注册表。
- 暂不实现 Web OAuth 流程。
- 图像生成镜像聊天侧设计（`images-models.ts` 中的 `ImagesModels`/`ImagesProvider`）；旧全局图像 API（`images.ts`、`images-api-registry.ts`）保留在 compat 中。

## 包布局

目标源码布局：

```txt
packages/ai/src/
  index.ts                    # core exports only; no built-in provider imports
  models.ts                   # Models runtime, Provider
  images-models.ts            # ImagesModels runtime, ImagesProvider (mirrors models.ts)
  compat.ts                   # temporary old-API compatibility entrypoint
  auth/                       # auth method types, helpers, shared resolveProviderAuth(), login callbacks
  api/                        # API implementations and lazy wrappers
    openai-completions.ts     # real implementation, imports SDKs, exports stream/streamSimple
    openai-completions.lazy.ts
    openai-responses.ts
    openai-responses.lazy.ts
    openai-codex-responses.ts
    openai-codex-responses.lazy.ts
    azure-openai-responses.ts
    azure-openai-responses.lazy.ts
    anthropic-messages.ts
    anthropic-messages.lazy.ts
    google-generative-ai.ts
    google-generative-ai.lazy.ts
    google-vertex.ts
    google-vertex.lazy.ts
    mistral-conversations.ts
    mistral-conversations.lazy.ts
    bedrock-converse-stream.ts
    bedrock-converse-stream.lazy.ts
    openrouter-images.ts      # image-generation API implementation
    openrouter-images.lazy.ts
    lazy.ts                   # lazyStream()/lazyApi() helpers
    (shared helpers: openai-responses-shared, google-shared, transform-messages, ...)
  providers/                  # concrete provider factories and per-provider catalogs
    openai.ts
    openai.models.ts          # generated OpenAI catalog
    openai-codex.ts
    openai-codex.models.ts
    anthropic.ts
    anthropic.models.ts
    google.ts
    google.models.ts
    ...one pair per built-in provider...
    openrouter-images.ts      # image-generation provider factory
    faux.ts                   # test provider factory
    all.ts                    # explicit aggregate: builtinModels(), builtinImagesModels(), getBuiltin*()
  auth/oauth/                 # Canonical OAuth implementations (node), lazy-loaded
```

`src/index.ts` must stay core-only. It must not import:

- generated model catalogs
- built-in provider factories
- provider SDK implementations
- Node-only OAuth modules
- `providers/all`
- `compat`

提供商、API 和 compat 入口均通过明确的子路径导出。

## 公共用法

最小提供商用法：

```ts
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const models = createModels();
models.setProvider(openaiProvider());

const model = models.getModel("openai", "gpt-4o-mini");
if (!model) throw new Error("model not found");

const response = await models.complete(model, context);
```

多个提供商：

```ts
const models = createModels();
models.setProvider(openaiProvider());
models.setProvider(openrouterProvider());
```

显式加载全部内置元数据的入口：

```ts
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const models = builtinModels();
```

`providers/all` 可以导入全部提供商元数据/目录，但仍不能提前导入 SDK 实现；提供商流式方法使用惰性包装器。

## 核心运行时：Models

`Models` 是提供商集合，负责应用认证并提供流式便捷方法；不包含流式注册表或认证解析策略对象。

```ts
export function createModels(options?: {
  /** App-owned credential storage. Default: in-memory store. */
  credentials?: CredentialStore;
  /** Environment access for auth resolution (env vars, file existence). Default: process.env/node:fs backed; injectable for tests and non-Node hosts. */
  authContext?: AuthContext;
}): MutableModels;

export interface Models {
  getProviders(): readonly Provider[];
  getProvider(id: string): Provider | undefined;

  /** Sync read of last-known models. Best-effort: a provider whose getModels() throws yields no models. */
  getModels(provider?: string): readonly Model<Api>[];
  /** Dynamic lists are honestly Model<Api>; narrow with the hasApi() guard. */
  getModel(provider: string, id: string): Model<Api> | undefined;

  /**
   * Ask dynamic providers to re-fetch their model lists. With a provider id,
   * rejects on that provider's failure; without, refreshes all concurrently
   * best-effort. Static providers are no-ops.
   */
  refresh(provider?: string): Promise<void>;

  /**
   * Resolve request auth for a model. Includes source label for status UI.
   * Resolves undefined when the provider is unknown or unconfigured. Rejects
   * with ModelsError ("oauth" on refresh failure, "auth" on api-key/store
   * failure); status/availability UIs catch rejections and render
   * "needs re-login" instead of treating them as unconfigured.
   */
  getAuth(model: Model<Api>): Promise<AuthResult | undefined>;

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ApiStreamOptions<TApi>,
  ): AssistantMessageEventStream;

  complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ApiStreamOptions<TApi>,
  ): Promise<AssistantMessage>;

  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
}

export interface MutableModels extends Models {
  /** Upsert/replace by provider.id. Provider ids are unique. */
  setProvider(provider: Provider): void;
  deleteProvider(id: string): void;
  clearProviders(): void;
}
```

已移除的概念：

```txt
no Models.setStreamFunctions() / getStreamFunctions()
no api-registry as a real dispatch mechanism
no Models.provider(id) builder, no setModel/upsertModel/patchModel lifecycle
no ModelAuthResolver / setAuthResolver — resolution policy is fixed, store is injected
```

如果应用需要不同认证策略，应包装提供商（包装认证方法或 `getModels`），或在流选项中传入显式请求认证。

## 提供商

提供商是具体的运行时单元，拥有 id/name/base 元数据、认证方法、模型列表和流式行为。

`Provider` is generic over the APIs its models use. Concrete factories declare what they emit (`openaiProvider(): Provider<"openai-responses" | "openai-completions">`), giving typed model lists to direct factory users. A `Models` collection holds providers as `Provider<Api>`.

```ts
export interface Provider<TApi extends Api = Api> {
  readonly id: string;
  readonly name: string;

  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;

  /**
   * Required: at least one of apiKey/oauth. Even ambient-credential providers
   * (env vars, AWS profiles, ADC) and keyless local servers provide apiKey
   * auth whose resolve() reports whether the provider is configured.
   * getAuth() returning undefined = not configured.
   */
  readonly auth: ProviderAuth;

  /** Current known models, sync. Static providers: the catalog. Dynamic providers: as of the last refresh (empty before the first). */
  getModels(): readonly Model<TApi>[];

  /** Dynamic providers only: fetch and update the model list. Concurrent calls share one in-flight fetch. */
  refreshModels?(): Promise<void>;

  stream<T extends TApi>(model: Model<T>, context: Context, options?: ApiStreamOptions<T>): AssistantMessageEventStream;

  streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}
```

不存在 `Provider.api` 字段。`model.api` 携带 API 标识，提供商在内部完成分发（参见 `createProvider()`）。

`Model.api` remains: existing metadata and tests use it, it is useful for diagnostics, and provider construction uses it for API implementation selection. But `Models` never dispatches on it; the provider does.

### 类型化流选项

完整流选项与 API 相关。`Model<TApi>` 可以根据 API 推导选项类型：

```ts
// types.ts — type-only imports from API impl modules are erased, so this is tree-shake safe
export interface ApiOptionsMap {
  "anthropic-messages": AnthropicOptions;
  "openai-completions": OpenAICompletionsOptions;
  "openai-responses": OpenAIResponsesOptions;
  "openai-codex-responses": OpenAICodexResponsesOptions;
  "azure-openai-responses": AzureOpenAIResponsesOptions;
  "google-generative-ai": GoogleOptions;
  "google-vertex": GoogleVertexOptions;
  "mistral-conversations": MistralOptions;
  "bedrock-converse-stream": BedrockOptions;
}

export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
  ? ApiOptionsMap[TApi]
  : StreamOptions & Record<string, unknown>;
```

自定义 API 字符串回退到通用结构。

### 类型化模型收窄

运行时模型列表是动态的，因此 `models.getModel()`/`getModels()` 如实返回 `Model<Api>`。以下三个位置可以增强类型：

1. **`hasApi()` type guard** — runtime-checked narrowing for dynamic lookups (no blind casts):

   ```ts
   export function hasApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi>;

   const model = models.getModel("anthropic", "claude-opus-4-7");
   if (model && hasApi(model, "anthropic-messages")) {
     // model: Model<"anthropic-messages">, stream options fully typed
   }
   ```

2. **`getBuiltinModel()`** — sync, generated-catalog lookup with typed overloads: `(provider, id) -> Model<exact-api-literal>`. The path for hardcoded known models.

3. **`Provider<TApi>` factories** — typed model lists when using a provider directly, without a `Models` collection.

有意不做的事情：将 `models.getModel(provider, ...)` 绑定到类型化的提供商/模型 ID，需要静态知道可变运行时集合中安装了哪些提供商。Harness 路径（`streamSimple` + `SimpleStreamOptions`）与 API 无关，不受影响。

作为对比，Vercel AI SDK 将实现附加到模型对象，虽然消除了分发类型问题，却使模型不可序列化（会话、RPC 和目录无法作为普通数据使用）；其 `providerOptions` 包是 `Record<string, JSON>`，仅靠 `satisfies` 约定检查。普通数据模型加提供商自有行为，可以在关键位置保留更强的类型。

### 名称冲突

`types.ts` currently exports `type Provider = KnownProvider | string` (a provider id). Rename that alias to `ProviderId` and fix call sites. The `Provider` interface above takes the name.

## 提供商模型列表

读取是同步的，抓取使用显式异步动词。`Provider.getModels()` 返回当前已知列表：静态提供商返回完整目录，动态提供商（llama.cpp、OpenRouter 实时列表）返回最近刷新列表。动态抓取在 `refreshModels()` 中完成。

这样拆分是因为同步/异步联合类型（`Promise<T> | T`）会埋下同步假设，遇到第一个异步提供商就可能崩溃；而仅异步读取会迫使所有消费者（UI 列表、扩展的 `find`/`getAll` 接口）为通常静态的数据使用 Promise。同步读取加显式刷新能让陈旧性可见，并保持单一契约：`getModels()` = 已知列表，`refresh()` = 更新为当前列表。抓取结果返回的瞬间也可能过时，因此明确刷新点更诚实。

应用负责刷新生命周期：启动、重新加载注册表、打开模型选择器。对新鲜度敏感的查找分两步执行：`await models.refresh("llamacpp"); models.getModel("llamacpp", id)`。

动态刷新必须是无副作用的发现操作：

```txt
可以：获取 `/v1/models`、枚举本地目录、刷新缓存的远程模型列表
不可以：加载模型、下载模型、修改服务器状态、执行请求探测
```

提供商特有的模型生命周期（加载/卸载）应由应用或提供商管理命令负责，而不是放进 `refreshModels()`。

## 流式路径

`Models.stream()` 根据 `model.provider` 查找提供商，解析认证，将认证合并到请求选项后委托执行：

```ts
function stream(model, context, options) {
  const provider = this.getProvider(model.provider);
  if (!provider) {
    // produce an error stream, not a throw — see Error behavior
  }

  // async setup happens inside the returned stream (lazyStream pattern)
  const resolution = await this.getAuth(model);
  const requestModel = resolution?.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model;
  const requestOptions = mergeAuth(options, resolution?.auth); // explicit options win per-field

  return provider.stream(requestModel, context, requestOptions);
}
```

`stream()` 同步返回 `AssistantMessageEventStream`；异步准备工作（认证解析、惰性模块加载）在返回的流内部完成。当前 `register-builtins.ts` 已有转发模式（`createLazyStream`），应将其提取为 `src/api/lazy.ts` 中的 `lazyStream()`。

请求热路径不做模型规范化：`stream()` 原样使用传入的模型对象。若应用需要最新元数据，应在开始回合前刷新提供商并重新读取（`await models.refresh(p); models.getModel(p, id)`）。

## `src/api` 下的 API 实现

API 实现是可复用的流式行为，不是提供商。

统一导出契约——每个真实实现模块恰好导出：

```ts
// src/api/anthropic-messages.ts — imports SDKs
export function stream(model, context, options) { ... }
export function streamSimple(model, context, options) { ... }
```

This makes the module itself satisfy `ProviderStreams`, so the lazy wrapper is one generic helper instead of bespoke per-API plumbing. `ProviderStreams` is the untyped dispatch shape (implementation modules export concretely typed functions, which would not be assignable to a generic method); per-API option typing lives on the modules themselves and on `Provider.stream()` via `ApiStreamOptions`:

```ts
export interface ProviderStreams {
  stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

// src/api/lazy.ts
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams;

// src/api/anthropic-messages.lazy.ts
export const anthropicMessagesApi = (): ProviderStreams => lazyApi(() => import("./anthropic-messages.ts"));
```

导入链：

```txt
provider module -> lazy API wrapper -> dynamic import(real API impl) -> SDK deps
```

说明：

- Bedrock keeps the node-only dynamic import trick (`importNodeOnlyProvider`, `.ts`/`.js` specifier rewrite) inside its lazy wrapper. `setBedrockProviderModule()` (used by the Bun build) moves into the bedrock lazy wrapper module.
- Shared helper modules (`openai-responses-shared.ts`, `google-shared.ts`, `transform-messages.ts`, prompt-cache, copilot headers) move to `src/api/` alongside the implementations.

## 具体提供商之间共享 API 实现

许多具体提供商共享同一 API 实现（OpenAI completions：OpenRouter、Groq、Cerebras、xAI、ZAI 等），通过引用共享惰性 API 对象：

```ts
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";

export function openrouterProvider(): Provider {
  return createProvider({
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
    models: OPENROUTER_MODELS,
    api: openAICompletionsApi(),
  });
}
```

这借鉴了 Vercel AI SDK 的优点：用户导入具体提供商，共享的协议实现保持内部化。

## 认证

请求认证输出保持精简：

```ts
export interface ModelAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}
```

如果某个值无法表示为 `apiKey`、`headers` 或 `baseUrl`，它就属于提供商配置而非认证（Vertex project/location、Bedrock region/profile、Azure apiVersion 都是提供商工厂选项）。

### 提供商认证

`Provider.auth` has exactly two slots; real providers have at most one api-key path and at most one OAuth path, and the slot names carry the UI's oauth-vs-api-key split without a `kind` discriminant or method ids:

```ts
export interface ProviderAuth {
  apiKey?: ApiKeyAuth; // stored key/provider env + ambient env/files/ADC/IAM
  oauth?: OAuthAuth;   // login flow + refresh
}

export interface ApiKeyAuth {
  name: string; // "Anthropic API key"

  /** Interactive setup (prompt for key/provider env). Absent = ambient-only (env, ADC, IAM). */
  login?(interaction: AuthInteraction): Promise<ApiKeyCredential>;

  /**
   * Resolve auth from the stored credential and/or ambient sources, merging
   * per field (credential.key ?? env("..."), credential.env?.NAME ?? env("...")).
   * undefined = not configured.
   */
  resolve(input: {
    model: Model<Api>;
    ctx: AuthContext;
    credential?: ApiKeyCredential;
  }): Promise<AuthResult | undefined>;
}

export interface OAuthAuth {
  name: string; // "Anthropic (Claude Pro/Max)"

  login(interaction: AuthInteraction): Promise<OAuthCredential>;

  /** Exchange the refresh token. Network call; throws on failure (invalid_grant etc.). Runs under the store lock. */
  refresh(credential: OAuthCredential): Promise<OAuthCredential>;

  /** Side-effect-free derivation of request auth from a valid credential. Covers Copilot-style per-credential baseUrl. Async so lazy wrappers can load the implementation. */
  toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

export interface AuthResult {
  auth: ModelAuth;
  /** Human-readable label for status UI: "ANTHROPIC_API_KEY", "OAuth", "~/.aws/credentials". */
  source?: string;
}

export interface AuthContext {
  env(name: string): Promise<string | undefined>;
  fileExists(path: string): Promise<boolean>; // supports leading ~
}
```

`refresh`/`toAuth` 的拆分让 `Models` 在无需复杂闭包的情况下负责加锁刷新：refresh 生成凭据，`toAuth` 根据最终存储的凭据推导请求认证。

OAuth 实现直接使用与提供商无关的 `AuthInteraction` 协议。回调服务器流程会发出与服务器竞争的 `manual_code` 提示，回调成功后中止提示，因此 UI 不需要提供商专用回调或静态回调服务器标记。

### 凭据

每个提供商一个带类型标签的凭据，形状与当前 `auth.json` 完全一致（每个 provider id 对应 `type: "api_key" | "oauth"`）：

```ts
export interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: ProviderEnv; // e.g. Cloudflare account/gateway ids, Azure/Vertex/Bedrock scoped config
}

export interface OAuthCredential extends OAuthCredentials {
  type: "oauth"; // access, refresh, expires from OAuthCredentials
}

export type Credential = ApiKeyCredential | OAuthCredential;
```

`ApiKeyCredential.env` stores provider-scoped environment/config values alongside or instead of a key. `ApiKeyAuth.resolve()` merges per field: `credential.key ?? env("CLOUDFLARE_API_KEY")`, `credential.env?.CLOUDFLARE_ACCOUNT_ID ?? env("CLOUDFLARE_ACCOUNT_ID")`, etc. The credential discriminator intentionally matches today's `auth.json` (`api_key`) so the file-backed store does not need lossy type translation.

### 凭据存储

应用注入存储；`pi-ai` 提供内存默认实现。按 provider id 索引，每个提供商一个凭据：

```ts
export interface CredentialStore {
  /** Read the stored credential, possibly expired. Display/status use; request auth comes from Models.getAuth(). */
  read(providerId: string): Promise<Credential | undefined>;

  /**
   * Serialized write — the only write path. fn sees the current credential
   * because correct writes (refresh, login-during-refresh) depend on it;
   * return the new credential, or undefined to leave the entry unchanged.
   * Mutual exclusion per provider id, cross-process too where the backing
   * store supports it (file lock). Resolves with the post-write credential.
   */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;

  /** Remove (logout). Serialized against modify. */
  delete(providerId: string): Promise<void>;
}
```

这里刻意不提供 `set`：未串行化的写入路径会引发读-改-写竞争（刷新期间登录覆盖新凭据、令牌重复刷新）。调用方应使用：

```ts
await store.modify(pid, async () => credential);      // login: store this
await store.read(pid);                                // status UI ("logged in via OAuth")
await store.delete(pid);                               // logout
// refresh RMW happens inside Models.getAuth
```

错误语义：缺少条目时 `read` 返回 `undefined`；方法仅在存储失败时拒绝，`Models` 会将此类拒绝包装为错误码为 `"auth"` 的 `ModelsError`。提供内存视图并在内部记录持久化错误的尽力而为存储（当前 AuthStorage 行为）也是有效实现。

### 解析策略（固定）

`Models.getAuth(model)` is a decision tree, not a loop. A stored credential owns the provider — ambient/env is consulted only when nothing is stored (AuthStorage parity: no silent env fallback after a failed refresh or for an unmatched credential type):

```ts
const stored = await store.read(provider.id);
if (stored) {
  if (stored.type === "oauth" && provider.auth.oauth) {
    const oauth = provider.auth.oauth;
    let credential = stored;
    if (Date.now() >= credential.expires) {                 // optimistic check, lock-free
      const post = await store.modify(provider.id, async (current) => {
        if (current?.type !== "oauth") return undefined;    // logged out meanwhile
        return Date.now() >= current.expires                // authoritative check, under lock
          ? oauth.refresh(current)                          // throws -> ModelsError("oauth")
          : undefined;                                      // another process/request refreshed
      });
      if (post?.type !== "oauth") return undefined;
      credential = post;
    }
    return { auth: await oauth.toAuth(credential), source: "OAuth" };
  }
  if (stored.type === "api_key" && provider.auth.apiKey) {
    return provider.auth.apiKey.resolve({ model, ctx, credential: stored });
  }
  return undefined; // stored credential without matching handler blocks ambient
}
return provider.auth.apiKey?.resolve({ model, ctx, credential: undefined }); // ambient
```

属性：

- Double-checked locking, same as today's `refreshOAuthTokenWithLock`: valid tokens cost one `read` and zero locks; expired tokens lock, re-check under the lock, refresh once globally, persist before release.
- Explicit request auth (stream options `apiKey`/`headers`) is merged per-field on top in `stream()`, winning over everything.
- Refresh failure rejects with `ModelsError("oauth")`; the stored credential is untouched (preserved for retry). Request paths surface this as a stream error with the real cause ("run /login"); status/availability UIs catch the rejection and render "needs re-login" — documented contract on `getAuth`.

### 替换 AuthStorage

coding-agent 的最终状态是删除 AuthStorage，其能力映射到 `CredentialStore` 实现及组合层。

当前 `getApiKey` 的优先级及迁移位置：

| AuthStorage today | New design |
|---|---|
| runtime override (CLI `--api-key`) | `withRuntimeOverrides(store, overrides)` decorator: `read` returns the override as an `ApiKeyCredential`; never persisted |
| stored `api_key` (with `$ENV`/`!command` via `resolveConfigValue`) | stored `ApiKeyCredential`; config-value resolution happens at `read` in coding-agent's adapter/decorator (command execution stays app policy) |
| stored `oauth` + locked refresh, undefined on failure | `getAuth` decision tree above; failure rejects with cause instead of silently unconfiguring |
| env var (only when nothing stored) | ambient branch of `apiKey.resolve` |
| `fallbackResolver` (models.json custom providers) | gone — custom providers carry their own `auth.apiKey` |

```txt
FileCredentialStore        ports AuthStorage's lock backend: read = memory snapshot,
                           modify = withLockAsync(re-read, fn, merge-write), delete,
                           internal error recording (drainErrors equivalent)
└─ withConfigValues        $ENV / !command at read
   └─ withRuntimeOverrides --api-key
      └─ createModels({ credentials: store })

login/logout UI            provider.auth.{oauth,apiKey}.login(interaction) + store.modify/delete
status UI                  store.read(pid) + getAuth try/catch ("needs /login" on rejection)
getOAuthProviders          presence of provider.auth.oauth across registered providers
```

### 登录回调

同一个接口同时服务 API key 和 OAuth 登录：

```ts
export interface AuthInteraction {
  /** Aborts the whole login flow. Per-prompt cancellation uses AuthPrompt.signal. */
  signal?: AbortSignal;

  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

/** `signal` lets the flow cancel a pending prompt when an out-of-band event resolves the step. */
export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
  | { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };
```

`prompt()` returns the entered/selected string (`select` returns the option id). Flows race a `manual_code` prompt against a callback server by setting `AuthPrompt.signal` and aborting the prompt when the callback wins.

### OAuth 挂载

支持 OAuth 的提供商始终挂载 OAuth。工厂没有开关：流程按需加载，在实际调用 `login()`/`refresh()` 之前不会产生开销；从不登录的宿主也永远不会加载它。

```ts
export function anthropicProvider(): Provider {
  return createProvider({
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    auth: {
      apiKey: envApiKeyAuth("Anthropic API key", ["ANTHROPIC_API_KEY"]),
      oauth: lazyOAuth({
        name: "Anthropic (Claude Pro/Max)",
        load: () => import("../auth/oauth/anthropic.ts").then((m) => m.anthropicOAuth),
      }),
    },
    models: ANTHROPIC_MODELS,
    api: anthropicMessagesApi(),
  });
}
```

`lazyOAuth()` wraps a dynamically imported `OAuthAuth` so provider definitions can advertise OAuth without importing the implementation (`toAuth` is async for exactly this reason):

```ts
export function lazyOAuth(input: {
  name: string;
  load: () => Promise<OAuthAuth>;
}): OAuthAuth;
```

OAuth 不能将 Node 专用代码（`node:http`、`node:crypto`）带入浏览器包：`lazyOAuth()` 内的动态导入使用与 Bedrock 惰性包装器相同的打包器不透明变量说明符技巧。浏览器宿主不会触发加载（没有存储的 Node OAuth 凭据，也没有登录流程）。若将来加入 Web OAuth（sitegeist 已证明 Web Crypto PKCE、认证标签页、fetch 令牌交换和设备码轮询可行），它只需另一种 `OAuthAuth` 实现，无需保留特殊选项值。

`src/auth/oauth/` 中的内置流程直接实现 `OAuthAuth` 和 `AuthInteraction`，仍以 Node 为目标并按需加载。Copilot 通过 `toAuth().baseUrl` 推导特定凭据的请求端点。

## 提供商包装器与 models.json

`models.json` is a provider wrapper layer. It does not mutate providers in place:

```ts
function withProviderOverrides(base: Provider, overrides: ProviderOverrides): Provider {
  return {
    ...base,
    name: overrides.name ?? base.name,
    baseUrl: overrides.baseUrl ?? base.baseUrl,
    headers: mergeHeaders(base.headers, overrides.headers),

    getModels: () => applyModelOverrides(base.getModels(), overrides.models),
    refreshModels: base.refreshModels?.bind(base),

    stream: base.stream,
    streamSimple: base.streamSimple,
  };
}
```

这种方式可与动态提供商组合，因为 `getModels()` 委托给基础来源，`refreshModels()` 直接透传。

models.json 中的请求认证配置（`$ENV`、`!command`、内联密钥）仍由应用作为旁车状态管理，可作为显式请求认证提供，或由应用设置到包装提供商 `auth.apiKey` 上的自定义 `ApiKeyAuth`。

## 自定义提供商：createProvider()

一个辅助函数即可从各部分构建提供商，同时处理单 API 和混合 API 提供商：

```ts
export function createProvider(input: {
  id: string;
  name?: string;                 // default: id
  baseUrl?: string;
  headers?: Record<string, string>;
  auth: ProviderAuth;            // required, at least one of apiKey/oauth (no "no-auth" providers)
  /** Initial model list (empty for purely dynamic providers). */
  models: readonly Model<Api>[];
  /** Dynamic providers: fetch the current list; createProvider stores it and dedupes in-flight calls. */
  refreshModels?: () => Promise<readonly Model<Api>[]>;
  /** Single implementation, or map keyed by model.api for mixed-API providers. */
  api: ProviderStreams | Record<string, ProviderStreams>;
}): Provider;
```

- Single `api`: all models stream through it.
- Map `api`: `stream()`/`streamSimple()` dispatch on `model.api`; unknown api produces a stream error.

必须支持混合 API 的自定义提供商（opencode Go/Zen 风格提供商会在同一个 provider id 下暴露由不同 API 支持的模型）。

内置提供商工厂内部使用 `createProvider()`；models.json 自定义提供商直接映射到它：

```json
{
  "providers": {
    "my-openai-proxy": {
      "api": "openai-completions",
      "baseUrl": "https://proxy.example/v1",
      "models": [ ... ]
    }
  }
}
```

## Compat 入口

`@earendil-works/pi-ai/compat` preserves the old global API surface until the coding-agent migration deletes it. New code never imports it.

保留的旧语义：对于自定义提供商、被修改的模型以及覆盖内置 API 实现的测试/扩展，全局 `stream()` 仍可通过旧 api-registry 按 `model.api` 分发。

- `stream/complete/streamSimple/completeSimple(model, ctx, opts)`: real built-in provider/model/api matches route through a singleton `builtinModels()` collection, so provider auth/env/baseUrl behavior is shared with the new runtime. Unknown providers, mutated models, or overridden API registrations fall back to api-registry dispatch plus `getEnvApiKey` injection.
- The builtin api registration side effect moves from the root barrel into compat. It skips api ids that already have a registration, since compat may load after a test or extension has already registered an override. `registerApiProvider()/unregisterApiProviders()` keep feeding the compat-local registry; `resetApiProviders()` clears and re-registers builtins.
- Sync `getModel/getModels/getProviders` are deprecated aliases of `getBuiltinModel/getBuiltinModels/getBuiltinProviders` from `providers/all` (they were always pure generated-catalog reads — verified: nothing ever mutated the old `modelRegistry`).
- Re-exports the per-API lazy stream wrappers (incl. `setBedrockProviderModule`), `env-api-keys.ts`, and the image-generation registry/catalogs; none of these stay on the root barrel.
- `export * from "./index.ts"`: compat is a strict superset of the core entrypoint, so consumers switch a file's import path wholesale without symbol surgery.

coding-agent (and the interim agent package) switch imports of these symbols from `@earendil-works/pi-ai` to `@earendil-works/pi-ai/compat` (import-path-only change) and are otherwise untouched until the ModelManager migration.

扩展兼容期内，coding-agent 扩展加载器（jiti 别名与 Bun `virtualModules`）会将 `@earendil-works/pi-ai` 根说明符解析到 compat 入口。现有使用旧全局 API（`complete`、`getModel`、`registerApiProvider` 等）的扩展无需修改即可运行；只有在 ModelManager 迁移中删除 compat 时才会失效，届时变更日志会提供迁移指南。类型检查会提示迁移：编辑器将根入口解析为精简核心类型，因此需要通过 `/compat` 导入旧全局 API，仓库示例扩展即如此。

## 内置静态辅助函数

类型化、同步且仅基于生成目录的辅助函数与目录放在一起（从 `providers/all` 导出）：

```ts
getBuiltinModel(provider, id)   // sync, typed overloads from generated catalog
getBuiltinModels(provider)      // sync
getBuiltinProviders()           // sync
```

通过 `Models` 实例进行的运行时查找基于已知提供商列表同步完成：`models.getModel(...)`。对新鲜度敏感的调用方先执行 `await models.refresh(provider)`。

Generated catalogs are split per provider (`providers/<id>.models.ts`) by updating `packages/ai/scripts/generate-models.ts`. If the generator change turns out too large for this pass, splitting may be deferred; `providers/all` and provider factories may temporarily import the monolithic `models.generated.ts`, relying on `sideEffects: false` for pruning.

## Tree-shaking 与惰性导入

规则：

1. Main `@earendil-works/pi-ai` import is core-only.
2. Provider modules import their catalog, auth helpers, and lazy API wrappers only.
3. Lazy API wrappers dynamically import real API implementations.
4. Real API implementations import SDK dependencies.
5. OAuth implementations are always attached via `lazyOAuth()` and lazy-loaded behind a bundler-opaque dynamic import; provider metadata never eagerly imports Node-only OAuth code.
6. `providers/all` imports every built-in provider factory and all catalogs. It is the explicit heavy entrypoint.
7. Provider modules are side-effect-free; importing a provider does not register anything globally.
8. `package.json` lists only effectful compat/image registration files in `sideEffects`; root and provider modules stay tree-shakeable.
9. With code splitting, provider SDKs stay in lazy chunks. Without code splitting, bundlers fold statically reachable lazy API implementations into the single bundle; `providers/all` then pulls all statically visible SDKs. Bedrock is the exception because its AWS SDK implementation is behind a bundler-opaque Node-only import and needs `setBedrockProviderModule()` for standalone single-file bundles.

Exports map sketch:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./compat": "./dist/compat.js",
    "./providers/all": "./dist/providers/all.js",
    "./providers/openai": "./dist/providers/openai.js",
    "./providers/anthropic": "./dist/providers/anthropic.js",
    "./providers/*": "./dist/providers/*.js",
    "./api/*": "./dist/api/*.js"
  }
}
```

浏览器冒烟检查（`scripts/check-browser-smoke.mjs`）必须持续通过：打包核心入口（以及任何非 Node 提供商入口）不能引入 `node:http`/`node:crypto`。

## AgentHarness 集成

`AgentHarness` receives a `Models` instance.

- `AgentHarnessOptions.models` is required.
- The harness does not snapshot `Models` into turn state.
- Request path calls `this.models.streamSimple(model, context, options)`; same for compaction/branch-summarization paths.
- Request path never calls async `models.getModel()` to canonicalize; if model metadata needs refresh, the app updates the selected model before starting a turn.
- Harness tests build `createModels()` and install the faux provider (`fauxProvider()` factory from `providers/faux`).

## coding-agent 下一阶段（不在本阶段）

coding-agent builds providers in layers and binds them per session:

```txt
built-in providers (builtinModels)
-> models.json provider wrappers / custom providers (createProvider)
-> extension provider wrappers/additions
```

```ts
sessionModels.clearProviders();
for (const provider of layeredProviders) sessionModels.setProvider(provider);
```

coding-agent owns: `FileCredentialStore` + decorators replacing AuthStorage (see "Replacing AuthStorage"), models.json auth sidecar (`$ENV`, `!command`), command execution policy, provider status labels (from `AuthResult.source`), login/logout UI (driving `auth.{apiKey,oauth}.login()` with `prompt()/notify()`), extension lifecycle, provider-management slash commands.

当前过渡状态：

- `AgentHarness` already accepts a `Models` instance and uses it for turn streaming, compaction, and branch summaries.
- coding-agent does not use `AgentHarness` yet; `AgentSession` still drives the low-level `Agent` with a `streamFn`.
- coding-agent still uses legacy `AuthStorage` + `ModelRegistry` and imports old global pi-ai APIs through `@earendil-works/pi-ai/compat`.
- The extension loader still aliases the pi-ai root to `/compat` as the runtime grace period for old extensions.

## 实现待办

功能落地后勾选对应项。请保持列表最新，它是后续会话继续工作时的依据。

### 阶段 1——核心类型/运行时

- [x] Rename `types.ts` `Provider` alias to `ProviderId`; fix call sites.
- [x] Add `ApiOptionsMap` and `ApiStreamOptions<TApi>` to `types.ts` (type-only imports).
- [x] New `models.ts`: `Provider<TApi>` interface, `hasApi()` guard, `ModelsError` + codes. Auth types live in `src/auth/types.ts` (`ProviderAuth` = `{ apiKey?, oauth? }`, credentials, `CredentialStore` (`read`/`modify`/`delete`, one credential per provider), `AuthResult`, `AuthContext`, `ModelAuth`, login callbacks), in-memory store in `src/auth/credential-store.ts`, default context in `src/auth/context.ts` (browser-safe node:fs trick), `lazyStream()` in `src/api/lazy.ts`.
- [x] `Models`/`MutableModels`/`createModels({ credentials?, authContext? })` with provider map, sync `getModel(s)` (per-provider failure isolation), explicit async `refresh(provider?)`, `getAuth` (decision tree, double-checked locked refresh), `stream/complete/streamSimple/completeSimple` with per-field auth merge. Tests: `packages/ai/test/models-runtime.test.ts`.
- [x] Keep metadata helpers: `calculateCost`, `getSupportedThinkingLevels`, `clampThinkingLevel`, `modelsAreEqual`.

### 阶段 2——`src/api/`

- [x] Move stream implementations from `src/providers/` to `src/api/`, renamed by API id (`anthropic.ts` -> `api/anthropic-messages.ts`, etc.).
- [x] Normalize each implementation module to export exactly `stream` and `streamSimple`.
- [x] Move shared helpers (`openai-responses-shared`, `google-shared`, `transform-messages`, `openai-prompt-cache`, `github-copilot-headers`, `cloudflare`, `simple-options`) to `src/api/`.
- [x] Extract `lazyStream()`/`lazyApi()` into `src/api/lazy.ts`.
- [x] Add `*.lazy.ts` wrappers per API; bedrock keeps node-only import trick and `setBedrockProviderModule()`.
- [x] Delete `providers/register-builtins.ts`. Interim until Phase 5 compat: builtin api-registry registration lives in `stream.ts`; lazy API wrappers are exported from the root barrel.

### 阶段 3——提供商工厂与目录

- [x] Auth helpers in `src/auth/helpers.ts`: `envApiKeyAuth()` (with secret-prompt `login`), `lazyOAuth()`. OAuth flow loads go through `auth/oauth/load.ts` (bundler-opaque dynamic import); the `OAuthAuth` exports it references land in Phase 4.
- [x] `createProvider()` in `models.ts` (single + mixed `api` map, dispatch on `model.api`, unknown api -> stream error).
- [x] Per-provider factories under `src/providers/` for all built-in catalog providers; OAuth attached via `lazyOAuth()` (anthropic, openai-codex, github-copilot); ambient `ApiKeyAuth` for amazon-bedrock (AWS env/profile) and google-vertex (key or ADC+project+location).
- [x] `providers/all.ts`: `builtinProviders()`, `builtinModels()`, `getBuiltinModel/getBuiltinModels/getBuiltinProviders` re-exports.
- [x] Faux provider factory (`fauxProvider()` in `providers/faux.ts`) for tests; legacy `registerFauxProvider()` kept until compat dies.
- [x] Split generated catalogs per provider via `scripts/generate-models.ts` (`providers/<id>.models.ts`); `models.generated.ts` becomes a generated aggregator.

### 阶段 4——OAuth 适配

- [x] Built-in implementations live under `auth/oauth/` and implement `OAuthAuth` directly through `AuthInteraction.prompt()`/`notify()`. They are private provider implementations loaded lazily by provider factories.
- [x] Callback-server flows race a `manual_code` prompt, aborted through `AuthPrompt.signal` once the flow settles. The public `oauth` subpath retains only coding-agent extension compatibility types.

### 阶段 5——打包

- [x] `index.ts` core-only and side-effect free (no catalogs, no provider factories, no api-registry, no env-api-keys, no images, no OAuth, no compat). Typed catalog reads (`getBuiltin*`) implemented in `providers/all.ts`; `models.ts` no longer imports `models.generated.ts`.
- [x] `compat.ts`: superset of index + old api-dispatch globals, deprecated `getModel/getModels/getProviders` aliases, lazy api wrappers + `setBedrockProviderModule`, `getEnvApiKey`, images. Registration side effect lives here (skip-if-present).
- [x] Subpath exports map (`./compat`, `./providers/*`, `./api/*`); `sideEffects` array listing the effectful modules (`compat`, images registration) instead of `false`.
- [x] Browser smoke (entry now imports old globals from `/compat`) + shrinkwrap checks green. Internal old-global imports switched to `/compat` already (42 files in agent/coding-agent/examples; vitest configs alias `/compat` to src; spawn-CLI tests resolve workspace dist, so `packages/ai` + `packages/agent` dists were rebuilt).

### 阶段 6——AgentHarness

- [x] `AgentHarnessOptions.models` required (`readonly models` on the harness); the harness stream path uses `models.streamSimple()`. `StreamFn` redefined structurally (no compat type dependency); `Models.streamSimple` satisfies it.
- [x] Compaction/branch-summarization take the harness `Models` instance. `getApiKeyAndHeaders` is removed entirely — `Models` is the only auth path; per-request key resolution becomes provider auth on the collection. `compact()`/`generateSummary()`/`generateBranchSummary()` lose their explicit `apiKey`/`headers` parameters.
- [x] Harness tests use `createModels()` + `fauxProvider()` with unique per-fake provider ids; no global api-registry state, no unregister bookkeeping.

### 阶段 7——coding-agent 桥接（最小实现）

- [x] Switch old-global imports to `@earendil-works/pi-ai/compat` (landed with Phase 5; compat is a superset so the switch was path-only). Extension loader resolves the pi-ai root to compat as the runtime grace period.
- [x] Everything else originally sketched here is gated on coding-agent actually streaming through a `Models` instance — coding-agent's `AgentSession` drives the low-level `Agent` via `streamFn`, not the harness — and moved to Phase 9.

### 阶段 8——收尾

- [x] Update/add tests; run affected suites (tests landed with each phase; `./test.sh` green throughout).
- [x] `packages/ai/CHANGELOG.md`: `### Breaking Changes` with migration guide (compat entrypoint, `Provider` -> `ProviderId`, api module moves) + `### Added` for the new Models/provider/auth API.
- [x] `packages/coding-agent/CHANGELOG.md`: `### Changed` entry for extension authors — runtime unaffected (loader resolves the pi-ai root to compat), typecheck nudges to `/compat` or the new API; removal happens later with a migration guide.
- [x] `packages/agent/CHANGELOG.md`: `### Breaking Changes` for required `AgentHarnessOptions.models`, compaction signature changes, structural `StreamFn`.
- [x] `npm run check` clean.

### 阶段 9——coding-agent 使用 Models 与 CredentialStore（范围内）

coding-agent replaces AuthStorage and ModelRegistry's internals with `FileCredentialStore` + a `MutableModels` collection. AgentSession itself stays (AgentHarness adoption is pi 2.0); only its model/auth substrate swaps. Layering is strictly one-directional:

```txt
FileCredentialStore（auth.json、加锁、$ENV/!command 解析）+ 显式 --api-key 覆盖
        ↑
MutableModels：内置工厂（按 models.json 配置包装）+ 自定义提供商（models.json ∪ 扩展）
        ↑
ModelRegistry：兼容 facade——同步已知列表读取委托给集合；为扩展和 UI 提供 registerProvider/login/logout/status
        ↑
AgentSession / SDK / interactive-mode（通过 models 流式调用；仅在认证/刷新路径使用 await）
```

Decisions:

- `AuthStorage` is deleted as a type — it would otherwise depend on provider auth while provider auth depends on its store (circular). Its surface splits: `get`/`set`/`remove` -> `CredentialStore`; `getApiKey` -> `Models.getAuth`; `login`/`logout`/`getAuthStatus` -> ModelRegistry facade methods over `provider.auth.oauth` + the store.
- `FileCredentialStore` is self-contained (path, locking, parse/write, chmod, error buffering) and owns `auth.json` semantics, including `$ENV`/`!command` resolution for stored API-key credentials. Persisted values stay raw; resolution returns copies for auth use.
- Runtime `--api-key` overrides are an explicit store overlay (an override reads as an ephemeral stored api-key credential, masking stored OAuth — matches today's priority). Every registered provider is guaranteed an `apiKey` auth slot so overrides apply to OAuth-only providers too.
- `ModelRegistry.getAll`/`find`/`getAvailable` stay sync for SDK and extension compatibility, delegating to the collection's last-known sync model lists and fast configured-looking status checks. Dynamic providers update through explicit async `refresh()`, and request auth remains async through `getApiKeyAndHeaders()`/`Models.getAuth()`. Extensions also get the collection itself as the forward API.
- models.json keeps FULL feature parity, implemented as provider decoration: builtin factories wrapped so `getModels()` applies provider `baseUrl`/`compat` overlays, `modelOverrides`, and custom-model merges (async-safe); provider `apiKey`/`headers`/`authHeader` configs become that provider's `ApiKeyAuth` (config first, factory auth fallback); parse errors keep `getError()` semantics.
- Extension `ProviderConfig` parity: provider-keyed `streamSimple`, legacy extension OAuth callbacks adapted to `OAuthAuth`, and full model replacement per provider. Legacy `registerApiProvider` writes stay compat-local for consumers that call global `complete()`; they die with compat.
- Copilot: stored-credential baseUrl applied in the wrapped `getModels()` (extension-visible models stay correct) plus per-request `toAuth().baseUrl`.
- Cloudflare: provider-auth substitution (key + `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_GATEWAY_ID` from credential `env` or ambient `AuthContext.env()` -> `ModelAuth.baseUrl`). Built-in compat calls route through `Models`, so they use the same provider auth path.

Ordering for new sessions:

1. [x] pi-ai rework first: `Provider.getModels()` sync + optional `refreshModels()`; `Models.getModels`/`getModel` sync, `Models.refresh(provider?)` async; `createProvider` takes `models` array + optional `refreshModels` fetcher (in-flight dedupe). Reverses Phase 1's async-listing decision — see "Provider model listing" for rationale (sync-or-async unions breed latent sync assumptions; async-only breaks sync consumer surfaces like extension `find`/`getAll`).
2. [x] Cloudflare provider auth in pi-ai factories: Workers AI and AI Gateway validate their required account/gateway env/config and return resolved `baseUrl`, provider-scoped env, and header suppression/override metadata from provider auth.
3. [ ] Add `FileCredentialStore` in coding-agent.
   - Implement the pi-ai `CredentialStore` interface as a self-contained `auth.json` store; do not depend on the old `AuthStorageBackend` abstraction, though its lock/retry semantics may be ported.
   - Preserve the existing file format. `ApiKeyCredential` uses `{ type: "api_key", key?, env? }`, matching today's `auth.json`; do not translate `env` into metadata or rewrite discriminators.
   - Resolve `$ENV`/`!command` in stored API-key `key` and `env` values out of the box using an injected execution/config environment. `$ENV` lookup should come from that environment, and `!command` should run through the shared shell execution path rather than direct `execSync`.
   - Persist raw config values; resolved credentials returned for auth use must be copies and must not rewrite `$ENV`/`!command` strings unless a caller explicitly stores new values.
   - `read(provider)` returns the current credential snapshot and records parse/storage errors for status UI parity.
   - `modify(provider, fn)` must lock, re-read, run `fn`, merge-write the provider entry, chmod `0600`, and return the post-write credential.
   - `delete(provider)` must lock and remove only that provider's entry.
   - Add file-backed and in-memory tests covering lock/RMW behavior, `api_key` reads with config-value resolution, OAuth reads, provider `env` preservation, delete, parse errors, and concurrent refresh-style modifications.
4. [ ] Add runtime override overlay for coding-agent policy.
   - `withRuntimeOverrides(store, overrides)` implements CLI `--api-key`: read returns an ephemeral `{ type: "api_key", key }` for each overridden provider, masking stored OAuth/API credentials without persisting.
   - Runtime overrides must apply even to OAuth-capable providers; every provider registered in coding-agent must retain or gain an `apiKey` auth slot so the overlay is meaningful.
   - Tests cover precedence: runtime override > stored credential > models.json config auth > ambient provider env, with stored credential blocking ambient fallback.
5. [ ] Build provider decoration helpers for `models.json`.
   - Start from built-in provider factories, not generated model arrays.
   - Wrap provider `getModels()` so provider-level `baseUrl`/`headers`/`compat`, per-model `modelOverrides`, and custom model merges apply on every sync read.
   - Preserve `refreshModels()` passthrough so dynamic providers compose with decorations.
   - Convert provider `apiKey`/`headers`/`authHeader` models.json config into a wrapped `ApiKeyAuth` that resolves config values first and falls back to the base provider auth.
   - Custom providers with `models` use `createProvider()` with the appropriate lazy API wrapper or extension-provided stream implementation.
   - Parse errors must keep current `ModelRegistry.getError()` behavior: built-ins remain available, and the error is visible.
6. [ ] Copilot `getModels()` baseUrl wrap.
   - GitHub Copilot OAuth `toAuth()` already returns per-credential request `baseUrl` for streaming.
   - Wrap Copilot's provider `getModels()` when an OAuth credential is present so extension/UI-visible model metadata also carries the authenticated account base URL.
   - Keep API-key/env-token Copilot behavior unchanged.
   - Add tests for model metadata before login, after OAuth credential, after refresh/baseUrl change, and logout.
7. [x] Extension OAuth adapter.
   - Keep only the legacy callback/credential declarations required by coding-agent `ProviderConfig.oauth`.
   - `login` maps legacy callbacks/events to `AuthInteraction.prompt()`/`notify()`.
   - `refreshToken` maps to `refresh`; `getApiKey` maps to `toAuth`.
   - Preserve the type-only pi-ai `oauth` barrel and extension-loader aliases.
8. [ ] Rebuild coding-agent `ModelRegistry` over `MutableModels`.
   - It owns a `MutableModels` instance built from decorated built-ins + models.json custom providers + extension providers.
   - `getAll()`, `find()`, and `getAvailable()` remain sync compatibility methods over last-known model lists and fast configured-looking auth status. Do not break the extension-facing `modelRegistry` surface for these reads.
   - `refresh()` is the explicit async freshness boundary: rebuild provider layers and call `models.refresh()` where needed; no global api-registry reset should be part of the new path except compat-only grace behavior.
   - `registerProvider()`/`unregisterProvider()` mutate provider layers and rebuild the collection.
   - Facade auth ops (`login`, `logout`, provider status, available OAuth providers) drive `provider.auth.{apiKey,oauth}` and the `CredentialStore`; no `AuthStorage` type remains.
   - Legacy `registerApiProvider` writes stay only for `/compat` callers and are removed in Phase 10.
9. [ ] Rewire consumers.
   - `AgentSession` stream function resolves through `ModelRegistry`/`Models`, not `getApiKeyAndHeaders()` + compat globals.
   - SDK options replace `authStorage` with `credentials?: CredentialStore` or an agent-dir-backed default; update `sdk.md` and examples.
   - `model-resolver`, `--list-models`, model selector, login/logout/status UI, and provider attribution use sync last-known model reads and await only explicit refresh/auth operations.
   - CLI `--api-key` populates the runtime override decorator instead of mutating `AuthStorage`.
   - Keep extension loader root-to-compat alias until Phase 10, but expose the new collection/facade as the forward API.
10. [ ] Test migration and real-provider validation.
    - Unit tests for `FileCredentialStore`, runtime override overlay, provider decoration, extension OAuth adapter, Models-backed ModelRegistry facade, and consumer rewiring.
    - Regression tests for Cloudflare account/gateway env, Copilot OAuth baseUrl wrapping, runtime `--api-key` precedence, `$ENV`/`!command` resolution, and stored credential blocking ambient fallback.
    - Update existing tests for sync last-known `ModelRegistry.getAll/find/getAvailable` plus explicit async refresh behavior.
    - Run targeted non-e2e suites plus tmux validation of login flows against real providers (Anthropic OAuth/API key, OpenAI Codex OAuth, GitHub Copilot OAuth, Cloudflare AI Gateway, Bedrock if credentials are available).

### 阶段 10——删除 compat（pi 2.0 时代，单独进行）

- [ ] AgentSession -> AgentHarness; the registry facade dies in favor of harness `Models`.
- [ ] Move ALL internal `/compat` imports to the new API: every package's src, all tests, and the example extensions (examples then demonstrate the new API). Nothing inside the repo may import `/compat` at that point.
- [ ] Delete `/compat`, `env-api-keys.ts`, the extension-loader root-to-compat alias, and the compat-local legacy API registry. The old OAuth registry/provider interface is already gone; the type-only `oauth` barrel remains for extension compatibility.

### 延后事项/后续工作

- [ ] Web OAuth implementations (sitegeist-style) as an alternative `OAuthAuth`.
- [x] Images API redesign: `ImagesModels`/`ImagesProvider`/`createImagesProvider` mirror the chat-side design (sync reads, explicit refresh, never-reject generation); auth resolution shared with the chat side via the free-standing `resolveProviderAuth()` in `auth/resolve.ts` (which also owns `ModelsError`; both collections pass their store/context as arguments — no resolver object). `openrouterImagesProvider()` factory + `builtinImagesProviders()`/`builtinImagesModels()` in `providers/all`; impl moved to `api/openrouter-images.ts` with a lazy wrapper. The old global image API (registry + `getImageModel*` + `generateImages`) stays on compat; `ImagesProvider` id alias in types.ts renamed to `ImagesProviderId` (mirror of `Provider` -> `ProviderId`).

## 错误行为

`undefined` means not found or not configured. Real failures reject or become stream errors.

```ts
export type ModelsErrorCode =
  | "model_source"      // provider model refresh failed
  | "model_validation"  // model object invalid
  | "provider"          // unknown provider, dispatch failure
  | "stream"            // stream setup failure
  | "auth"              // auth resolution failure
  | "oauth";            // oauth login/refresh failure
```

- `Models.stream()` produces stream errors (error event + error result) for async setup failures; it does not throw after returning the stream.
- `Models.getModels()` is a sync best-effort read: a provider whose `getModels()` throws yields no models. `Models.refresh(provider)` rejects on that provider's fetch failure; `Models.refresh()` (all providers) is concurrent best-effort. Apps that need a concrete listing failure refresh the single provider.
- Auth resolution and credential store failures reject loudly (`ModelsError` codes `auth`/`oauth`); silent fallback to a different auth path after a failure risks billing surprises. A stored credential always blocks ambient/env fallback, including after a failed refresh.
- Status/availability UIs catch `getAuth` rejections and render "needs re-login"; they do not treat rejection as "unconfigured".
