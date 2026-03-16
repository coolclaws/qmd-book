# 第 1 章：项目概览

> 在 AI Agent 时代，知识检索的质量直接决定了生成内容的上限。qmd 是一个完全本地运行的混合搜索引擎，专为 Markdown 文件设计，将 BM25 全文检索、向量语义搜索与 LLM 重排序三种能力融合在一个轻量级 TypeScript 工具中。它不依赖任何云端 API，所有推理均通过 node-llama-cpp 加载 GGUF 模型在本地完成——这是对"数据主权"与"离线优先"理念的一次工程实践。

## 为什么需要 qmd

### Markdown 知识库的检索困境

当你积累了数百甚至数千份 Markdown 笔记时，操作系统自带的搜索工具很快就会力不从心。`grep` 只能做字面匹配，无法理解"机器学习"和"深度学习"之间的语义关联。而云端搜索服务虽然强大，却意味着你的私人笔记需要上传到第三方服务器。

qmd 的作者 Tobi Lutke——Shopify 的 CEO——正是在这样的场景下创建了这个项目。作为一名重度 Markdown 用户和 AI 工具实践者，他需要一个能够在本地高效检索个人知识库的方案，同时要能作为 AI Agent 的工具无缝集成。

### 三重搜索的设计哲学

qmd 的核心理念是"混合搜索"（Hybrid Search），它将三种互补的检索策略组合在一起：

| 搜索策略 | 技术实现 | 优势 | 局限 |
|---------|---------|------|------|
| BM25 全文检索 | SQLite FTS5 | 精确关键词匹配，速度极快 | 无法理解语义相似性 |
| 向量语义搜索 | sqlite-vec + 嵌入模型 | 捕捉语义关联 | 可能遗漏精确术语 |
| LLM 重排序 | node-llama-cpp 重排序模型 | 综合理解查询意图 | 计算成本较高 |

这三层机制在 `src/store.ts` 中通过 Reciprocal Rank Fusion（RRF）算法进行融合，最终返回兼顾精确性与语义相关性的搜索结果。

## 核心架构

### 数据存储层：SQLite 的极致运用

qmd 的存储层完全构建在 SQLite 之上，但并非简单地使用一张表。它巧妙地利用了 SQLite 的扩展生态，在单一数据库文件中同时实现关系型存储、全文索引和向量检索。

在 `src/store.ts` 的第 709-764 行，定义了核心数据表结构。`content` 表（第 709 行）以内容哈希为主键存储文档原文，实现了内容去重。`documents` 表（第 714 行）记录文件的元数据——路径、标题、所属集合和活跃状态。

全文搜索依赖 FTS5 虚拟表（第 764 行），使用 `porter unicode61` 分词器，同时支持词干提取和 Unicode 文本：

```sql
CREATE VIRTUAL TABLE documents_fts USING fts5(
  filepath, title, body, tokenize='porter unicode61'
)
```

向量搜索则通过 sqlite-vec 扩展实现，在第 1644 行创建 `vectors_vec` 虚拟表，使用余弦距离度量。每个文档被分块后生成嵌入向量，存储在 `content_vectors` 表（第 746 行）中。

### 搜索引擎层：从查询到结果

当用户发起一次搜索时，qmd 的处理流程分为以下几个阶段。

**BM25 检索**在 `searchFTS()` 函数（第 2294 行）中实现。它使用 FTS5 的内置 BM25 评分函数，权重配置为 `bm25(documents_fts, 10.0, 1.0)`——文件路径的权重为 10.0，正文为 1.0。BM25 返回的负分数通过 `|score|/(1+|score|)` 归一化到 [0, 1) 区间。

**向量检索**在 `searchVec()` 函数（第 2346 行）中实现。它采用两步策略：先在 sqlite-vec 虚拟表中执行纯向量查询（避免 JOIN 操作的性能开销），再通过哈希关联回文档表。最终得分为 `1 - cosine_distance`。对于同一文件的多个分块命中，只保留距离最近的那个。

**RRF 融合**是混合搜索的关键一步。Reciprocal Rank Fusion 算法将 BM25 和向量搜索的排名列表合并，公式为 `1/(k + rank)`，其中 k 是平滑参数。这种方法的优点是不依赖绝对分数，只关注相对排名，因此能自然地平衡两种异构检索结果。

### LLM 层：本地推理引擎

`src/llm.ts` 中的 `LlamaCpp` 类（第 235 行）封装了所有与本地大模型的交互。qmd 默认配置了三个 GGUF 模型，各司其职：

