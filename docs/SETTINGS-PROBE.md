# SETTINGS-PROBE — 本机 DSH 0.2.2-rc.1 的「插件设置页 / 持久化配置」官方 API 静态取证

调查对象：本机安装的 DeepSeek Harness 桌面版。
方法：只读静态读文件（解包 `app.asar` 后读 `lib/*.js` 与 README），未启动 DSH 进程，未改动 `~/.dsh`。
取证时间：2026-11-21。

> 说明：下文所有 `文件:行` 指 **asar 内部路径**。安装根为 `D:/app/DeepSeek Harness/resources/app.asar`，
> 因此 `dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js:330` 的实际读取路径是
> `D:/app/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js`
> 内的第 330 行（该文件只能经 asar 读取，文件系统上不存在独立文件）。

---

## 0. 结论速览

| 问题 | 结论 | 证据强度 |
|---|---|---|
| (a) 插件能否在 cordis 里声明 Config / settings schema | **能**。插件模块导出 `Config`（或 Service 类的 `static Config`），必须是 `@deepseek-ai/schemastery` 的 Schema，且字段要 `.volatile()` 才会进入设置表单 | 强（host 代码 + 多个官方包实例） |
| (b) 是否有 `ctx.settings` 服务及其签名 | **有**。服务名 `settings`（`SettingsForms`），方法 `configure / prepareDocument / describe / update / replace / mutate` | 强（类定义 + 官方 API catalog 签名） |
| (c) 官方 Web 设置界面是否自动渲染插件声明的 schema | **否**。桌面 Web 客户端**没有任何**从 schema 自动生成页面的实现；官方页面全部是各插件手写的 client 组件。协议里保留了 `autoGenerate` 开关，但「no shipped client does so yet」 | 强（README 明文 + 全量 grep 结果） |
| 持久化落到哪里 | 写进**当前 profile 的 Cordis patch**（配置编辑器 `configEditor` 负责落盘、校验、原子替换），不是独立的 settings 文件 | 强（dsh-config-editor README） |

**对第三方插件（如 dsh-AIkb）的直接含义**：官方不会替你渲染设置表单。
要让用户能改配置，必须 (1) 在 host 侧导出带 `.volatile()` 的 `Config`，让条目出现在 `settings.describe()` 里；
(2) **自己写一份 web client 模块**，注册到 `settings.section` / `settings.general.item` / `plugins.row.config` 之一，并自己画输入框；
(3) 读写通过 client 侧 `ctx.configForms`（内部走 `settings.describe/update/replace/mutate`）。

---

## 1. 安装位置与版本

- 桌面应用根：`D:/app/DeepSeek Harness/`（Electron）。`resources/` 下只有 `app.asar`（单文件归档），**没有** `app.asar.unpacked`。
- 任务里给的候选路径全部不存在：`D:/JingYu/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh`、`C:/Users/Admin/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh`、`C:/Users/JingYu/.dsh/...`。
  `C:/Users/Admin/.dsh` 里只有 `ops-spill-ledger.jsonl`、`sw-cad.json` 两个文件，没有 `profiles/`。
- asar 内没有独立的 `@deepseek-ai/dsh` 包：dsh 本体是归档内的 `dsh/` 目录（21047 个文件）。

版本号（`app.asar/dsh/package.json:1-5`）：

```json
{
  "name": "@deepseek-ai/dsh-desktop-runtime",
  "private": true,
  "version": "0.2.2-rc.1",
  "type": "module",
```

依赖里所有 `@deepseek-ai/*` 包（含 `@deepseek-ai/dsh` 本体）版本均为 `0.2.2-rc.1`。
设置相关的包确实被打进安装包：

