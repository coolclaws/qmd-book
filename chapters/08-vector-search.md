# 第 8 章：向量搜索与嵌入

> 全文检索能找到精确的关键词匹配，但语义搜索才能理解用户真正想要什么。qmd 在本地 SQLite 数据库中集成了 sqlite-vec 扩展，将文档转化为高维向量，用余弦相似度衡量语义距离。这一章我们将深入 `src/store.ts` 和 `src/llm.ts`，看看一个完全离线的向量搜索系统是如何从表结构创建、文档嵌入、到最终检索一步步搭建起来的。

## 向量表的创建与校验

### ensureVecTableInternal() 的职责

向量搜索的基础是存储结构。`src/store.ts` 的 `ensureVecTableInternal()` 函数（第 962-977 行）负责创建和维护 vec0 虚拟表。这张表是整个向量检索的核心存储，使用 sqlite-vec 提供的 vec0 模块：

```sql
CREATE VIRTUAL TABLE vectors_vec USING vec0(
  hash_seq TEXT PRIMARY KEY,
  embedding float[N] distance_metric=cosine
)
```

其中 `N` 是嵌入模型输出的维度数，由首次生成的向量动态确定。主键 `hash_seq` 采用 `"{hash}_{seq}"` 的格式，将文档哈希与分块序号拼接，确保每个文档片段都有唯一标识。距离度量选择了 `cosine`，即余弦距离，这是文本语义检索中最常用的度量方式。

### 模式校验与重建

`ensureVecTableInternal()` 不只是简单地执行 `CREATE TABLE`。它在创建前会检查已有表的维度和模式是否匹配当前配置。校验的要点包括：主键字段是否为 `hash_seq`、距离度量是否为 cosine、向量维度是否与当前嵌入模型一致。

如果检测到模式不匹配——比如用户切换了嵌入模型导致维度变化——函数会果断地 DROP 旧表并重新创建。这个设计看似激进，但在实际场景中是合理的：向量维度不同意味着旧数据完全不可用，保留它们反而会导致查询错误。

## 嵌入管道的三个阶段

### 查询文本的格式化

`src/llm.ts` 中的 `formatQueryForEmbedding()` 函数（第 38-44 行）负责将用户的原始查询包装成嵌入模型期望的输入格式。这里有一个重要的细节：不同的嵌入模型需要不同的 prompt 格式。

对于默认的 embeddinggemma 模型，格式为：

```
task: search result | query: {query}
```

而对于 Qwen3-Embedding 系列模型，格式则变为：

```
Instruct: Retrieve relevant documents for the given query
Query: {query}
```

模型检测通过 `isQwen3EmbeddingModel()` 函数（`llm.ts` 第 29-31 行）完成，它使用正则表达式匹配模型名称中的 Qwen3 特征串。这种按模型类型分发格式的策略，保证了不同嵌入模型都能在最佳 prompt 下工作。

### 文档文本的格式化

与查询格式化对应，`formatDocForEmbedding()` 负责文档侧的格式化。文档嵌入使用的格式为：

```
task: search document | title: {title} | text: {text}
```

查询和文档使用不同的 task 前缀（`search result` vs `search document`），这是非对称嵌入（asymmetric embedding）的经典做法。搜索引擎中查询通常很短，文档通常很长，两者的语义空间分布不同，使用不同的 task 标记可以让模型更好地将它们映射到共同的向量空间中。

### getEmbedding() 的封装

`src/store.ts` 的 `getEmbedding()` 函数（第 2910-2917 行）是一个简洁的封装层，将底层的 embed 调用与上层的格式化逻辑粘合在一起。它接受文本和类型参数（query 或 doc），自动调用对应的格式化函数，然后交给 LLM 会话执行实际的嵌入计算。这层封装使得调用方不需要关心格式化细节。

## 向量检索的实现

### searchVec() 的两步查询策略

`src/store.ts` 的 `searchVec()` 函数（第 2820-2904 行）是向量检索的核心。这个函数最值得关注的设计决策是它的两步查询架构。

**第一步**：直接查询 `vectors_vec` 虚拟表，使用 sqlite-vec 提供的 MATCH 语法：

```sql
WHERE embedding MATCH ? AND k = ?
```

这一步只返回 `hash_seq` 和对应的距离值，不涉及任何 JOIN 操作。

**第二步**：拿到候选的 `hash_seq` 列表后，再通过常规 SQL JOIN `content_vectors`、`documents`、`content` 等表，获取文件路径、标题、正文等元数据。

### 为什么不用单步 JOIN？

