# 第 4 章：Schema 与内容寻址存储

> 数据库的表结构是一个系统真正的"骨架"——它决定了数据如何存储、如何关联、如何查询。qmd 的 Schema 设计围绕一个核心理念展开：内容寻址存储。同一份文档内容无论出现在多少个路径下，在数据库中只存储一次。本章将逐一解析 `src/store.ts` 中 `initializeDatabase()` 函数创建的每一张表，揭示 WAL 日志模式、FTS5 全文索引和 sqlite-vec 向量表背后的设计考量。

## PRAGMA 配置：WAL 与外键

### 预写日志模式

`initializeDatabase()` 函数在创建任何表之前，首先设置两个关键的 PRAGMA：

```ts
// 文件: src/store.ts L651-652
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA foreign_keys=ON");
```

WAL（Write-Ahead Logging）日志模式是 SQLite 的高性能写入方案。在默认的 rollback journal 模式下，写操作需要锁定整个数据库文件；而 WAL 模式将修改追加到独立的日志文件中，读操作可以与写操作并发执行。对于 qmd 这样需要在索引文档的同时响应搜索查询的工具，WAL 模式显著减少了锁竞争。

外键约束默认在 SQLite 中是关闭的——这是一个历史遗留设计。`PRAGMA foreign_keys=ON` 确保了 `documents` 表中的 `hash` 字段必须指向 `content` 表中实际存在的记录，从而在数据库层面保证了引用完整性。

## 核心表：content 与 documents

### content 表：内容寻址的基石

```sql
// 文件: src/store.ts L659-664
CREATE TABLE IF NOT EXISTS content (
  hash TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

`content` 表是 qmd 内容寻址存储的核心。它的主键不是自增 ID，而是文档内容的 SHA-256 哈希值。`doc` 字段存储文档的完整文本，`created_at` 记录首次写入时间。

内容寻址（content-addressable）的含义是：数据的存储地址由其内容决定。两份完全相同的文档，无论文件名或路径如何不同，都会生成相同的 SHA-256 哈希，因此在 `content` 表中只占一行。这种设计带来两个直接好处：一是自动去重节省存储空间，二是通过比较哈希值即可快速判断内容是否发生变化。

哈希计算由 `hashContent()` 函数完成：

```ts
// 文件: src/store.ts L1887-1891
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
```

使用 SHA-256 而非 MD5 或更短的哈希，是出于碰撞概率的考量。SHA-256 产生 64 个十六进制字符的摘要，在可预见的文档规模下碰撞概率可以忽略不计。

写入内容时使用 `INSERT OR IGNORE` 语义：

```ts
// 文件: src/store.ts L1933-1935
db.prepare("INSERT OR IGNORE INTO content (hash, doc) VALUES (?, ?)").run(hash, doc);
```

如果哈希值已经存在，`INSERT OR IGNORE` 会静默跳过插入，不会报错也不会覆盖已有数据。这使得内容写入操作天然具备幂等性——多次索引同一份文档不会产生副作用。

### documents 表：文件系统映射

```sql
// 文件: src/store.ts L668-683
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  hash TEXT REFERENCES content(hash),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
  active INTEGER DEFAULT 1,
  UNIQUE(collection, path)
);
```

如果说 `content` 表存储"内容是什么"，那么 `documents` 表就存储"内容在哪里"。每一行代表一个具体的文件路径，`collection` 和 `path` 的组合构成唯一键。`hash` 字段通过外键指向 `content` 表，建立起路径与内容之间的多对一关系。

`active` 字段值得特别注意。当一个文件被删除时，qmd 不会立即从数据库中移除对应记录，而是将 `active` 设为 `0`。这种软删除策略避免了级联删除带来的复杂性，同时保留了文件曾经存在过的历史信息。

`UNIQUE(collection, path)` 约束确保了同一个集合中不会出现重复路径。当文件内容更新时，qmd 更新 `documents` 行的 `hash` 指向新的内容记录，而旧的 `content` 行保持不变——它可能仍被其他路径引用。

## 向量与嵌入：content_vectors 与 vectors_vec

### content_vectors 元数据表

```sql
// 文件: src/store.ts L704-713
CREATE TABLE IF NOT EXISTS content_vectors (
  hash TEXT NOT NULL,
  seq INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  model TEXT NOT NULL,
  embedded_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (hash, seq)
);
```

文档在进行向量嵌入时，通常需要将长文本分割成多个片段（chunk），每个片段单独计算嵌入向量。`content_vectors` 表记录这些片段的元数据：`hash` 关联到 `content` 表，`seq` 是片段的序号，`pos` 是片段在原文中的字符位置，`model` 记录使用的嵌入模型名称。

主键 `(hash, seq)` 意味着同一内容的同一片段只有一条元数据记录。当嵌入模型更新时，可以通过 `model` 字段识别并重新计算旧模型生成的向量。

### vectors_vec 虚拟表

```sql
// 文件: src/store.ts L976
-- 由 ensureVecTableInternal() 动态创建
CREATE VIRTUAL TABLE vectors_vec USING vec0(embedding float[N] distance_metric=cosine);
```

`vectors_vec` 是一张 sqlite-vec 虚拟表，存储实际的浮点向量数据并提供相似度搜索能力。`distance_metric=cosine` 指定使用余弦距离作为相似度度量。

这张表不在 `initializeDatabase()` 中静态创建，而是由 `ensureVecTableInternal()` 函数按需创建。原因是向量维度 `N` 取决于所选的嵌入模型——不同模型产生不同维度的向量（例如 OpenAI 的 `text-embedding-3-small` 输出 1536 维）。只有在首次执行嵌入操作时，系统才知道具体的维度值。

此外，如第 3 章所述，sqlite-vec 扩展可能不可用。将虚拟表的创建推迟到实际需要时，避免了在缺少扩展的环境中触发错误。

## 辅助表

### store_collections：自包含配置

```sql
// 文件: src/store.ts L716-725
CREATE TABLE IF NOT EXISTS store_collections (
  name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  pattern TEXT,
  ignore_patterns TEXT,
  include_by_default INTEGER DEFAULT 1,
  update_command TEXT,
  context TEXT
);
```

qmd 的集合配置主要存储在 YAML 文件中（详见第 5 章），但 `store_collections` 表在数据库中保留了一份副本。这使得 `.qmd` 数据库文件具备自包含性——即使脱离配置文件，也能从数据库中恢复集合的定义信息。

### store_config：键值元数据

```sql
// 文件: src/store.ts L729-733
CREATE TABLE IF NOT EXISTS store_config (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

`store_config` 是一张简单的键值表，存储数据库级别的元信息。目前最重要的键是 `config_hash`，它记录上一次同步到数据库的 YAML 配置文件的 SHA-256 哈希。在每次启动时，qmd 比较当前配置文件的哈希与数据库中存储的哈希，如果相同则跳过同步，避免不必要的写操作。

### llm_cache：LLM 调用缓存

```sql
// 文件: src/store.ts L689-695
CREATE TABLE IF NOT EXISTS llm_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  model TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

qmd 在使用 LLM 进行查询重排序等操作时，会将 API 调用结果缓存在这张表中。缓存键通常由请求参数的哈希构成，相同的请求直接返回缓存结果，既节省 API 调用费用，也大幅降低响应延迟。`model` 字段记录了生成缓存的模型版本，便于在模型更新后选择性地清除旧缓存。

## FTS5 全文搜索索引

### 虚拟表定义

```sql
// 文件: src/store.ts L738-742
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  filepath, title, body,
  tokenize='porter unicode61'
);
```

FTS5 是 SQLite 内置的全文搜索引擎。`documents_fts` 虚拟表索引三个字段：文件路径、标题和正文。分词器配置为 `porter unicode61`，其中 `unicode61` 处理 Unicode 字符的规范化和分词，`porter` 则对英文词汇进行词干提取（例如将 "running" 还原为 "run"）。

这是 qmd 的 BM25 搜索的基础。BM25 是一种经典的文本相关性算法，FTS5 对其提供了原生支持。即使 sqlite-vec 不可用，BM25 搜索依然能够提供高质量的文本检索结果。

### 同步触发器

FTS5 虚拟表的内容不会自动与 `documents` 表同步。qmd 通过三个触发器实现自动同步：

```sql
// 文件: src/store.ts L746-780
-- 插入触发器
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, filepath, title, body)
  SELECT new.id, new.path, new.title, c.doc
  FROM content c WHERE c.hash = new.hash;
