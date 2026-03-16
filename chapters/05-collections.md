# 第 5 章：集合与上下文管理

> 文档分散在文件系统各处——笔记在 `~/notes`，项目文档在 `~/projects/*/docs`，论文在 `~/papers`。qmd 的集合（Collection）系统将这些分散的目录统一纳入管理，而上下文（Context）机制则为每个路径前缀附加语义描述，帮助 LLM 重排序器理解文档的类别与用途。本章深入分析 `src/collections.ts` 和 `src/store.ts` 中集合与上下文的完整实现。

## 类型定义

### 核心数据结构

`src/collections.ts` 在文件顶部定义了集合系统的所有类型：

```ts
// 文件: src/collections.ts L27-34
interface Collection {
  path: string;
  pattern: string;
  ignore?: string[];
  context?: ContextMap;
  update?: string;
  includeByDefault?: boolean;
}
```

`Collection` 接口描述了一个集合的完整配置。`path` 是集合对应的文件系统目录，`pattern` 是 glob 模式（如 `**/*.md`）用于匹配该目录下需要索引的文件。`ignore` 数组定义排除模式。`context` 是路径前缀到语义描述的映射——这是本章的重点。`update` 是可选的命令字符串，在索引前执行以更新源文件（例如 `git pull`）。`includeByDefault` 控制该集合是否默认参与搜索查询。

上下文映射的类型极其简洁：

```ts
// 文件: src/collections.ts（类型定义区域）
type ContextMap = Record<string, string>;
```

键是路径前缀（如 `"/meetings"`、`"/projects/alpha"`），值是该前缀下文档的语义描述文本。

配置的顶层结构由 `CollectionConfig` 定义：

```ts
// 文件: src/collections.ts L39-42
interface CollectionConfig {
  global_context?: string;
  collections: Record<string, Collection>;
}
```

`global_context` 是可选的全局上下文，应用于所有集合中的所有文档。`collections` 是集合名称到集合配置的映射。`NamedCollection` 在 `Collection` 基础上扩展了 `name` 字段，便于在代码中传递时保留集合标识。

## 配置文件

### YAML 格式与 XDG 路径

qmd 的集合配置存储在 `~/.config/qmd/index.yml` 文件中，遵循 XDG Base Directory 规范。如果用户设置了 `XDG_CONFIG_HOME` 环境变量，配置文件路径会相应调整为 `$XDG_CONFIG_HOME/qmd/index.yml`。

一个典型的配置文件示例：

```yaml
global_context: "个人知识库，包含技术笔记、会议记录和研究论文"
collections:
  notes:
    path: ~/notes
    pattern: "**/*.md"
    context:
      "/": "个人笔记与日志"
      "/meetings": "团队周会和一对一会议记录"
      "/research": "技术调研与论文阅读笔记"
  papers:
    path: ~/papers
    pattern: "**/*.pdf"
    includeByDefault: false
```

选择 YAML 而非 JSON 作为配置格式，是因为 YAML 对人类更友好——支持注释、不需要引号包裹键名、缩进表示嵌套层次更直观。对于需要用户手动编辑的配置文件，可读性是最重要的考量。

### loadConfig 与 saveConfig

```ts
// 文件: src/collections.ts（loadConfig 函数）
function loadConfig(): CollectionConfig {
  // 读取 YAML 文件并解析
}
```

`loadConfig()` 读取 YAML 文件并将其解析为 `CollectionConfig` 对象。如果文件不存在，返回一个包含空集合映射的默认配置。`saveConfig()` 执行反向操作，将 `CollectionConfig` 序列化为 YAML 并写入文件。这两个函数是所有集合增删改操作的基础——每次修改都是"读取、修改、写回"三步操作。

## 集合管理函数

### 增删改操作

`src/collections.ts` 导出了一组对集合进行 CRUD 操作的函数：

`addCollection()` 向配置中添加新集合。它接受集合名称和 `Collection` 对象，调用 `loadConfig()` 读取当前配置，添加新集合后调用 `saveConfig()` 写回。如果同名集合已存在，函数会抛出错误而非静默覆盖。

`removeCollection()` 从配置中删除指定集合。它只修改配置文件——数据库中已索引的文档不会立即删除，而是在下一次同步时通过 `active` 标记处理。