```text
dsh/node_modules/@deepseek-ai/dsh-settings                      ← 设置服务（表单投影）
dsh/node_modules/@deepseek-ai/dsh-config-editor                 ← 读写 profile patch 的持久化层
dsh/node_modules/@deepseek-ai/dsh-api-settings-controller       ← 设置 domain 的 Remote(HTTP) 控制器
dsh/node_modules/@deepseek-ai/dsh-client-ui-settings            ← 客户端设置域基座（configForms / 槽位类型）
dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general    ← 设置外壳 + General 页
dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins    ← Settings 里的「内置插件」只读清单
dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-{account,models,agent-loop,subagent,web-search,session-log,shell,plugin-inventory}
dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager       ← 侧栏 Plugins 页（插件配置页都挂这里）
```

---

## 2. (b) `ctx.settings` 服务与签名

### 2.1 服务本体

`dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js:322-330`（原文）：

```js
var SettingsForms = class extends Service {
	ownerContext;
	static inject = ["configEditor", "profileContext"];
	revisions = /* @__PURE__ */ new Map();
	closed = false;
	scheduled = false;
	presentations = /* @__PURE__ */ new Map();
	constructor(ownerContext) {
		super(ownerContext, "settings");
```

即服务名是 **`settings`**（`ctx.settings`），依赖 `configEditor` 与 `profileContext`。

### 2.2 方法签名（源码 + 官方 API catalog 的规范化签名）

官方 API catalog 把该服务登记为 `key: 'settings'`（`dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3224-3262`），
给出的签名如下（原文）：

```ts
configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void
prepareDocument(): Promise<string>
describe(options?: SettingsDescribeOptions): SettingsDescriptor[]
async update(ns: string, patch: object, expectedRevision?: number): Promise<void>
async replace(ns: string, section: object, expectedRevision?: number): Promise<void>
async mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
```

对应源码位置（`dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js`）：

| 行 | 原文 |
|---|---|
| 370 | `configure(presentation, owner = this.ctx.fiber) {` |
| 406 | `prepareDocument() {` |
| 413 | `describe(options) {` |
| 470 | `async update(ns, patch, expectedRevision) {` |
| 479 | `async replace(ns, section, expectedRevision) {` |
| 488 | `async mutate(ns, ops, expectedRevision) {` |
| 538-540 | `schema(entry) {` / `const schema = entry.fiber?.runtime?.Config;` / `return schema !== void 0 && "toJSON" in schema ? schema : void 0;` |

方法语义（catalog 原文摘要）：
- `describe`："Read active plugin schemas and their live values" —— 按 **profile entry id** 返回每条的 `{ ns, schema, revision, applies: 'live', value, base, user, autoGenerate, secrets? }`。
- `update`："Merge editable fields into an entry's config"（带 revision 的乐观锁）。
- `replace`："Reset all live fields, then set the supplied fields; ordinary config is preserved"。
- `mutate`："Apply field edits without restating redacted secrets; unsetting an array index removes its element"。
- `configure({ auto })`："Register the calling plugin instance's page policy without changing its Config"，`auto` 默认 `true`。
- 版本冲突抛 `SettingsConflictError`（`lib/index.js:163`）。

### 2.3 只有「volatile 字段」会进表单

`dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js:122-131`（原文）：

```js
function volatileForm(schema) {
	if (schema.meta.volatile) return plainSchema(schema);
	if (schema.type === "object") {
		const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
			const field = volatileForm(child);
			return field === undefined ? [] : [[key, field]];
		}));
		return Object.keys(dict).length === 0 ? undefined : z.object(dict);
	}
	return undefined;
}
```

`describe()` 里对每个 entry：`const form = volatileForm(schema); if (form === void 0) return [];`
（`lib/index.js:413-462`，其中 `416-421` 取 schema、过滤非 ACTIVE fiber）。
**因此：没有 `.volatile()` 字段的插件，在 `settings.describe()` 里完全不可见。**

### 2.4 Remote（HTTP）侧的同一组 API

`dsh/node_modules/@deepseek-ai/dsh-api-settings-controller` 把上面这套暴露为 `ctx.remote.settings`（catalog `key: 'settingsController'`，`api-catalog.js:3265+`）：