END;

-- 删除触发器
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, filepath, title, body)
  VALUES('delete', old.id, old.path, old.title,
    (SELECT doc FROM content WHERE hash = old.hash));
END;

-- 更新触发器
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, filepath, title, body)
  VALUES('delete', old.id, old.path, old.title,
    (SELECT doc FROM content WHERE hash = old.hash));
  INSERT INTO documents_fts(rowid, filepath, title, body)
  SELECT new.id, new.path, new.title, c.doc
  FROM content c WHERE c.hash = new.hash;
END;
```

`documents_ai` 在插入新文档时，将路径、标题和内容正文写入 FTS 索引。`documents_ad` 在删除文档时，通过 FTS5 的特殊 `'delete'` 命令从索引中移除对应记录。`documents_au` 在更新文档时，先删除旧索引条目，再插入新的。

注意更新触发器的实现方式：它执行了"先删后增"两步操作，而非直接更新。这是因为 FTS5 虚拟表不支持 `UPDATE` 操作，修改索引内容的唯一方式就是删除旧记录再插入新记录。

触发器从 `content` 表联查正文内容（`c.doc`），这正体现了 `content` 与 `documents` 分离设计的连贯性——`documents` 表本身不存储正文，正文始终通过 `hash` 从 `content` 表获取。

## 内容寻址的整体流程

将以上各表串联起来，一次文档索引的完整数据流如下：

1. 读取文件内容，调用 `hashContent()` 计算 SHA-256 哈希。
2. 以 `INSERT OR IGNORE` 将内容写入 `content` 表。如果哈希已存在，跳过。
3. 在 `documents` 表中创建或更新路径记录，`hash` 字段指向 `content` 表。
4. 触发器自动将文档信息同步到 `documents_fts` 全文索引。
5. 如果 sqlite-vec 可用，将内容分片、计算嵌入向量，写入 `content_vectors` 和 `vectors_vec`。

当同一份内容出现在多个路径下时（例如符号链接或跨集合引用），步骤 2 不会产生重复写入，步骤 5 也不会重复计算嵌入——因为嵌入的主键绑定在 `hash` 而非 `path` 上。这意味着存储空间和 LLM API 调用都得到了有效节约。

## 本章小结

qmd 的数据库 Schema 围绕内容寻址存储这一核心理念构建。`content` 表以 SHA-256 哈希为主键实现去重，`documents` 表将文件路径映射到内容哈希，两者通过外键关联形成多对一关系。FTS5 虚拟表和三个触发器提供了自动同步的全文搜索能力；sqlite-vec 虚拟表在可用时提供向量相似度搜索。辅助表 `store_collections` 和 `store_config` 使数据库具备自包含性，`llm_cache` 降低了 LLM 调用开销。WAL 日志模式和外键约束在性能与数据完整性之间取得了平衡。整套设计用七张表和三个触发器，支撑起了从纯文本检索到语义向量搜索的完整搜索管线。
