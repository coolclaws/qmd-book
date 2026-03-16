## 第 12 章：SDK 与库模式

> qmd 不仅是一个命令行工具，更是一个可嵌入的 TypeScript 库。`src/index.ts` 作为公共 API 的唯一入口，通过精心设计的 `QMDStore` 接口和 `createStore()` 工厂函数，将底层的 SQLite 数据库、向量索引、LLM 推理等复杂子系统封装成一套简洁而强大的编程接口。本章将深入解析 SDK 的设计哲学、接口契约以及双写架构的工程考量。

### QMDStore 接口：公共 API 契约

`src/index.ts` 全文 528 行，其中 `QMDStore` 接口定义在第 212 至 306 行，是整个 SDK 对外暴露的核心类型。这个接口按照职责划分为七个功能组，每一组都代表了 qmd 的一项核心能力。

第一组是搜索能力。`search()` 是统一的搜索入口，`searchLex()` 专门执行 BM25 词法搜索，`searchVector()` 执行纯向量语义搜索，而 `expandQuery()` 则负责将用户的自然语言查询扩展为结构化的多维查询。这四个方法构成了从简单关键词匹配到深度语义理解的完整搜索梯度。

第二组是文档检索。`get()` 通过路径或文档 ID 获取单个文档，`getDocumentBody()` 返回文档的完整内容，`multiGet()` 支持批量检索。这一组方法的设计体现了"精确获取"与"批量获取"的区分——前者适用于已知目标的场景，后者适用于 glob 模式匹配或列表式访问。

第三组是集合管理。`addCollection()` 添加新的文件集合，`removeCollection()` 删除集合，`renameCollection()` 重命名，`listCollections()` 列出所有集合。集合是 qmd 的核心组织单位，每个集合对应文件系统上的一个目录及其匹配模式。

第四组是上下文管理。`addContext()` 和 `removeContext()` 操作单个集合的上下文描述，`setGlobalContext()` 设置全局上下文，`listContexts()` 列出所有上下文。上下文为 LLM 提供领域知识，使查询扩展更加精准。

第五组是索引操作。`update()` 重新扫描文件系统并更新索引，`embed()` 为文档生成向量嵌入。这两个方法是保持索引与源文件同步的关键手段。

第六组是健康检查。`getStatus()` 返回存储的整体状态，`getIndexHealth()` 提供索引的详细健康信息，包括过期文档数、缺失嵌入数等指标。

第七组是生命周期管理。`close()` 方法负责关闭数据库连接、释放 LLM 资源、清理临时文件。这个方法的存在提醒调用者：`QMDStore` 持有系统资源，必须在使用完毕后显式释放。

### createStore() 工厂函数

`createStore()` 定义在第 333 至 528 行，是创建 `QMDStore` 实例的唯一正确方式。它接收一个 `StoreOptions` 参数对象，其中 `dbPath` 是唯一必填字段，指向 SQLite 数据库文件的路径。

配置方面，`createStore()` 支持三种互斥的模式。第一种是 YAML 文件模式：传入 `configPath` 指向一个 `.qmd.yml` 文件，工厂函数会解析该文件并据此初始化集合与上下文。第二种是内联配置模式：传入 `config` 对象，直接在代码中声明集合定义。第三种是纯数据库模式：既不传 `configPath` 也不传 `config`，此时 qmd 仅依赖 SQLite 中已有的元数据。值得注意的是，`configPath` 和 `config` 不可同时提供，工厂函数会在运行时校验这一约束。

在内部实现上，`createStore()` 首先调用 `createStoreInternal()` 打开数据库并创建必要的表结构。随后，它为该 store 实例创建一个独立的 `LlamaCpp` 实例，配置了 5 分钟的不活跃超时——如果 5 分钟内没有任何推理请求，LLM 模型会被自动卸载以释放内存。这个设计避免了全局单例模式的弊端：每个 store 拥有独立的 LLM 生命周期，互不干扰。工厂函数通过设置 `internal.llm` 将 LLM 实例绑定到 store 作用域。

下面是一个典型的 SDK 使用示例：

