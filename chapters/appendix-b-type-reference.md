# 附录 B：核心类型速查

> qmd 的类型系统是理解其架构的钥匙。本附录按功能分类列出所有核心 TypeScript 类型，标注源文件位置和行号，方便读者在阅读源码时快速定位。类型定义均摘自实际源码，按 Store、文档、搜索、集合、索引、分块、数据库七个类别组织。

## Store 类型

Store 是 qmd 的核心引擎，`QMDStore` 是面向外部的 SDK 封装，`StoreOptions` 控制初始化行为。

| 类型名 | 源文件 | 行号 | 说明 |
|-------|--------|:----:|------|
| `Store` | `src/store.ts` | L983-1054 | 核心引擎类，封装全部搜索、索引、文档操作 |
| `QMDStore` | `src/index.ts` | L212-306 | SDK 公开接口，`Store` 的高层封装 |
| `StoreOptions` | `src/index.ts` | L196-203 | 初始化配置，控制数据库路径、集合等 |

### Store

`Store` 类是整个 qmd 的心脏，定义在 `src/store.ts` 第 983-1054 行。它持有数据库连接、LLM 实例和集合配置，暴露搜索、索引、文档管理的完整 API。

```ts
// 文件: src/store.ts L983-1054
class Store {
  db: Database;
  llm: LlamaCpp;
  collections: Collection[];
  contextMap: ContextMap;

  // 搜索方法
  hybridQuery(query: string, options?: HybridQueryOptions): Promise<HybridQueryResult>;
  searchFTS(query: string, limit?: number): SearchResult[];
  searchVec(query: string, limit?: number): Promise<SearchResult[]>;

  // 文档管理
  get(docid: string): DocumentResult | DocumentNotFound;
  multiGet(docids: string[]): MultiGetResult;
  index(filepath: string, content: string): Promise<void>;
  reindex(): Promise<ReindexResult>;

  // 索引状态
  indexStatus(): IndexStatus;
  indexHealth(): IndexHealthInfo;
}
```

### QMDStore

`QMDStore` 是面向外部开发者的 SDK 接口，定义在 `src/index.ts` 第 212-306 行。它在 `Store` 基础上添加了生命周期管理（`open()`/`close()`）、集合内联配置、和双写同步能力。

```ts
// 文件: src/index.ts L212-306
class QMDStore {
  static open(options: StoreOptions): Promise<QMDStore>;
  close(): void;

  query(query: string, options?: HybridQueryOptions): Promise<HybridQueryResult>;
  get(docid: string): DocumentResult | DocumentNotFound;
  multiGet(docids: string[]): MultiGetResult;
  index(filepath: string, content: string): Promise<void>;
  indexStatus(): IndexStatus;
}
```

### StoreOptions

```ts
// 文件: src/index.ts L196-203
interface StoreOptions {
  dbPath: string;           // 数据库文件路径
  collections?: string[];   // 集合配置文件路径列表
  contextMap?: ContextMap;  // 上下文映射
  modelDir?: string;        // GGUF 模型存储目录
}
```

## 文档类型

文档类型覆盖了从单文档获取到批量查询的所有返回结构。

| 类型名 | 源文件 | 行号 | 说明 |
|-------|--------|:----:|------|
| `DocumentResult` | `src/store.ts` | L1543-1554 | 单文档查询的成功结果 |
| `DocumentNotFound` | `src/store.ts` | L1692-1696 | 文档不存在时的返回类型 |
| `SearchResult` | `src/store.ts` | L1637-1641 | 单路搜索（BM25 或向量）的结果条目 |
| `MultiGetResult` | `src/store.ts` | L1701-1708 | 批量获取文档的返回结构 |

### DocumentResult

```ts
// 文件: src/store.ts L1543-1554
interface DocumentResult {
  docid: string;          // 文档唯一标识（虚拟路径）
  filepath: string;       // 文件系统路径
  title: string;          // 文档标题
  hash: string;           // 内容哈希
  body: string;           // 文档正文
  collection: string;     // 所属集合名
  active: boolean;        // 是否活跃（未被删除）
  created_at: string;     // 创建时间
  updated_at: string;     // 更新时间
}
```

### DocumentNotFound

