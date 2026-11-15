---
name: kb-search
description: >-
  Plan and run searches over the user's local book vault before answering:
  decompose the question into 3-8 high-signal terms, run separate Chinese and
  English kb_query calls instead of one sentence, merge hits by page, read the
  chapter window, and cite path + page. Use whenever an answer should come from
  the user's PDF/EPUB library — 查资料、查书、书里怎么说、哪本手册讲过、找公式/引脚/
  时序/参数、需要页码引用 — or when one kb_query call returned nothing useful.
license: MIT
metadata:
  version: "1.4"
  tools: kb_query, kb_inventory, kb_doctor
---

# kb-search

一次 `kb_query` 就是一个词袋。把整句问题丢进去，或者把中英文混在一起，都会因为覆盖率惩罚而变差。
固定五步：**拆词 → 一次多说法融合查询 → 按页合并 → 判读窗口 → 带页码回答**。

## 1. 拆词：3–8 个高信号词

| 词位 | 取什么 | 例 |
| --- | --- | --- |
| 主体 | 书里会写的名词，不是口语 | 升压变换器、共射放大电路 |
| 属性 | 参数名，能带单位更好 | 输出电压、纹波、限流电阻 |
| 条件 | 工况/状态 | 轻载、饱和、高温、截止 |
| 型号/缩写 | 原文照抄（命中权重 ×2.5） | STM32F103、VBAT、RDS(on) |
| 现象 | 用书中措辞 | 漂移、失真、自激、振荡 |

- 每个词都要**可能出现在目标段落**里；凑数的词会拉低整块得分。
- 去掉「为什么/怎么/如何/问题/分析/电路」这类泛词，除非它确实是主题。
- 型号、英文缩写原样保留大小写与连字符。
- 先判断这题要找的是哪类内容：定义 / 公式推导 / 拓扑 / 选型 / 时序图 / 引脚定义 / 故障现象。不同类型用不同词。

## 2. 一次查多说法（queries）

同一个子问题用**一次**调用传多种说法，检索层按倒数排名融合（RRF）；不要为每种说法各查一次。

```json
kb_query({ "query": "稳压管 稳压电路 限流电阻 计算",
           "queries": ["Zener diode series resistor calculation", "齐纳二极管 限流电阻"],
           "topK": 8 })
```

- `queries` 最多 5 条（含 `query` 共 6 条）；空串与重复会被丢弃，`searched.queries` 只在真的融合时出现。
- 适合放：**英文标准术语**、另一个中文叫法、缩写/型号。不适合放：整句问题、泛词、猜的词。
- 实测（中文 26 题）：page@5 11→14、±10 页 13→16、MRR 0.20→0.34，代价 +0.4–0.7 s。前 5 名不再被字面 query 锁死，更好的说法可以赢。
- 但另写的 12 题（5 本新书、用书中原词提问）融合反而 page@5 9→7、MRR 0.58→0.44；合计 38 题只从 20 涨到 21。**`queries` 是漂移补偿，不是默认动作**：问题里的词能在书里原样出现时，只查一次。
- **英文书只查一次英文 query**，不要补英文同义说法：17 题 page@1 13→10、page@5 16→13、MRR 0.85→0.67——英文教材正文本来就重复这些词。
- **不要同时开 `queries` 和 `rerank`**：13/26、MRR 0.27，比只融合更差；两者选一个（中文术语漂移优先 `queries`）。
- 融合时不再用向量补位（每个槽都被多说法占满），所以 `retrieval` 仍是 `bm25`。
- 实在没有第二种说法时才分次查（中文一次、英文一次），再按第 3 节自己合并。
- 英文不要逐词直译中文短语，用器件/参数的标准英文名。
- 词都拆对了、候选章节也对，**但页码/段落明显漂**，或用户点名要「书里第几页」：对那次中文查询加 `rerank: true`（本地 bge-reranker-base 逐条比对，+1.5–2 s）。它只重排 40 条词法候选，不改书、不改章节；不要每次查询都开。
- **英文书不要开 rerank**：英文教材正文本来就会重复 query 里的词，词法排序已经很准（17 题实测 page@1 13/17、MRR 0.85）；重排会把跨页讨论压成单页，掉到 8/17、0.60。rerank 是给中文术语漂移用的。

| 问题 | 中文 query | 英文 query |
| --- | --- | --- |
| 稳压管限流电阻怎么算 | `稳压管 稳压电路 限流电阻 计算` | `Zener diode series resistor calculation` |
| boost 轻载输出不稳 | `升压变换器 轻载 输出电压 纹波` | `boost converter light load output voltage ripple` |
| 定时器怎么测频率 | `STM32 定时器 输入捕获 频率 测量` | `input capture frequency measurement timer` |
| 运放共模抑制比 | `共模抑制比 运算放大器 定义` | `common mode rejection ratio op amp` |

第一行是实测有效的查询；模式照抄，词按题目换。

## 3. 合并：按页去重

- key = `path` + `page`；相差 ≤2 页视为同一处，保留分数高的那条。
- 融合后仍被多个说法命中的页最可信；若分次查，记录每个候选被**几个不同 query** 命中过。
- 同书多版本会同时出现：内容对但页码不同，选与用户上下文一致的那本。

