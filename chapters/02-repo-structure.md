# 第 2 章：仓库结构与构建

> 理解一个项目的目录结构，就像阅读一栋建筑的平面图——它不会告诉你房间里发生了什么，但会清晰地揭示空间之间的关系和设计者的意图。qmd 的仓库结构精炼而层次分明，约 12,000 行 TypeScript 代码被组织在不到 20 个源文件中，每个文件都有明确的单一职责。本章将逐层拆解这个结构，从根目录的构建配置到 `src/` 下的模块划分，再到双运行时支持的工程细节。

## 仓库目录总览

### 顶层结构

qmd 仓库的顶层目录清晰地分为源码、构建产物、测试、脚本和文档五个区域：

```
qmd/
├── src/                    # TypeScript 源码
│   ├── cli/                # 命令行界面
│   │   ├── qmd.ts          # CLI 入口，所有命令定义
│   │   └── formatter.ts    # 输出格式化（JSON/CSV/XML/MD）
│   ├── mcp/                # Model Context Protocol 服务器
│   │   └── server.ts       # MCP 工具注册与传输层
│   ├── store.ts            # 核心：数据库初始化、搜索、分块、RRF
│   ├── llm.ts              # LLM 抽象层（node-llama-cpp）
│   ├── index.ts            # SDK 公开 API（QMDStore）
│   ├── collections.ts      # YAML 集合配置管理
│   ├── db.ts               # 跨运行时 SQLite 兼容层
│   ├── maintenance.ts      # 数据库清理操作
│   └── embedded-skills.ts  # 内置 Claude 技能定义
├── bin/qmd                 # 运行时感知的启动脚本
├── test/                   # Vitest 测试文件
├── finetune/               # 模型微调（Python）
├── scripts/                # 发布与 Git Hook 脚本
├── docs/SYNTAX.md          # 查询语法规范
├── package.json            # 包配置与依赖声明
├── tsconfig.json           # TypeScript 基础配置
└── tsconfig.build.json     # 构建专用 TypeScript 配置
```

这种结构遵循了 TypeScript 项目的常见惯例，但有几个值得注意的设计选择：`src/` 下没有过度嵌套的子目录，核心逻辑直接放在顶层；`cli/` 和 `mcp/` 作为两个接口层被独立出来；`finetune/` 目录表明项目包含了模型训练管线，这在典型的 TypeScript 项目中并不常见。

### 源码文件规模

各文件的代码行数反映了职责的轻重：

| 文件 | 行数 | 核心职责 |
|-----|------|---------|
| `src/store.ts` | ~4,379 | 数据库、搜索、索引、分块 |
| `src/cli/qmd.ts` | ~3,187 | CLI 命令解析与执行 |
| `src/llm.ts` | ~1,546 | 模型加载、嵌入、生成、重排序 |
| `src/mcp/server.ts` | ~807 | MCP 协议实现 |
| `src/index.ts` | ~528 | SDK 公开接口 |
| `src/collections.ts` | ~500 | 集合配置读写 |
| `src/cli/formatter.ts` | ~430 | 输出格式化 |
| `src/db.ts` | ~96 | SQLite 运行时抽象 |
| `src/maintenance.ts` | ~54 | 数据库维护 |

`store.ts` 以超过 4,000 行的体量占据了项目的三分之一以上，这并非设计失误——它是所有搜索和索引逻辑的归集点，将 SQL 操作、分块算法、RRF 融合和文件系统扫描内聚在一处，避免了跨文件调用的复杂性。

## 核心模块详解

### store.ts：搜索与索引的心脏

`src/store.ts` 是整个项目中最重要的文件。它的 `createStore()` 函数（第 1688 行）是所有功能的入口点，返回一个包含完整搜索和索引能力的 Store 对象。

文件内部的逻辑可以分为四个主要区域。第一部分是数据库初始化，在第 709-764 行定义了所有 SQL 表结构——`content`、`documents`、`documents_fts`、`content_vectors` 以及 `vectors_vec` 虚拟表。第二部分是分块引擎，`scanBreakPoints()`（第 333 行）扫描 Markdown 结构断点，`findBestCutoff()`（第 384 行）用衰减函数选择最优切割位置。第三部分是搜索实现，`searchFTS()`（第 2294 行）和 `searchVec()`（第 2346 行）分别执行 BM25 和向量检索。第四部分是索引管线，`reindexCollection()`（第 1451 行）扫描文件系统并更新数据库，`generateEmbeddings()`（第 1588 行）批量生成向量嵌入。

### llm.ts：本地模型管理

`src/llm.ts` 的 `LlamaCpp` 类（第 235 行）封装了与 node-llama-cpp 的全部交互。它管理三种模型的生命周期：嵌入模型、生成模型（用于查询扩展）和重排序模型。