```ts
// 文件: src/store.ts L1692-1696
interface DocumentNotFound {
  docid: string;          // 请求的文档标识
  found: false;           // 固定为 false
  error: string;          // 错误描述
}
```

### SearchResult

```ts
// 文件: src/store.ts L1637-1641
interface SearchResult {
  docid: string;          // 文档唯一标识
  score: number;          // 归一化后的分数 [0, 1)
  filepath: string;       // 文件系统路径
  title: string;          // 文档标题
}
```

### MultiGetResult

```ts
// 文件: src/store.ts L1701-1708
interface MultiGetResult {
  results: DocumentResult[];      // 成功获取的文档列表
  notFound: DocumentNotFound[];   // 未找到的文档列表
  total: number;                  // 请求的文档总数
  found: number;                  // 成功找到的数量
}
```

## 搜索类型

搜索类型是 qmd 最核心的类型族，覆盖了查询扩展、混合搜索、RRF 融合排序和结果追踪的完整链条。

| 类型名 | 源文件 | 行号 | 说明 |
|-------|--------|:----:|------|
| `ExpandedQuery` | `src/store.ts` | L242-247 | 查询扩展结果，含类型和扩展后的查询字符串 |
| `HybridQueryResult` | `src/store.ts` | L3680-3691 | 混合查询的完整返回结构 |
| `HybridQueryExplain` | `src/store.ts` | L1673-1687 | 查询解释信息，用于调试和可视化 |
| `HybridQueryOptions` | `src/store.ts` | L3669-3678 | 混合查询的可选参数 |
| `RankedResult` | `src/store.ts` | L1646-1652 | RRF 融合后的排序结果条目 |
| `RRFContributionTrace` | `src/store.ts` | L1654-1663 | 单路搜索对 RRF 融合的贡献追踪 |
| `RRFScoreTrace` | `src/store.ts` | L1665-1671 | RRF 总分的追踪信息 |
| `SnippetResult` | `src/store.ts` | L3512-3518 | 搜索结果中的文本片段 |

### ExpandedQuery

查询扩展的输出，`type` 字段标识扩展策略。`lex` 表示词汇扩展（添加同义词关键词），`vec` 表示语义扩展（用于向量检索），`hyde` 表示 Hypothetical Document Embedding。

```ts
// 文件: src/store.ts L242-247
interface ExpandedQuery {
  type: 'lex' | 'vec' | 'hyde';  // 扩展类型
  query: string;                   // 扩展后的查询字符串
}
```

### HybridQueryOptions

```ts
// 文件: src/store.ts L3669-3678
interface HybridQueryOptions {
  limit?: number;            // 返回结果数上限，默认 10
  explain?: boolean;         // 是否返回详细的评分追踪
  rerank?: boolean;          // 是否启用 LLM 重排序
  expand?: boolean;          // 是否启用查询扩展
  collections?: string[];    // 限定搜索的集合列表
  threshold?: number;        // 最低分数阈值
}
```

### HybridQueryResult

```ts
// 文件: src/store.ts L3680-3691
interface HybridQueryResult {
  results: RankedResult[];            // RRF 融合排序后的结果列表
  explain?: HybridQueryExplain;       // 可选的详细解释信息
  expandedQueries: ExpandedQuery[];   // 扩展后的查询列表
  totalFTS: number;                   // BM25 检索的原始命中数
  totalVec: number;                   // 向量检索的原始命中数
  timings: {                          // 各阶段耗时（毫秒）
    fts: number;
    vec: number;
    rerank?: number;
    expand?: number;
    total: number;
  };
}
```

### HybridQueryExplain

```ts
// 文件: src/store.ts L1673-1687
interface HybridQueryExplain {
  ftsResults: SearchResult[];           // BM25 原始结果
  vecResults: SearchResult[];           // 向量搜索原始结果
  rrfScores: RRFScoreTrace[];          // 每个文档的 RRF 评分追踪
  expandedQueries: ExpandedQuery[];     // 使用的扩展查询
  rerankOrder?: string[];               // 重排序后的 docid 顺序
  strongSignals?: SearchResult[];       // 强信号匹配结果
}
```

### RankedResult

```ts
// 文件: src/store.ts L1646-1652
interface RankedResult {
  docid: string;              // 文档唯一标识
  score: number;              // RRF 融合后的最终分数
  filepath: string;           // 文件系统路径
  title: string;              // 文档标题
  snippet?: string;           // 可选的匹配文本片段
}
```