## 4. 判读：先看窗口，再看摘录

- `section` 是这一页所属章节；`pageEnd > page` 时，`p.N–M` 就是可用的章节窗口。
- 只对最好的 1–2 条加 `expand: "section"`（配 `maxContextChars: 3000`）；不要 8 条全展开。
- 可信度顺序：多个 query 词同页命中 > 单 query 高 score > 只有向量补位 > 目录/前言页。
- 以下命中要降级并换词重查：
  - 摘录里大量 `.....`、只剩标题行 → 目录页；
  - 摘录 < 80 字符，或整页只有页眉（`RM0008`、`www.ti.com`、`Datasheet` 开头）→ 近空页；
  - 页码在书末且摘录是词条列表 → 索引页；
  - 讲的是相邻概念而不是问题本身 → 术语层级换一档（教材词 ↔ 工程词 ↔ 缩写）。
- 扫描版教材走 OCR：**公式、上下标、符号可能失真**。引用公式/数值前用 PDF 打开该页核对；纯文字结论可以直接用。

## 5. 停止条件与查不到

- 中文一轮 + 英文一轮后，top8 里仍没有真正讲这件事的段落 → 停止换词，别硬凑。
- 结果为空：先 `kb_inventory` 确认资料是否已入库；未入库的书检索不到。
- 只在入库范围内回答；库里没有就说没有，不要用相近页代替。
- 常识题不必查库。

## 6. 回答格式

- 每条事实后跟 `path p.N`，跨页写 `p.N–M`；路径用 hits 返回的原样路径。
- 引用原文控制在 1–2 句，不整段搬运。
- 分开写「书里的结论」与「据此推断」；推断不要挂页码。
- 不引用没出现在 hits 里的页码；不把 OCR 文本当原文公式照抄。
- 同内容不同版次页码不同，注明用的是哪一本/哪一版。

## 7. 工具速查

- `kb_query({ query, queries?, topK = 8, expand = 'none'|'page'|'section', maxContextChars = 3000, rerank = false, vaultPath? })`
  - 返回 `hits[].path/page/pageEnd/section/score/excerpt/context`、`searched.{sources,chunks,vectors,families,queries}`、`retrieval`、`reranked`。
- `kb_inventory`：入库清单与哈希，确认「有没有这本书」。
- `kb_doctor`：库结构、写权限、索引与清单状态。
- 性能：索引在进程内缓存，大库首查约 6 s（181 本 / 27k 块），之后约 0.4 s；多查两轮不贵。`rerank: true` 每查约 +1.5–2 s（首次另加模型加载约 5 s）。

## 8. 基线（校准预期）

2026-11 的 26 题中文实测：主题命中 26/26，同书命中 20/26，精确页 ±2 只有 11/26（≈42%）；开 `rerank` 后精确页 12/26、±10 页 14/26、MRR 0.20→0.30；用 `queries` 融合后精确页 14/26（54%）、±10 页 16/26、MRR 0.34。
另加 12 题（新概念模拟电路细节页、童诗白、康华光、晶体管电路设计(上)、高速数字设计）：BM25 精确页 9/12、MRR 0.58，融合降到 7/12、0.44；`term@5` 11/12 说明**答案词就在命中页上**，此时融合的英文改写反而把英文书拉进来。
英文 17 题（5 本英文教材）：page@1 13/17、±2 页 16/17、同书 17/17、MRR 0.85；开 `rerank` 反而降到 8/17、13/17、0.60。
含义：**「哪本书、哪一章」很可靠，精确页码会漂**。优先给 section 与页区间；差十几页不要否定内容，也不要把邻近页说成原文页。

## 9. 常见术语对照（按需取 1–3 个）

| 中文 | 英文 |
| --- | --- |
| 静态工作点 | quiescent operating point / Q-point |
| 共射放大电路 | common-emitter amplifier |
| 稳压二极管 | Zener diode |
| 去耦电容 | decoupling capacitor |
| 纹波 | ripple |
| 占空比 | duty cycle |
| 死区时间 | dead time |
| 上拉/下拉电阻 | pull-up / pull-down resistor |
| 导通电阻 | on-resistance (RDS(on)) |
| 阈值电压 | threshold voltage |
| 传输延迟 | propagation delay |
| 共模抑制比 | common-mode rejection ratio |
| 电源抑制比 | power supply rejection ratio |
| 输入捕获 | input capture |
| 脉宽调制 | pulse-width modulation |

只挑与问题相关的 1–3 个，不要把整张表塞进 query。

## 10. 反例

- `kb_query("为什么我的 boost 电路在轻载时输出电压不稳定")` —— 整句 + 口语词。
- `kb_query("boost 升压 电路 轻载 不稳定")` —— 中英混排，两边都被稀释；应写成 `query` 中文 + `queries: ["boost converter light load ..."]`。
- 英文书补一串英文同义说法，或 `queries` 与 `rerank` 同开 —— 两者实测都是负收益。
- 对 8 条 hits 全部 `expand: "section"` —— 上下文爆炸，信息没变多。
- 拿目录页当依据 —— 页码对，内容不对。

照第 2 节的表拆词、两轮后按页合并，再按第 6 节写引用。