`renameCollection()` 重命名集合。这个操作需要同时更新配置文件中的集合键名，以及数据库中 `documents` 表和 `store_collections` 表中的集合名称引用。

### SDK 模式：setConfigSource

```ts
// 文件: src/collections.ts（setConfigSource 函数）
function setConfigSource(config: CollectionConfig): void {
  // 设置内联配置，绕过文件 I/O
}
```

`setConfigSource()` 为 SDK 使用场景提供了一种无需文件系统的配置方式。调用此函数后，`loadConfig()` 不再读取 YAML 文件，而是直接返回内联传入的配置对象。这使得 qmd 可以作为库嵌入到其他应用中，由宿主程序以编程方式提供配置，而无需在文件系统中创建配置文件。

## 上下文系统

### 上下文的用途

上下文是 qmd 搜索质量优化的核心机制之一。当用户执行搜索查询时，qmd 可以使用 LLM 对候选结果进行重排序。重排序器需要理解每篇文档的"类别"和"用途"才能做出更准确的相关性判断。上下文信息正是为此提供的。

例如，用户搜索"React 性能优化"时，一篇存储在 `/meetings/2026-01-15.md` 下的文档可能包含了讨论 React 性能的会议记录。没有上下文时，重排序器只能看到文件路径和文本内容；有了上下文（"团队周会和一对一会议记录"），重排序器能更好地判断这篇文档是会议记录而非技术教程，从而做出更精确的排序决策。

### 添加与移除上下文

```ts
// 文件: src/collections.ts（addContext / removeContext）
function addContext(collection: string, pathPrefix: string, description: string): void;
function removeContext(collection: string, pathPrefix: string): void;
```

`addContext()` 为指定集合的指定路径前缀设置上下文描述。`removeContext()` 移除已有的上下文。两者都是对 YAML 配置的读取-修改-写回操作。路径前缀不需要对应实际存在的目录——它只是一个匹配规则。

### 层次化上下文继承

上下文系统最精妙的设计在于层次化继承。`findContextForPath()` 使用最长前缀匹配算法查找适用于给定路径的上下文：

```ts
// 文件: src/collections.ts（findContextForPath 函数）
function findContextForPath(contexts: ContextMap, filePath: string): string | undefined {
  // 最长前缀匹配
}
```

假设配置了以下上下文：

- `"/"` → "个人笔记"
- `"/projects"` → "项目文档"
- `"/projects/alpha"` → "Alpha 项目的设计文档与 API 规范"

对于路径 `/projects/alpha/api-design.md`，最长匹配前缀是 `"/projects/alpha"`，因此返回"Alpha 项目的设计文档与 API 规范"。

但 `src/store.ts` 中的 `getContextForPath()` 函数采用了更丰富的策略——它收集所有匹配的上下文，从最通用到最具体，用双换行符连接：

```ts
// 文件: src/store.ts L2270-2308
function getContextForPath(collection: string, filePath: string): string {
  // 收集从根到最具体前缀的所有匹配上下文
  // 用 "\n\n" 连接
}
```

这意味着对于上述路径，`getContextForPath()` 返回的不只是最具体的描述，而是三个层级的上下文串联："个人笔记\n\n项目文档\n\nAlpha 项目的设计文档与 API 规范"。这种设计为 LLM 提供了从宏观到微观的完整语境。

全局上下文（`global_context`）应用于所有集合中的所有路径，作为上下文链的最前端。它适合描述整个知识库的总体性质，如"这是一个软件工程师的个人知识库"。

## 双重存储同步

### YAML 与 SQLite 的一致性

集合配置同时存在于两个位置：YAML 文件和 SQLite 数据库的 `store_collections` 表。qmd 需要确保两者的一致性，`syncConfigToDb()` 函数负责这一工作：

```ts
// 文件: src/store.ts L921-955
function syncConfigToDb(): void {
  // 1. 计算当前 YAML 配置的 SHA-256 哈希
  // 2. 与 store_config 中存储的 config_hash 比较
  // 3. 如果相同，跳过同步
  // 4. 如果不同，更新 store_collections 并写入新哈希
}
```