### RRFContributionTrace

追踪单路搜索（BM25 或向量）对最终 RRF 分数的贡献。`source` 标识来源，`rank` 是该路中的排名，`contribution` 是根据 `1/(k + rank)` 计算的贡献值。

```ts
// 文件: src/store.ts L1654-1663
interface RRFContributionTrace {
  source: 'fts' | 'vec';     // 搜索来源
  rank: number;               // 在该路搜索中的排名（从 1 开始）
  score: number;              // 原始搜索分数
  contribution: number;       // 对 RRF 总分的贡献值
  query: string;              // 使用的查询字符串
}
```

### RRFScoreTrace

```ts
// 文件: src/store.ts L1665-1671
interface RRFScoreTrace {
  docid: string;                          // 文档标识
  totalScore: number;                     // RRF 总分
  contributions: RRFContributionTrace[];  // 各路贡献详情
}
```

### SnippetResult

```ts
// 文件: src/store.ts L3512-3518
interface SnippetResult {
  text: string;               // 片段文本内容
  chunkIndex: number;         // 来自哪个分块
  score: number;              // 片段相关性分数
  highlights: [number, number][];  // 高亮区间列表 [start, end]
}
```

## 集合类型

集合类型定义了 qmd 的多知识库管理能力，通过 YAML 配置文件驱动。

| 类型名 | 源文件 | 行号 | 说明 |
|-------|--------|:----:|------|
| `Collection` | `src/collections.ts` | L27-34 | 集合的完整定义，含路径、过滤规则等 |
| `CollectionConfig` | `src/collections.ts` | L39-42 | YAML 文件解析后的配置结构 |
| `NamedCollection` | `src/collections.ts` | L47-49 | 带名称的集合引用 |
| `ContextMap` | `src/collections.ts` | L22 | 路径前缀到集合的映射表 |

### Collection

```ts
// 文件: src/collections.ts L27-34
interface Collection {
  name: string;             // 集合名称
  basePath: string;         // 基础目录路径
  include: string[];        // 包含的 glob 模式列表
  exclude: string[];        // 排除的 glob 模式列表
  recursive: boolean;       // 是否递归扫描子目录
  context?: string;         // 可选的上下文描述
}
```

### CollectionConfig

```ts
// 文件: src/collections.ts L39-42
interface CollectionConfig {
  collections: NamedCollection[];   // 命名集合列表
  contextMap?: ContextMap;          // 可选的上下文映射
}
```

### NamedCollection

```ts
// 文件: src/collections.ts L47-49
interface NamedCollection {
  name: string;              // 集合的唯一名称
  collection: Collection;    // 对应的集合定义
}
```

### ContextMap

`ContextMap` 是一个简单的字典类型，将路径前缀映射到上下文字符串。当文档路径匹配某个前缀时，对应的上下文会被注入到搜索过程中，用于提升相关性。

```ts
// 文件: src/collections.ts L22
type ContextMap = Record<string, string>;
```

## 索引类型

索引类型用于监控和管理 qmd 的文档索引状态。

| 类型名 | 源文件 | 行号 | 说明 |
|-------|--------|:----:|------|
| `IndexStatus` | `src/store.ts` | L1718-1723 | 索引的整体状态快照 |
| `IndexHealthInfo` | `src/store.ts` | L1739-1743 | 索引的健康度指标 |
| `ReindexResult` | `src/store.ts` | L1066-1072 | 重新索引操作的结果统计 |
| `EmbedResult` | `src/store.ts` | L1188-1193 | 单次嵌入操作的结果 |

### IndexStatus

```ts
// 文件: src/store.ts L1718-1723
interface IndexStatus {
  totalDocuments: number;       // 已索引的文档总数
  totalChunks: number;          // 分块总数
  totalVectors: number;         // 向量总数
  pendingEmbeddings: number;    // 等待生成嵌入的分块数
  collections: string[];        // 已注册的集合列表
}
```

### IndexHealthInfo

```ts
// 文件: src/store.ts L1739-1743
interface IndexHealthInfo {
  orphanedVectors: number;    // 孤立向量数（对应文档已删除）
  missingVectors: number;     // 缺失向量数（分块未生成嵌入）
  staleDocuments: number;     // 过期文档数（内容已变更但未重新索引）
  healthy: boolean;           // 综合健康状态
}
```