```ts
@Remote describe(): SettingsDescribeValue
@Remote update(ns: string, patch: Record<string, JsonValue>, expectedRevision: number | undefined): Promise<SettingsNamespaceView>
@Remote replace(ns: string, section: Record<string, JsonValue>, expectedRevision: number | undefined): Promise<SettingsNamespaceView>
@Remote async mutate(ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined): Promise<SettingsNamespaceView>
@Remote async openSettingsDocument(signal: AbortSignal): Promise<SettingsDocumentOpenValue>
```

Remote 读一律 `redactSecrets: true`（`role('secret')` 字段不会下发，只给 presence marker）。

---

## 3. (a) 插件如何声明设置（schemastery `Config`）

### 3.1 Schema 侧：`.volatile()` 是 schemastery 自带能力

`dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs:235-237`（原文）：

```js
Schema.prototype.volatile = function volatile() {
	if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
	return this.extra("volatile", true);
```

它的含义（loader README 的说法，见 `dsh-settings/README.md`）：字段可在**不重新挂载插件**的情况下热更新，
并被设置表单视为可编辑。非 volatile 的普通配置仍只能在 Cordis 配置文件里改。

### 3.2 两种声明写法（都是官方包里的真实代码）

**写法 A —— 模块级导出（`export const Config`）**，`dsh/node_modules/@deepseek-ai/dsh-tool-todo/lib/types/index.js:14-16`：

```js
/** Schemastery configuration for the todo tool consumer. */
export const Config = z.object({
    allowParallelInProgress: z.boolean().required(),
```

**写法 B —— Service 类静态字段（`static Config`），且带 `.volatile()`**，
`dsh/node_modules/@deepseek-ai/dsh-agent-default-model/lib/index.js:19-31`（原文）：

```js
	config;
	saves = Promise.resolve();
	static Config = z.object({
		provider: z.string().required().volatile(),
		model: z.string().required().volatile(),
		reasoningEffort: z.string().volatile()
	});
	constructor(ownerContext, config) {
		super(ownerContext, "agentDefaultModel");
		this.ownerContext = ownerContext;
		this.config = config;
		ownerContext.inject(["settings"], (child) => {
```

**最接近「一个插件 + 自己声明设置」的最小样本**：`dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/index.js:1-18`（整文件原文）：

```js
import z from "@deepseek-ai/schemastery";
//#region lib/types/index.js
/** Live welcome preference. */
const Config = z.object({ welcomeNoticeVersion: z.string().volatile() });
/** The browser consumes the configuration form projection.
* @param ctx Plugin context used for optional settings presentation.
*/
function apply(ctx) {
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
}
//#endregion
export { Config, apply };
```

要点：
- 字段名即设置项名，`.volatile()` 决定它是否可被运行时改；
- `configure({ auto: false })` 表示「本实例自带页面，别自动生成」（见 §4）；
- host 侧读取配置仍然是「直接读 `config`」，设置服务只负责**写**与**表单描述**，不改变业务读路径（`dsh-settings/README.md`："The policy does not remove configuration reads or writes"）。

### 3.3 持久化去哪了

`dsh/node_modules/@deepseek-ai/dsh-config-editor/README.md`（原文摘要）：

> Save plugin configuration in the active profile's patch and apply it immediately.
> Writes validate the complete candidate before touching disk and serialize with profile changes and HMR.

即：写入目标 = **当前 profile 的 Cordis patch**（保留 YAML 注释与 `!!js` 表达式，原子替换），
`describe()` 返回的 `value / base / user` 三层就是「schema 默认 → composition base → 用户层」。
旧版遗留的 `settings.yaml` 会在 Loader 稳定后被**一次性导入**并改名为 `settings.yaml.imported`（`dsh-settings/README.md`）。

---

## 4. (c) 官方 Web 是否自动渲染插件 schema —— **不自动渲染**

