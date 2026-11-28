# kb-search

Agent skill shipped with dsh-AIkb: plan the query before calling `kb_query`.

一次 kb_query 只能匹配一个词袋。这个 skill 规定：先拆 3–8 个高信号词，中文一轮、
英文一轮分开查，按 path+page 合并，只对最好的 1–2 条展开章节，最后带 `path p.N` 引用。

覆盖内容：拆词词位表、中英分查的调用形状、按页合并、命中降级（目录页/近空页/索引页/
扫描失败）、查不到时的回退顺序、引用格式、收尾检查与反例。示例一律用 `<占位符>`，
按"提问形状"区分类别，不预设书库属于哪个学科。

由插件 `cordis.patch.yml` 里的 `@deepseek-ai/dsh-skill-filesystem` provider 加载，
技能名 `kb-search`。