模型通过 HuggingFace URI 引用，例如 `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`（第 172 行）。`resolveModelFile()` 函数（第 281 行）负责将 URI 解析为本地路径，首次调用时自动从 HuggingFace 下载。加载后的模型实例被缓存（第 255-261 行），设有 5 分钟不活跃超时自动卸载机制，在响应速度和内存占用之间取得平衡。

核心方法包括：`embed()` 和 `embedBatch()`（第 501、525 行）用于向量嵌入，`generate()`（第 595 行）用于查询扩展文本生成（温度 0.7，topK 20，topP 0.8），`rerank()`（第 733 行）对候选文档进行重排序，`expandQuery()`（第 644 行）通过语法约束输出将用户查询扩展为多种检索策略。

### index.ts：SDK 公开接口

`src/index.ts` 是 qmd 作为 npm 库时的入口文件。它导出 `createStore()` 工厂函数（第 334 行），返回 `QMDStore` 接口（第 240-312 行定义），提供搜索、检索、集合管理和索引四类方法。

SDK 的设计理念是"零配置即可用"。`StoreOptions`（第 230-237 行）中所有参数都有合理默认值——数据库路径默认为 `~/.local/share/qmd/qmd.db`，模型 URI 使用内置默认值。调用方只需 `const store = await createStore()` 即可获得完整的搜索能力。

### collections.ts：YAML 配置管理

`src/collections.ts` 管理集合（Collection）的配置持久化。qmd 支持两种配置源：文件模式（默认 `~/.config/qmd/index.yml`）和内存模式（供 SDK 使用），通过 `setConfigSource()`（第 40 行）切换。

一个典型的集合配置文件如下：

```yaml
global_context: "个人技术笔记库"
collections:
  notes:
    path: "/Users/me/notes"
    pattern: "**/*.md"
    ignore: ["drafts/**", ".obsidian/**"]
    context:
      "/": "包含编程、架构和工具笔记"
      "/2026": "2026 年的学习记录"
    includeByDefault: true
```

`findContextForPath()`（第 315 行）使用最长前缀匹配算法为每个文件路径找到最具体的上下文描述，这些上下文信息会被注入到 MCP 服务器的系统提示中，帮助 AI Agent 更好地理解知识库的结构。

### mcp/server.ts：AI Agent 接口

`src/mcp/server.ts` 的 `createMcpServer()` 函数（第 130 行）注册了四个 MCP 工具：`query`（混合搜索）、`get`（单文档检索）、`multi_get`（批量检索）和 `status`（索引状态查询）。`buildInstructions()`（第 85 行）根据当前索引状态动态生成系统提示，包含集合列表、上下文信息和查询语法说明。

`startMcpHttpServer()`（第 470 行）启动 HTTP 传输模式时，除了标准 MCP 端点 `POST /mcp` 外，还额外提供了 `POST /query` REST 接口和 `GET /health` 健康检查端点——这使得非 MCP 客户端也能直接调用搜索功能。

### db.ts：跨运行时兼容层

`src/db.ts` 虽然只有约 96 行，却解决了一个关键的工程问题：让同一份代码同时运行在 Node.js 和 Bun 两个运行时上。

文件的核心逻辑是运行时检测：通过 `typeof globalThis.Bun !== "undefined"` 判断当前环境。在 Node.js 下使用 better-sqlite3 驱动，在 Bun 下使用内置的 `bun:sqlite`。

但真正棘手的是 macOS 上的 SQLite 扩展加载问题。Apple 系统自带的 SQLite 编译时启用了 `SQLITE_OMIT_LOAD_EXTENSION`，导致无法加载 sqlite-vec 扩展。`db.ts` 通过 `Database.setCustomSQLite()` 方法将 SQLite 实现切换为 Homebrew 安装的完整版本，同时检查 Apple Silicon（`/opt/homebrew/opt/sqlite/lib`）和 Intel（`/usr/local/opt/sqlite/lib`）两个路径。

当 sqlite-vec 加载失败时，系统不会崩溃，而是输出针对具体平台的安装指引，优雅降级为仅支持 BM25 搜索。

### maintenance.ts：数据库维护

`src/maintenance.ts` 是项目中最小的模块，仅约 54 行。`Maintenance` 类（第 13 行）封装了六个数据库清理操作：`vacuum()` 压缩数据库文件（第 19 行），`cleanupOrphanedContent()` 清理无引用的内容行（第 24 行），`cleanupOrphanedVectors()` 清理孤立向量（第 29 行），`clearLLMCache()` 清除查询扩展和重排序的缓存（第 34 行），`deleteInactiveDocs()` 删除已从文件系统移除的文档记录（第 39 行），`clearEmbeddings()` 强制重新生成所有嵌入（第 44 行）。

这些操作通过 CLI 的 `cleanup` 命令暴露给用户。

## 构建系统

### TypeScript 编译配置