### 4.1 决定性原文（`dsh/node_modules/@deepseek-ai/dsh-settings/README.md`）

> Each form reports `autoGenerate`, enabled by default, **for clients that build pages from the schema; no shipped client does so yet.**
> A plugin that ships its own page registers `configure({ auto: false }, ctx.fiber)` as an effect inside an optional `ctx.inject(['settings'], ...)` child from `apply`.

同段还说明："Changes persist through the active profile's Cordis patch"，以及
"Forms expose only volatile fields from active, uniquely addressed profile entries"
（`dsh-settings/README.md` Use this package 段）。

### 4.2 协议里保留了 `autoGenerate`，但 UI 侧没人消费

`dsh/node_modules/@deepseek-ai/dsh-api-remotes/lib/client.js:2903`（生成的 remote 类型，原文）：

```js
"autoGenerate": zod.z.boolean().describe("Generate a page if no custom page is registered for this instance."),
```

对 21047 个文件做全量 grep，`autoGenerate` **只**出现在四处：
`dsh-api-remotes/lib/client.js`（协议类型）、`dsh-api-settings-controller/*`（host/remote 编解码）、
`dsh-settings/*`（产生该字段）、`dsh-tool-cordis/lib/types/api-catalog.js`（文档）。
**没有任何 `dsh-client-ui-settings-*` 或 `dsh-client-ui-plugin-manager` 读它** —— 官方 Web 没有「按 schema 生成表单」的渲染器。

### 4.3 官方设置页面全是手写组件

`dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/README.md`（原文）：

> It also provides the standard extension points for settings chrome, pages, header actions, plugin tabs, and onboarding while **rendering no interface itself**.

`dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/README.md`（原文）：

> **A plugin that registers a configuration page is edited here, on its own page**; Settings keeps the read-only inventory.
> **Built-in plugin settings** lists official configuration pages by their configured order: Subagent, web search, agent loop, then shell.

`dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins/README.md`（原文）：

> The section is a shell: it owns the navigation entry and the tab row, and every tab in it is registered by another plugin — the read-only inventory ships one.
> Configuring a built-in plugin happens on the sidebar's Plugins page, where **each official plugin's own companion package registers its page**.

客户端已挂载的官方设置页（`dsh/desktop-runtime.json` 里可见，共 11 个 client-settings 包）：
`account / agent-loop / general / models / plugin-inventory / plugins / session-log / shell / subagent / web-search`，
每页都是 `dsh-client-ui-settings-<name>/lib/client.js` 里手写的 React 组件。

### 4.4 唯一「自动」的地方是 `auto: false` 的反向开关

`dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/index.js:14-18`（原文）：

```js
function apply(ctx) {
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
}
```

它只影响 `describe()` 返回的 `autoGenerate` 布尔值，**没有任何 UI 读这个值**。

> 附加观察（未在运行态验证）：侧栏 Plugins 页确实持有 `configurations: this.ctx.configForms.describe()`
> 与 `configForm: (id) => this.ctx.configForms.get(id)`（`dsh-client-ui-plugin-manager/lib/client.js:3168,3179`），
> 但其用法是**把当前页面的值交给已注册的配置页组件**，而不是生成表单；页面的存在性由
> `configurations?.some((view) => view.ns === id)` 决定（同文件 `6919-6921`）。

---

## 5. 插件自带设置页的具体写法（槽位契约）

客户端槽位契约的权威文本在 `dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`（slot catalog，含每个槽位的 options、owner props、示例代码）。三个可用落点：

### 5.1 整页：`settings.section`（catalog:5754）

> One settings page per list entry. Registrant options carry the nav identity: `id` (section key, drives `only` filtering), `order` (nav position), `label` (registrant-localized display text ...).

示例（catalog 原文）：

```js
return {
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register(
      { name: 'settings.section', id: 'my-entry', order: 100, label: 'My entry' },
      () => React.createElement('div', null, 'hello'),
    ))
  },
}
```