```typescript
const store = await createStore({
  dbPath: './index.sqlite',
  config: {
    collections: {
      docs: { path: '/path', pattern: '**/*.md' }
    }
  }
})
const results = await store.search({ query: "auth" })
await store.close()
```

这段代码展示了 SDK 的完整生命周期：创建、使用、关闭。内联配置模式免除了对外部 YAML 文件的依赖，非常适合嵌入式场景。

### search() 方法：统一搜索入口

`search()` 方法定义在第 374 至 406 行，是 SDK 中使用频率最高的 API。它的设计体现了"简单调用，复杂内部"的原则。

调用者可以传入两种形式的参数。第一种是传入 `query` 字符串，此时 `search()` 会先调用 `expandQuery()` 将自然语言查询自动扩展为多个子查询（包含词法变体、语义近义词、HyDE 假设文档等），然后路由到 `hybridQuery()` 执行混合检索。第二种是传入预先构建好的 `queries`（`ExpandedQuery[]` 数组），此时直接路由到 `structuredSearch()` 执行结构化搜索，跳过查询扩展步骤。

这种双模式设计既照顾了"开箱即用"的简单场景，也支持高级用户对搜索过程的精细控制。例如，MCP 服务器在处理 LLM 的搜索请求时，通常会传入预扩展的查询数组以避免二次 LLM 调用。

### update() 方法：索引更新

`update()` 方法定义在第 470 至 501 行，负责将文件系统的变更同步到索引中。它遍历所有已注册的集合，对每个集合调用 `reindexCollection()`，扫描文件系统、检测新增和修改的文件、更新 SQLite 中的文档记录。方法返回聚合后的统计信息，包括新增文档数、更新文档数和删除文档数。

### 双写架构

qmd SDK 最具特色的设计之一是其双写架构。当调用集合或上下文的变更方法时，数据会同时写入两个目标：SQLite 数据库和 YAML 配置文件（或内联配置对象）。

以 `addCollection()` 为例，它内部会先调用 `upsertStoreCollection(db)` 将集合信息持久化到 SQLite 的 `store_collections` 表中，然后调用 `collectionsAddCollection(yaml)` 将同样的信息写回 YAML 配置文件。这种双写确保了两个数据源始终保持一致。

这个设计的工程动机在于 qmd 的双重身份。作为 CLI 工具，YAML 文件是用户编辑配置的主要界面，它必须反映最新状态。作为 SDK/库，SQLite 数据库必须自包含，不依赖外部配置文件即可独立运行。双写架构让两种使用模式都能获得一致的数据视图。

需要注意的是，在纯数据库模式下（不传 `configPath` 也不传 `config`），双写退化为单写——仅写入 SQLite。这意味着纯 SDK 用户不需要关心 YAML 文件的存在。

### 再导出与模块边界

`src/index.ts` 末尾还通过 re-export 暴露了一系列实用函数和类型。`extractSnippet` 用于从文档中提取搜索结果的代码片段，`addLineNumbers` 为文本添加行号前缀，`Maintenance` 类提供数据库维护操作，`getDefaultDbPath` 返回平台相关的默认数据库路径。所有公共类型也通过此文件统一导出。

这种"单入口"的模块设计意味着外部消费者只需 `import { createStore } from 'qmd'` 即可获取所有能力，无需了解内部的模块划分。`src/index.ts` 充当了一道稳定的 API 边界——内部重构不会影响外部调用者，只要接口契约不变。

### 本章小结

本章深入分析了 `src/index.ts` 这个 528 行的 SDK 入口文件。`QMDStore` 接口将 qmd 的全部能力组织为七个功能组，提供了从搜索检索到生命周期管理的完整 API 契约。`createStore()` 工厂函数支持三种配置模式，为不同使用场景提供灵活性，同时通过 store 作用域的 LLM 实例避免了全局状态污染。双写架构是连接 CLI 与 SDK 两种使用模式的关键设计决策，它确保 YAML 配置与 SQLite 数据库始终保持同步。最后，单入口的再导出策略为外部消费者提供了稳定而简洁的模块接口。