这个两步策略并非过度设计，而是一个必要的工程妥协。正如 PR #23 中记录的，sqlite-vec 在执行包含 JOIN 的查询时会出现挂起（hang）的问题。将向量匹配与元数据查询分离，绕过了这个已知的 bug，同时也让每一步的查询逻辑更简单、更易调试。

### 去重与评分

`searchVec()` 在拿到结果后还需要做去重处理。由于一个文档会被切分为多个 chunk，同一个文件可能返回多条结果。函数按 `filepath` 去重，只保留距离最小（相似度最高）的那条记录。

最终的评分计算公式为：`score = 1 - cosine_distance`。cosine_distance 的范围是 [0, 2]，其中 0 表示向量完全相同。转换后 score 的范围是 [-1, 1]，1 表示完全匹配，这与直觉一致。

## 批量嵌入的工程细节

### generateEmbeddings() 的完整流程

`src/store.ts` 的 `generateEmbeddings()` 函数（第 1303-1447 行）负责为所有待处理的文档生成嵌入向量。这是一个复杂的批处理流程，包含多层优化。

首先，`getPendingEmbeddingDocs()` 通过 LEFT JOIN `content_vectors` 表找出尚未生成嵌入的文档。这个 JOIN 的逻辑很直白：如果 `content_vectors` 中没有对应记录，说明该文档还没有被嵌入。

然后，`buildEmbeddingBatches()` 将待处理文档组织成批次。批次受两个约束限制：`maxDocsPerBatch`（默认 64 个文档）和 `maxBatchBytes`（默认 64MB）。双重限制确保既不会一次性加载过多文档导致内存溢出，也不会因单个超大文档撑爆内存。

### 分块与嵌入

对于每个批次中的文档，`chunkDocumentByTokens()` 将长文档按 token 数切分为多个片段。切分是必要的，因为嵌入模型有输入长度限制，且过长的文本会稀释语义信号。

嵌入操作以 32 个 chunk 为一组批量执行。批量嵌入比逐条嵌入高效得多，因为它能充分利用 GPU 的并行计算能力，减少模型调用的开销。

### 容错机制

`generateEmbeddings()` 内建了一个重要的容错策略：如果批量嵌入失败，会自动降级为逐条嵌入。这意味着即使某些文档格式异常导致批量处理出错，其他正常文档仍然能够完成嵌入，不会因为一颗老鼠屎坏了一锅粥。

### 维度的动态确定

一个巧妙的实现细节是：向量表的维度在第一个 chunk 成功嵌入后才确定。`generateEmbeddings()` 用第一个 chunk 的返回向量长度来调用 `ensureVecTableInternal()`，创建或校验表结构。这使得 qmd 无需在配置中硬编码维度，切换嵌入模型时也无需手动修改配置。

### 数据写入

每个成功嵌入的 chunk 通过 `insertEmbedding()` 写入两张表：`content_vectors` 存储元数据（文档哈希、序号、chunk 文本等），`vectors_vec` 存储实际的向量数据。主键 `hash_seq` 在两张表之间建立关联，格式为 `"{hash}_{seq}"`，其中 `hash` 标识文档，`seq` 标识 chunk 序号。

## 默认模型配置

### 三个模型的分工

qmd 的向量搜索涉及三个本地模型，各司其职。`src/store.ts` 第 42-44 行定义了它们的默认值：

- **嵌入模型**（`DEFAULT_EMBED_MODEL`）：`embeddinggemma`，负责将文本转为向量。这是 Google 发布的轻量级嵌入模型，在 MTEB 等基准测试中表现优异。
- **重排模型**：`ExpedientFalcon/qwen3-reranker:0.6b-q8_0`，负责对候选结果进行精排。0.6B 参数量、Q8_0 量化，在精度和速度之间取得了平衡。
- **查询生成模型**：`Qwen/Qwen3-1.7B`，负责查询扩展，将自然语言问题转化为多种类型的子查询。

三个模型的选择体现了 qmd 的设计原则：优先选择小模型，确保在消费级硬件上也能流畅运行。

## 本章小结

本章剖析了 qmd 向量搜索系统的完整链路。从 `ensureVecTableInternal()` 创建和校验 vec0 虚拟表，到 `formatQueryForEmbedding()` 和 `formatDocForEmbedding()` 为不同模型适配输入格式，再到 `searchVec()` 用两步查询绕过 sqlite-vec 的 JOIN 缺陷，最后到 `generateEmbeddings()` 的批处理流水线——每一层都在解决具体的工程问题。向量搜索不是简单地调用一个 API，而是从存储格式、查询策略、批处理优化到容错降级的系统工程。qmd 在 SQLite 这个看似简单的基础上，搭建了一套完整且可靠的本地语义检索方案。
