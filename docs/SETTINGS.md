# 配置与多知识库

dsh-AIkb 的配置只有一份来源：`~/.dsh-aikb/config.json`（可用环境变量 `KB_CONFIG` 指向别处）。
DSH 设置页、KB 面板与 agent 工具读的是同一份文档，改一处不需要重启；工具每次调用按文件 mtime 自动重载。

## 打开设置页

在 DSH 里打开「设置」，左侧选「知识库」一节（宿主设置页的 `settings.section` 槽位）。KB 面板（7341）本身不再带配置界面，标题栏只有一个知识库下拉。设置页上可以：

- 添加、重命名、移除知识库；每行给绝对路径。圆点选中哪一行，那一行就是「当前库」。
- 「新建知识库」直接造一个库：Obsidian 标记、模板目录（notes / books / both / blank）、库约定、README 与 index 笔记，然后登记进配置并设为当前库；目录里已有文件会被拒绝。
- 切换当前库有两个入口：设置页里点圆点，或在 KB 面板标题栏的下拉里选；两者都会立刻让笔记树、检索与其它页签切到新库（面板会重新加载页面）。
- 填「知识包目录」（`kb_export_pack` 的落点）与「工具链目录」（虚拟环境、OCR 模型、向量模型共用的根）。
- 勾选「允许写入」才会放行编译落盘、提升、链接应用等写操作。
- 保存带乐观锁：页面读到 revision，保存时带上；若文件已被别处改过，保存会被拒绝并提示重载，而不是静默覆盖。

## 配置字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | 2 | 版本号；1 只有单库 `vaultPath`，读取时自动迁移为 id `default` 的库 |
| `vaults` | 数组 | `{id, name, dir, booksDir?}`；`dir` 必须是绝对路径，`booksDir` 是库内相对目录，留空表示自动发现 |
| `activeVault` | 字符串 | 当前库的 `id`；不存在时回退到第一个库并给 warning |
| `packDir` | 字符串 | 知识包输出目录 |
| `toolchainDir` | 字符串 | 工具链根；留空时用 `~/.dsh-aikb/toolchain` |
| `pythonPath` / `pythonLibPath` / `pythonMirror` | 字符串 | 私有 Python 解释器、额外库路径、pip 镜像 |
| `ocrEnabled` / `ocrWorkers` | 布尔 / 数字 | 扫描版 PDF 的本地 OCR |
| `embedEnabled` / `embedOnIngest` | 布尔 | 向量检索与入库时顺带建向量 |
| `rerankEnabled` | 布尔 | 交叉编码器重排（慢，默认关） |
| `allowWrites` | 布尔 | 写操作总开关 |
| `promoteDir` | 字符串 | `kb_promote` 的落点（库内相对目录），留空表示不提升 |

## 库约定

每个库可以有一份「库约定」：页面规范、目录用途、加工流程写在一起，人和 AI 读同一份。
它存放在库内 `.dsh-aikb/schema.md`，不进索引、不会被打包、也不随配置迁移——跟着库走。

- 设置页「知识库」一节里的「库约定」文本框直接编辑；还没有文件时填入三段模板，保存即创建。
- 保存同样受「允许写入」约束：未勾选时接口返回 403 `kb.schema.read-only`，文本框只读。
- 上限 64 KB，空内容拒绝（`kb.schema.empty` / `kb.schema.too-large`）；写入用临时文件加 rename，不留半份。
- `kb_doctor` 会报 `sheet` 一项：文件不存在时是 `warn`，并在 `nextActions` 里提示去设置页写。

## 任务队列与版本历史

队列文件在 `<toolchainDir>/jobs/queue.json`，随工具链目录走，换库不混队。通过 `kb_jobs` 工具（list / enqueue / cancel / recover / prune / summary）或 KB 服务的 `/api/jobs` 系列接口管理；执行一个待跑任务用 `POST /api/jobs/run`（目前只有 `judge` 会真的跑，即入队后让后台模型判一轮矛盾队列）。面板与设置页都不再放队列按钮。

笔记页右上角有「版本历史」：每次保存都会先把被覆盖的正文存进 `<vault>/.dsh-aikb/history/`（每篇保留最近 20 版）。下拉选一版可以「载入这一版」（只进编辑器，点保存才写回）或「恢复这一版」（直接写回，并先把当前内容存成新版本，所以恢复了也能再退回去）。

## 页面反馈

笔记页右上角「反馈」按钮：选中一篇笔记后点一下，写一句哪里不对，会追加到本库的 `inbox/feedback.md`。设置页「知识库」一节底部列出这些反馈，处理完点「标为已处理」把 `[ ]` 改成 `[x]`；行不会被删除，所以缺陷记录留在库里，人和 AI 都能读到。