声明者：`sidebar.settings` 的 occupant（`client-ui-settings-general`），所以设置外壳挂载时它才存在。
页组件收到的 owner props 只有 `{ close: () => void }`；数据要自己通过 inject face 取。

### 5.2 单行开关：`settings.general.item`（catalog:5423）

> One preference row inside the General section — the additive seat for a single setting that needs no page of its own (a whole page is `settings.section`), contributed by the feature plugin that owns the preference (locale → Language, ui-theme → Appearance, ui-conversation → Composer Enter). Options: `id`, `order`. ... **the owner passes no props at all** — copy, current value, and the write path are all yours, through your own inject face and `host.call`.

### 5.3 插件行配置：`plugins.row.config`（catalog:5158）

> The configuration of one row a bundle declares, keyed by `<package name>#<row id>` with the row id as the bundle's patch declares it: the row on the bundle's page gains a configure control that opens the entry's page, headed by the plugin's display title and description.

owner props：

```ts
/** The view the page asks a configuration entry for. */
export interface PluginConfigViewProps {
  /** `summary` renders the one-liner alone, as text or inline nodes; `page` renders the form with its save control. */
  readonly view: 'summary' | 'page'
  /** Host-owned configuration values and write actions for this page's entry. */
  readonly form?: ConfigPageForm | undefined
}
```

### 5.4 client 侧读写：`ctx.configForms`

`dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/README.md`（原文要点）：

> Feature adapters use `ctx.configForms.get(entryId)` to obtain accepted values and a write queue shared by every editor of that Host entry. Snapshots contain resolved `value`, inherited `base`, raw `user`, revision, and writability. `set` and `unset` submit one operation; `mutate` submits one atomic operation list.
> A page that edits a namespace another plugin owns registers through `ctx.configForms.whileServed(namespaces, register)`.
> `settings.describe.writable` is the authority on whether a write is accepted.

client 插件的 inject 声明实例（`dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-subagent/lib/client.js:1032-1038`，原文）：

```js
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.session",
			"configForms"
		];
```

同包 `:1073` 的真实注册写法：

```js
ctx.effect(() => ctx.configForms.whileServed([SUBAGENT_NS, SUBAGENT_MODEL_SELECTION_NS], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
```

---

## 6. 对 dsh-AIkb 的现状核对（结论用）

- `dsh-AIkb/package.json`：`"version": "0.1.1"`，`"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"] } }`
  —— **`inject` 里没有 `@deepseek-ai/dsh-client-ui-settings`**，所以当前 client 半身拿不到 `configForms`，也无法注册 `settings.section`。
- host 侧 `dsh-AIkb/src/index.ts:136`：`export function apply(ctx: PluginContext, config: KbPluginConfig = {}): void`
  —— **没有导出 `Config`**（全仓 grep `export const Config` 在 `dsh-AIkb/src` 内 0 命中），配置靠 `cordis.patch.yml` 的 `config:` 段硬编码：
  ```yaml
  - id: dsh-aikb
    name: dsh-aikb
    config:
      allowWrites: false
  ```
  结果：该插件**不会出现在 `settings.describe()` 里**（`schema(entry)` 拿不到 `Config`），官方 UI 也没有任何入口能改 `vaultPath` / `allowWrites`。

要让它在设置里出现，最小改动面是：
1. host：新增 `export const Config = z.object({ vaultPath: z.string().volatile(), allowWrites: z.boolean().volatile(), ... })`（`z` 来自 `@deepseek-ai/schemastery`）；
   注意 `describe()` 只认 `entry.fiber.runtime.Config`，且 entry 必须处于 ACTIVE。
2. client：新增/扩展 web client 模块，inject 加 `@deepseek-ai/dsh-client-ui-settings`，并在其中 `inject: ['slots','configForms', ...]` 后注册 `settings.general.item`（单行）或 `settings.section`（整页）。
3. 官方 UI 不会因此自动长出表单 —— 表单控件仍要自己写。

