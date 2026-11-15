# kb-search

Agent skill shipped with dsh-kb: plan the query before calling `kb_query`.

一次 kb_query 只能匹配一个词袋。这个 skill 规定：先拆 3–8 个高信号词，中文一轮、
英文一轮分开查，按 path+page 合并，只对最好的 1–2 条展开章节，最后带 `path p.N` 引用。

覆盖内容：拆词词位表、双语查询示例、命中降级规则（目录页/近空页/索引页/OCR 公式）、
查不到时的回退（kb_inventory）、引用格式、26 题评测基线（主题 26/26，精确页约 42%）。

由插件 `cordis.patch.yml` 里的 `@deepseek-ai/dsh-skill-filesystem` provider 加载，
技能名 `kb-search`。