## 工具链目录

所有重产物都在一个根下，两个库不会各下一份模型：

```
<toolchainDir>/venv                       私有 Python 环境（PyMuPDF、RapidOCR）
<toolchainDir>/models/ocr                 OCR 模型
<toolchainDir>/models/multilingual-e5-small  向量模型
<toolchainDir>/models/bge-reranker-base    重排模型
<toolchainDir>/logs                       安装与运行日志
```

显式配置 `venvPath` 时，工具链根取它的父目录；`ocrModelDir` / `embedModelDir` / `rerankModelDir`
仍然优先于上面的默认值。

## 解析顺序

工具调用与页面请求都按同一顺序挑库：

1. 请求里显式给的库 id 或路径（`vaultPath` 工具参数、`?address=` 查询参数）；
2. 配置里的 `activeVault`；
3. 旧入口：环境变量 `KB_VAULT`、启动时传给 UI 的库；
4. 工作区绑定 `.dsh-aikb.json` / `.dsh-kb.json`（向上最多 8 层）；
5. 完全没有配置文件时，向上找含 `.obsidian` 的目录。

显式路径即使不在配置列表里也照用——发现能力不该被配置绑死。

## 就绪门

`/api/config` 与 `kb_doctor` 会报 `missing`：`vaults`（没配库或目录不存在）、`packDir`、`toolchainDir`。
工具调用只被前两个里的库问题拦住（`kb.not-ready`，错误里给配置文件路径与修法）；
`packDir` / `toolchainDir` 只影响对应功能，不会让只读检索失败。

## HTTP 接口

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/config` | 返回 `config`、`revision`、`missing`、`warnings`、`sources`、`vaults`（带 `active`/`exists`）、`toolchain`、`configPath` |
| `POST /api/config` | 部分更新；体里带 `expectRevision` 做乐观锁；校验失败返回 `problems`，revision 过期返回 409 与 `kb.config.stale` |
| `GET /api/vaults` | 库清单与当前库 |
| `POST /api/vault/active` | `{id}` 切换当前库，其它接口立即跟随 |
| `POST /api/vault/init` | `{dir, name?, template?, activate?}` 新建库并登记；非空目录、相对路径、只读模式分别返回 400/400/403 |
| `GET /api/schema?address=` | 当前库（或指定库）的库约定：`path`、`exists`、`bytes`、`updatedAt`、`text`、`template`、`allowWrites` |
| `POST /api/schema` | `{text, address?}` 写入库约定；`allowWrites` 关闭时 403 |
| `GET /api/jobs` | 队列文件路径、`summary`（按状态与 kind 计数）、最近 100 条任务 |
| `POST /api/jobs/enqueue` | `{kind, vault?, label?, payload?, maxAttempts?}`；`vault` 省略时用当前库；同 kind+vault+label 的待跑任务会复用 |
| `POST /api/jobs/cancel` | `{id}`；未知 id 返回 404 |
| `POST /api/jobs/recover` | 把崩溃时残留的 `running` 任务放回 `pending` |
| `POST /api/jobs/prune` | `{keepDone?}` 删除最早的已完成/已取消任务，`pending`/`running`/`failed` 永不清 |
| `POST /api/jobs/run` | `{limit?}`（上限 5）认领并执行任务；目前 `judge` 会调后台模型判一轮矛盾队列，其余 kind 以 `kb.job.unsupported` 失败 |
| `GET /api/history?address=&path=` | 某篇笔记的历史版本清单（最新在前） |
| `GET /api/history/entry?address=&path=&stamp=` | 读回某一版正文 |
| `POST /api/history/restore` | `{path, stamp}` 恢复；先把当前内容存成新版本，只读模式 403 |
| `GET /api/feedback` | 页面反馈清单（`path`、`exists`、`rows`、`allowWrites`） |
| `POST /api/feedback` | `{path, text}` 追加一条反馈；只读模式 403，空文本 400 |
| `POST /api/feedback/done` | `{index}` 把某条反馈的 `[ ]` 改成 `[x]` |

## 旧配置迁移

配置文件只有 `vaultPath` 时，读取阶段把它变成 `{id: "default", name: <目录名>, dir: <绝对路径>}`，
并给一条 `kb.config.migrated` 提醒；写回时文件即升级为 `version: 2`。损坏或非对象的 JSON 不会让
插件启动失败，而是按「未配置」处理并给 `kb.config.unreadable` / `kb.config.invalid` 提醒。