qmd 使用 `tsc` 进行编译，构建配置定义在 `tsconfig.build.json` 中：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "declaration": true,
    "noImplicitAny": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "src/test-preload.ts", "src/bench-*.ts"]
}
```

构建脚本（`package.json` 中的 `build` 命令）除了运行 `tsc` 外，还会为 CLI 入口文件 `dist/cli/qmd.js` 添加 `#!/usr/bin/env node` shebang 行并设置可执行权限。这个后处理步骤是必要的，因为 TypeScript 编译器不会保留源文件中的 shebang 注释。

### bin/qmd 启动脚本

`bin/qmd` 是一个 Shell 脚本，它解决了双运行时环境下的 ABI 兼容性问题。脚本的执行流程分为三步。

首先，它通过循环 `readlink` 解析符号链接，找到真实的包安装目录——这对 `npm link` 和全局安装的场景至关重要。然后，它检测安装时使用的包管理器：如果存在 `package-lock.json` 则使用 Node.js，如果存在 `bun.lock` 或 `bun.lockb` 则使用 Bun，否则默认 Node.js。最后，用检测到的运行时执行 `dist/cli/qmd.js`。

这个设计的关键洞察是：判断运行时不能看系统上是否安装了 Bun（`$BUN_INSTALL` 环境变量），而要看安装依赖时用了哪个包管理器。因为 better-sqlite3 和 sqlite-vec 包含原生 C/C++ 扩展，用 Bun 编译的 `.node` 文件无法在 Node.js 中加载，反之亦然。

### 包发布配置

`package.json` 中的发布配置体现了 qmd 作为 npm 库的双重身份：

```json
{
  "name": "@tobilu/qmd",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "bin": { "qmd": "bin/qmd" },
  "engines": { "node": ">=22.0.0" },
  "files": ["bin/", "dist/", "LICENSE", "CHANGELOG.md"]
}
```

`exports` 字段指定了 ESM 模块入口，`bin` 字段注册了命令行工具，`files` 字段精确控制了发布到 npm 的文件范围——只包含 `bin/`、`dist/`、LICENSE 和 CHANGELOG，源码和测试不会进入发布包。`engines` 要求 Node.js >= 22.0.0，这是因为项目使用了 `util.parseArgs()` 等较新的 API。

## 测试与持续集成

### 测试框架

qmd 使用 Vitest 作为测试框架，测试文件存放在 `test/` 目录下。运行命令为 `vitest run --reporter=verbose test/`。`tsconfig.build.json` 中明确排除了 `src/**/*.test.ts`、`src/test-preload.ts` 和 `src/bench-*.ts`，确保测试代码不会混入构建产物。

### CI 管线

项目在 `.github/workflows/` 下配置了两条 GitHub Actions 工作流：`ci.yml` 负责每次提交的自动化测试，`publish.yml` 负责发布到 npm。发布脚本 `scripts/release.sh` 与 Git Hooks（通过 `scripts/install-hooks.sh` 安装，在 `prepare` 生命周期自动执行）共同确保代码质量。

## 开发工作流

`package.json` 中定义了多个便捷脚本，支持快速开发迭代：

| 脚本 | 命令 | 用途 |
|-----|------|------|
| `npm run qmd` | `tsx src/cli/qmd.ts` | 直接运行源码（无需编译） |
| `npm run search` | `tsx src/cli/qmd.ts search` | 快速执行 BM25 搜索 |
| `npm run vsearch` | `tsx src/cli/qmd.ts vsearch` | 快速执行向量搜索 |
| `npm run inspector` | `npx @modelcontextprotocol/inspector ...` | MCP 协议调试 |
| `npm run build` | `tsc -p tsconfig.build.json + shebang` | 生产构建 |
| `npm run test` | `vitest run --reporter=verbose` | 运行测试套件 |

开发时使用 `tsx`（TypeScript Execute）直接运行源文件，省去了编译步骤。`inspector` 脚本启动 MCP Inspector 调试工具，方便测试 MCP 服务器的工具注册和响应。

## 本章小结

qmd 的仓库结构遵循了"少文件、高内聚"的设计原则。核心逻辑集中在 `src/store.ts`（搜索与索引）、`src/llm.ts`（模型管理）和 `src/cli/qmd.ts`（命令行界面）三个文件中，辅以 `src/db.ts` 的跨运行时兼容层和 `src/collections.ts` 的配置管理。构建系统基于标准 `tsc` 编译，通过 `bin/qmd` 启动脚本解决了 Node.js 与 Bun 双运行时下原生扩展的 ABI 兼容问题。`package.json` 同时配置了库入口（`exports`）和命令行入口（`bin`），使项目既可作为 npm 包被引用，也可作为全局工具直接使用。理解了这些结构关系，后续深入每个模块的实现细节时就不会迷失方向。