### ReindexResult

```ts
// 文件: src/store.ts L1066-1072
interface ReindexResult {
  indexed: number;          // 新索引的文档数
  updated: number;          // 更新的文档数
  removed: number;          // 移除的文档数
  embedded: number;         // 新生成嵌入的分块数
  errors: string[];         // 错误信息列表
}
```

### EmbedResult

```ts
// 文件: src/store.ts L1188-1193
interface EmbedResult {
  hash: string;             // 文档内容哈希
  chunkIndex: number;       // 分块序号
  dimension: number;        // 嵌入向量维度
  elapsed: number;          // 耗时（毫秒）
}
```

## 分块类型

分块类型定义了智能分块算法使用的数据结构。

| 类型名 | 源文件 | 行号 | 说明 |
|-------|--------|:----:|------|
| `BreakPoint` | `src/store.ts` | L76-80 | 分块断点，记录位置、类型和权重 |
| `CodeFenceRegion` | `src/store.ts` | L86-89 | 代码围栏区域，标记不可切割的范围 |

### BreakPoint

`BreakPoint` 是智能分块算法的核心数据结构。`findBestCutoff()` 函数在搜索窗口内扫描所有断点，用 `weight` 乘以距离衰减系数 `1.0 - (distance/window)^2 * 0.7` 来选择最佳切割位置。

```ts
// 文件: src/store.ts L76-80
interface BreakPoint {
  pos: number;              // 断点在文本中的字符位置
  type: string;             // 断点类型：'h1'-'h6'、'fence'、'paragraph'
  weight: number;           // 权重：H1=100, H2=90, ..., fence=80, paragraph=20
}
```

### CodeFenceRegion

代码围栏区域标记了 Markdown 中以 `` ``` `` 包围的代码块范围。分块算法在选择切割点时会跳过这些区域内部的位置，确保代码块的完整性。

```ts
// 文件: src/store.ts L86-89
interface CodeFenceRegion {
  start: number;            // 代码块起始位置（含开头的 ```）
  end: number;              // 代码块结束位置（含结尾的 ```）
}
```

## 数据库类型

数据库类型定义了跨运行时的 SQLite 抽象接口。

| 类型名 | 源文件 | 行号 | 说明 |
|-------|--------|:----:|------|
| `Database` | `src/db.ts` | L68-73 | 统一的数据库接口，兼容 Bun 和 Node.js |
| `Statement` | `src/db.ts` | L75-78 | 预编译 SQL 语句的接口 |

### Database

`Database` 接口抹平了 `bun:sqlite` 和 `better-sqlite3` 之间的 API 差异。上层代码（如 `src/store.ts`）只依赖这个接口，不直接引用任何运行时特定的 SQLite 库。

```ts
// 文件: src/db.ts L68-73
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
  loadExtension(path: string): void;
  transaction<T>(fn: () => T): () => T;
}
```

### Statement

```ts
// 文件: src/db.ts L75-78
interface Statement {
  run(...params: any[]): void;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}
```

## 类型关系速览

下表展示核心类型之间的引用关系。

| 调用方 | 返回类型 | 说明 |
|-------|---------|------|
| `Store.hybridQuery()` | `HybridQueryResult` | 包含 `RankedResult[]` 和可选的 `HybridQueryExplain` |
| `Store.searchFTS()` | `SearchResult[]` | BM25 单路搜索结果 |
| `Store.searchVec()` | `SearchResult[]` | 向量单路搜索结果 |
| `Store.get()` | `DocumentResult \| DocumentNotFound` | 联合类型，通过 `found` 字段区分 |
| `Store.multiGet()` | `MultiGetResult` | 内含 `DocumentResult[]` 和 `DocumentNotFound[]` |
| `Store.reindex()` | `ReindexResult` | 重索引操作统计 |
| `Store.indexStatus()` | `IndexStatus` | 索引快照 |
| `Store.indexHealth()` | `IndexHealthInfo` | 健康度指标 |
| `HybridQueryExplain.rrfScores` | `RRFScoreTrace[]` | 每项内含 `RRFContributionTrace[]` |
| `HybridQueryResult.results` | `RankedResult[]` | 最终排序结果，可含 `snippet` |