同步策略是"YAML 始终为准"。当 YAML 配置与数据库中的记录不一致时，数据库被更新以匹配 YAML，而非反向。这确保了用户在文本编辑器中对 YAML 文件的修改始终生效。

哈希比较是一个性能优化。如果配置没有变化（哈希相同），整个同步过程被跳过。这避免了每次 CLI 启动时都执行不必要的数据库写操作。哈希算法同样使用 SHA-256，与内容寻址存储保持一致。

### SDK 模式下的同步

在 SDK 模式下（通过 `setConfigSource()` 设置了内联配置），同步机制同样工作——区别仅在于配置来源从 YAML 文件变为内存中的对象。上层同步逻辑无需知道配置的来源，它只关心 `loadConfig()` 返回的数据。

## qmd:// 虚拟路径方案

### 路径抽象

qmd 引入了 `qmd://` 虚拟路径方案，为跨集合的文档引用提供统一的寻址方式：

```
qmd://collection-name/path/to/file.md
```

这个格式类似于 URL，`collection-name` 是集合名称，后面跟着集合内部的相对路径。四个函数组成了虚拟路径的完整操作集：

- `parseVirtualPath(virtualPath)` 将虚拟路径拆分为集合名称和相对路径两部分
- `buildVirtualPath(collection, relativePath)` 将集合名称和相对路径组合为虚拟路径
- `resolveVirtualPath(virtualPath)` 将虚拟路径转换为文件系统中的绝对路径
- `toVirtualPath(absolutePath)` 将绝对路径反向转换为虚拟路径

虚拟路径的存在使得搜索结果的展示与引用不依赖于具体的文件系统位置。用户看到的是 `qmd://notes/meetings/2026-01-15.md` 而非 `/Users/someone/notes/meetings/2026-01-15.md`。这不仅更简洁，还使得数据库可以在不同机器之间迁移——只要集合配置中的路径正确，虚拟路径就能正确解析。

### 在搜索结果中的应用

搜索结果返回虚拟路径而非绝对路径，使得消费端代码可以统一处理来自不同集合的文档。API 用户也可以通过虚拟路径直接获取文档内容，无需知道底层的文件系统布局。这一层抽象在 SDK 模式下尤其重要——嵌入式使用时，宿主程序可能运行在与文档存储完全不同的工作目录中。

## 集合配置的设计考量

### 为什么不自动扫描

一个自然的问题是：为什么需要用户手动配置集合，而不是自动扫描整个文件系统？答案涉及三个方面。

首先是范围控制。自动扫描会索引大量无关文件（`node_modules`、编译产物、二进制文件等），不仅浪费存储和计算资源，还会降低搜索质量。手动配置让用户精确指定哪些目录和哪些文件类型值得索引。

其次是语义标注。自动扫描无法为不同目录赋予语义上下文。用户对自己的文件组织方式最为了解，手动配置上下文信息是不可替代的。

最后是 `update` 命令。某些集合可能需要在索引前执行特定操作（如 `git pull` 拉取最新内容），这类信息只有用户能够提供。

### includeByDefault 的场景

`includeByDefault` 字段控制集合是否默认出现在搜索范围中。将其设为 `false` 的典型场景是低频使用但体量巨大的集合——例如归档的邮件或历史项目文档。这些集合在特定搜索中可能有用，但不应默认污染每次查询的结果。用户可以在搜索时显式指定包含这些集合。

## 本章小结

qmd 的集合系统通过 `Collection` 接口和 YAML 配置文件，将分散在文件系统各处的文档目录纳入统一管理。上下文机制为路径前缀附加层次化的语义描述，支持从根目录到具体子目录的继承式匹配，为 LLM 重排序提供了关键的分类信息。`syncConfigToDb()` 通过 SHA-256 哈希比较实现了 YAML 到 SQLite 的高效单向同步。`qmd://` 虚拟路径方案将文档寻址从物理文件系统中解耦，使得搜索结果和 API 接口不依赖于具体的目录布局。`setConfigSource()` 为 SDK 模式提供了无文件 I/O 的配置注入能力。整套设计在用户可控性与自动化之间取得了平衡——用户定义"索引什么"和"如何理解"，系统负责高效地执行索引与搜索。