---

## 7. 未确认点清单

1. **`settings` 服务对「第三方 bundle 条目」的可见性未在运行态验证**：代码路径是 `configEditor.configuration()` 遍历**所有** profile entry（`dsh-settings/lib/index.js:413-462`），看起来与「官方/第三方」无关，但本机没有运行 DSH（任务禁止启动），无法确认 dsh-aikb 这类 bundle 插入行是否真的进入该枚举；也无从确认写入是否因 `writable: false` 被拒。
2. **`applies: 'live'` 对第三方插件是否总是成立**：官方所有带 volatile 字段的业务插件都成立，但第三方插件若在 `apply` 里缓存了 config（dsh-AIkb 就是 `cachedConfig`，`src/index.ts:205-210`），热更新后是否被重新注入取决于它自己有没有监听配置变化 —— 未验证。
3. **`plugins.row.config` 的 key 格式**：文档说 `<package name>#<row id>`（catalog:5161），但没有第三方（非官方）实例可对照；dsh-AIkb 的 row id 是 `dsh-aikb`，key 应为 `dsh-aikb#dsh-aikb`，此推断未实证。
4. **`hasDocument` / `writable` 在本机是否恒为真**：`dsh-client-ui-plugin-manager/README.md` 说 "a Host without a managed profile shows the page as unavailable"，本机 profile 目录（`~/.dsh/profiles/`）**并不存在**，无法确认桌面版的 profile 落在哪里、是否 managed。
5. **profile patch 的具体磁盘路径**：README 只说「active profile's patch」，未给出桌面版的确切文件名（`cordis.patch.yml`? `profile.json`?）；未找到 `~/.dsh/profiles`，无法核对。
6. **Loader 读取 `Config` 的确切来源**：`schema(entry)` 读的是 `entry.fiber.runtime.Config`（`lib/index.js:538-540`），但 cordis loader 把模块导出映射到 `runtime.Config` 的那一步代码我没有逐行读（`@deepseek-ai/cordis` 只有 23 个文件、内容为压缩产物），目前只有「多个官方包用 `export const Config` / `static Config` 且确实出现在设置里」这一间接证据。
7. **`settings.section.icon` 之外的导航定制**（如分组、二级导航）：catalog 只列了 `settings.section` 与 `settings.section.icon`，是否存在分组机制未确认。
8. **`autoGenerate` 未来是否会被实现**：README 说 "no shipped client does so yet"（含「yet」），无法判断后续版本计划。

---

## 8. 取证方法与复现

asar 是 Electron 的单文件归档（8 字节 pickle 头 + JSON 目录 + 拼接的文件体），文件系统上不可直接读。
本次用一个自写的只读解析脚本（`temp/asar.mjs`，工作区内已有）按 asar 头解析后按需读出内部文件：

```bash
# 目录统计 / 列出包 / 按正则找路径 / 全文 grep / 打印单文件
node temp/asar.mjs "D:/app/DeepSeek Harness/resources/app.asar" stats
node temp/asar.mjs "D:/app/DeepSeek Harness/resources/app.asar" find "^/dsh/node_modules/@deepseek-ai/dsh-.*settings.*/package.json$"
node temp/asar.mjs "D:/app/DeepSeek Harness/resources/app.asar" grep "autoGenerate"
node temp/asar.mjs "D:/app/DeepSeek Harness/resources/app.asar" cat /dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js
```

解析规则：读 offset 4 的 `uint32` 得头部长度 → 读 offset 8 起的头部 block → 再取其 offset 4 的 `uint32` 得 JSON 长度 →
`JSON.parse(block[8 : 8+len])` → 数据区基址 `base = 8 + size`，每个条目的内容在 `base + offset`。

全程只读：没有启动 DSH 进程，没有写 `~/.dsh`，没有改动仓库既有文件（本文件是唯一新增）。