| 模型 | 用途 | 文件 |
|-----|------|------|
| embeddinggemma 300M | 文档嵌入 | `embeddinggemma-300M-Q8_0.gguf` |
| Qwen3-Reranker 0.6B | 结果重排序 | `qwen3-reranker-0.6b-q8_0.gguf` |
| qmd-query-expansion 1.7B | 查询扩展 | `qmd-query-expansion-1.7B-q4_k_m.gguf` |

模型通过 HuggingFace URI 格式引用（如 `hf:ggml-org/embeddinggemma-300M-GGUF/...`），首次使用时自动下载到 `~/.cache/qmd/models` 目录。`LlamaCpp` 类实现了惰性加载和 5 分钟不活跃自动卸载（第 255 行），避免常驻内存占用。

批量嵌入通过 `embedBatch()` 方法（第 525 行）实现，它根据可用 VRAM 的 25% 或 CPU 核心数自动分配并行上下文数量。

### 文档分块策略

好的分块直接影响检索质量。`src/store.ts` 中实现了两种分块策略：基于字符的 `chunkDocument()`（第 2209 行）和基于 Token 的 `chunkDocumentByTokens()`（第 2234 行）。

核心参数配置如下：目标分块大小为 900 tokens，重叠区域为 135 tokens（15%），搜索窗口为 200 tokens。系统在窗口内扫描最佳切割点，优先在 Markdown 标题处断开（H1 得分 100，H2-H6 得分 90-50），其次是代码块边界（得分 80）和段落分隔符（得分 20）。

`findBestCutoff()` 函数（第 384 行）使用平方衰减函数 `1.0 - (distance/window)^2 * 0.7` 来平衡切割点质量与位置，确保即使较远的标题断点也能胜过近处的低质量断点。

## 三种消费模式

qmd 提供了三种使用方式，它们共享同一个 `Store` 核心。

**命令行工具**（`src/cli/qmd.ts`）是最直接的交互方式。它提供了 `query`、`search`、`vsearch`、`get`、`multi-get` 等二十余个子命令，支持 JSON、CSV、XML、Markdown 等多种输出格式。

**SDK 库**（`src/index.ts`）导出 `createStore()` 工厂函数，返回一个 `QMDStore` 接口，包含 `search()`、`searchLex()`、`searchVector()`、`get()`、`multiGet()` 等方法，供 Node.js / Bun 应用程序直接调用。

**MCP 服务器**（`src/mcp/server.ts`）实现了 Model Context Protocol，提供 `query`、`get`、`multi_get`、`status` 四个工具，支持 stdio 和 HTTP 两种传输模式。这使得 qmd 可以作为 Claude、ChatGPT 等 AI Agent 的知识检索后端。

三种模式的架构关系可以概括为：用户请求通过 CLI / SDK / MCP 进入系统，统一调用 Store 层完成索引和检索，Store 层与 SQLite 数据库（FTS5 + sqlite-vec）和 LLM 引擎（node-llama-cpp + GGUF 模型）交互，最终返回排序后的结果。

## 关键依赖一览

| 依赖包 | 版本 | 职责 |
|-------|------|------|
| better-sqlite3 | ^12.4.5 | Node.js 环境下的 SQLite 驱动 |
| node-llama-cpp | ^3.17.1 | 本地 GGUF 模型推理运行时 |
| sqlite-vec | ^0.1.7-alpha.2 | SQLite 向量搜索扩展 |
| @modelcontextprotocol/sdk | ^1.25.1 | MCP 协议实现 |
| fast-glob | ^3.3.0 | 高性能文件路径匹配 |
| picomatch | ^4.0.0 | Glob 模式匹配库 |
| zod | 4.2.1 | 运行时类型校验 |
| yaml | ^2.8.2 | 集合配置文件解析 |

值得注意的是，sqlite-vec 还提供了按平台分发的可选依赖（darwin-arm64、darwin-x64、linux-arm64 等），确保原生扩展在不同操作系统上正确加载。

## 本章小结

qmd 是一个为 AI Agent 时代设计的本地混合搜索引擎。它在单一 SQLite 数据库中集成了 BM25 全文检索（FTS5）、向量语义搜索（sqlite-vec）和 LLM 重排序三重机制，通过 RRF 算法融合结果。所有推理通过 node-llama-cpp 在本地完成，无需云端依赖。项目约 12,000 行 TypeScript 代码，核心逻辑集中在 `src/store.ts`（搜索与索引）和 `src/llm.ts`（模型管理）两个文件中，通过 CLI、SDK 和 MCP 三种模式对外提供服务。这种"重存储层、轻接口层"的设计，使得同一套搜索原语能够灵活适配不同的使用场景。
