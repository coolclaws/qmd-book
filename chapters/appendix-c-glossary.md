# 附录 C：名词解释

> 本附录收录了 qmd 源码和本书中出现的专业术语，按英文字母顺序排列。每个术语标注英文全称和中文解释，方便读者在阅读过程中随时查阅。

## 术语表

| 术语 | 英文全称 | 解释 |
|------|---------|------|
| BM25 | Best Matching 25 | 一种经典的概率信息检索排名函数，由 Stephen Robertson 等人提出。qmd 通过 SQLite FTS5 内置的 `bm25()` 函数实现，在 `src/store.ts` 的 `searchFTS()` 中使用。它根据词频（TF）、逆文档频率（IDF）和文档长度对查询词的匹配程度打分。相比简单的 TF-IDF，BM25 对高频词有饱和效应，避免了长文档的不公平优势。 |
| Content-Addressable Storage | 内容寻址存储 | 一种以数据内容的哈希值作为存储地址的策略。qmd 的 `content` 表（`src/store.ts` L659）使用 SHA-256 哈希作为主键，相同内容无论路径如何变化都只存储一份。这在多个虚拟路径指向同一文件时自动实现了去重。 |
| Cosine Distance | 余弦距离 | 衡量两个向量方向差异的距离度量，定义为 `1 - cosine_similarity`。值为 0 表示完全相同方向，值为 1 表示正交。qmd 在 sqlite-vec 虚拟表中指定 `distance_metric=cosine`，向量检索返回的分数通过 `1 - cosine_distance` 转换为相似度。 |
| Cross-Encoder | 交叉编码器 | 一种将查询和文档拼接后整体编码的重排序模型，与 Bi-Encoder（双编码器，分别编码查询和文档）相对。Cross-Encoder 能捕捉查询与文档之间更精细的交互特征，但推理成本较高，因此只用于对候选结果集做精排。qmd 使用 `qwen3-reranker-0.6b-q8_0.gguf` 模型在本地执行 Cross-Encoder 重排。 |
| Docid | Document Identifier（文档标识符） | qmd 中每个文档的唯一标识，采用 `qmd://collection/path` 格式的虚拟路径。Docid 与文件系统的真实路径解耦，允许同一文件在不同集合中有不同的标识。 |
| Embedding | 嵌入/嵌入向量 | 将文本映射到高维实数向量空间的过程及其产物。语义相近的文本在向量空间中距离更近。qmd 使用 `embeddinggemma-300M-Q8_0.gguf` 模型在本地生成嵌入，通过 `src/llm.ts` 的 `embedBatch()` 方法批量处理。 |
| FTS5 | Full-Text Search 5 | SQLite 的第五代全文搜索扩展。qmd 创建了 `documents_fts` 虚拟表（`src/store.ts` L764），使用 `porter unicode61` 分词器，同时支持英文词干提取和 Unicode 文本。FTS5 提供内置的 `bm25()` 评分函数和 `highlight()`、`snippet()` 辅助函数。 |
| GGUF | GPT-Generated Unified Format | 一种用于存储大语言模型权重的文件格式，由 llama.cpp 社区开发。GGUF 支持多种量化精度（Q4、Q8 等），qmd 依赖 node-llama-cpp 加载 GGUF 格式模型，通过 HuggingFace URI 引用并自动下载到 `~/.cache/qmd/models`。 |
| HyDE | Hypothetical Document Embedding | 一种查询扩展策略。LLM 根据原始查询生成一篇"假设文档"——即如果答案存在，它可能长什么样。然后用这篇假设文档的嵌入向量去执行向量检索，往往比直接用短查询嵌入更能匹配真实的相关文档。在 `ExpandedQuery` 类型中 `type: 'hyde'` 标识此策略。 |
| Intent | 查询意图 | 用户查询背后的真实目的。qmd 的查询扩展模型（`qmd-query-expansion-1.7B-q4_k_m.gguf`）会分析查询意图，据此生成词汇扩展（lex）和语义扩展（vec）两种补充查询，提升召回率。 |
| Lex Query | Lexical Query（词汇查询） | 基于关键词匹配的查询方式，对应 BM25 全文检索路径。在 `ExpandedQuery` 类型中 `type: 'lex'` 标识词汇扩展——LLM 为原始查询添加同义词或相关关键词，扩大 FTS5 的匹配范围。 |
| MCP | Model Context Protocol（模型上下文协议） | Anthropic 提出的一种标准协议，允许 AI Agent（如 Claude）通过标准化接口调用外部工具。qmd 的 `src/mcp.ts` 实现了 MCP 服务器，将搜索、获取文档等能力注册为 MCP 工具，支持 HTTP 和 stdio 两种传输方式。 |
| node-llama-cpp | — | 一个 Node.js/Bun 原生绑定库，封装了 llama.cpp 推理引擎。qmd 通过 `src/llm.ts` 的 `LlamaCpp` 类使用它加载 GGUF 模型，执行嵌入生成、查询扩展和重排序三种推理任务。支持 GPU 加速和动态批处理。 |
| Porter Stemmer | Porter 词干提取器 | 一种经典的英文词干提取算法，由 Martin Porter 于 1980 年提出。它将英文单词还原为词干形式（如 "running" → "run"），使得搜索 "search" 也能匹配到 "searching"、"searched"。qmd 的 FTS5 虚拟表通过 `tokenize='porter unicode61'` 启用此功能。 |
| Position-Aware Blending | 位置感知混合 | qmd 混合查询管线中的一项优化策略。在 RRF 融合过程中，不仅考虑各路搜索结果的排名，还会根据结果在原始文档中的位置信息调整权重。例如，出现在文档标题或开头的匹配通常获得更高的融合分数。 |
| Query Expansion | 查询扩展 | 在用户原始查询的基础上自动生成补充查询，以提升搜索召回率的技术。qmd 使用本地 LLM 模型生成三种扩展：词汇扩展（lex）添加同义词关键词，语义扩展（vec）改写查询以捕捉不同表述，HyDE 生成假设文档嵌入。扩展结果通过 `ExpandedQuery` 类型表示。 |
| Reciprocal Rank Fusion (RRF) | 倒数排名融合 | 一种将多路搜索结果合并排序的算法。对于每个文档，计算其在各路搜索中排名的倒数之和：`score = Σ 1/(k + rank)`，其中 k 是平滑参数（通常为 60）。RRF 的优点是不依赖各路搜索的绝对分数（它们可能量纲不同），只利用相对排名，天然适合融合 BM25 和向量搜索这类异构结果。 |
| Reranking | 重排序 | 在初步检索（召回）之后，使用更精确但更昂贵的模型对候选结果重新排序的过程。qmd 使用 Cross-Encoder 模型（Qwen3-Reranker）对 RRF 融合后的 Top-N 结果做精排，通常能显著提升排序质量。 |
| Smart Chunking | 智能分块 | qmd 将长文档切分为适合嵌入的片段时使用的算法。与固定长度切分不同，智能分块在目标位置附近的搜索窗口内寻找最佳断点（如 Markdown 标题、代码块边界、段落分隔符），使用距离衰减加权评分 `1.0 - (distance/window)^2 * 0.7` 来平衡断点质量与位置。参见 `src/store.ts` 中的 `findBestCutoff()` 函数（L384）。 |
| sqlite-vec | — | 一个 SQLite 扩展，为 SQLite 添加向量搜索能力。它提供 `vec0` 虚拟表类型，支持余弦距离、L2 距离等度量方式的近邻查询。qmd 在 `src/db.ts` 中加载此扩展，在 `src/store.ts` 中创建 `vectors_vec` 虚拟表存储文档嵌入向量。 |
| Strong Signal | 强信号 | qmd 混合查询管线中的一种优化机制。当某个文档在 BM25 或向量搜索中获得极高分数（超过预设阈值）时，系统会将其标记为"强信号"，在 RRF 融合时给予额外加权，确保高置信度的匹配不会因为另一路搜索中排名较低而被埋没。 |
| Token Bucket | 令牌桶 | 一种经典的流量控制算法。qmd 在批量嵌入操作中使用令牌桶来限制对 LLM 推理引擎的并发调用速率，防止内存溢出或 GPU 资源争抢。桶中的令牌以固定速率补充，每次推理调用消耗一个令牌。 |
| Vec Query | Vector Query（向量查询） | 基于语义相似度的查询方式，对应向量检索路径。在 `ExpandedQuery` 类型中 `type: 'vec'` 标识语义扩展。向量查询先将查询文本通过嵌入模型转为向量，再在 sqlite-vec 中检索余弦距离最近的文档分块。 |
| Virtual Path (qmd://) | 虚拟路径 | qmd 用于标识文档的 URI 格式，形如 `qmd://collection-name/relative/path.md`。虚拟路径将文档标识与文件系统真实路径解耦，使得同一文件可以在不同集合中拥有不同身份。所有 API 返回的 `docid` 字段均使用虚拟路径格式。 |
| WAL | Write-Ahead Logging（预写日志） | SQLite 的一种日志模式。在 WAL 模式下，修改操作先写入独立的日志文件，读操作可以与写操作并发执行，不会互相阻塞。qmd 在 `initializeDatabase()` 中通过 `PRAGMA journal_mode=WAL`（`src/store.ts` L651）启用此模式，确保在索引文档的同时能响应搜索查询。 |

## 缩写对照表

| 缩写 | 全称 | 首次出现章节 |
|------|------|:----------:|
| BM25 | Best Matching 25 | 第 1 章 |
| CAS | Content-Addressable Storage | 第 4 章 |
| FTS | Full-Text Search | 第 1 章 |
| GGUF | GPT-Generated Unified Format | 第 1 章 |
| HyDE | Hypothetical Document Embedding | 第 11 章 |
| IDF | Inverse Document Frequency | 第 7 章 |
| MCP | Model Context Protocol | 第 1 章 |
| RRF | Reciprocal Rank Fusion | 第 1 章 |
| TF | Term Frequency | 第 7 章 |
| VRAM | Video Random Access Memory | 第 9 章 |
| WAL | Write-Ahead Logging | 第 4 章 |
