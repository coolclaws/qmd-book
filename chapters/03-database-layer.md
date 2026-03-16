# 第 3 章：数据库抽象层

> qmd 需要同时运行在 Bun 和 Node.js 两个 JavaScript 运行时之上。两者的 SQLite 绑定接口截然不同，且 macOS 系统自带的 SQLite 编译时启用了 `SQLITE_OMIT_LOAD_EXTENSION`，无法加载向量搜索扩展。本章将深入分析 `src/db.ts` 如何用不到一百行代码，把这些平台差异封装成一套统一的数据库抽象层，让上层业务代码完全无需关心底层运行时。

## 运行时检测与动态导入

### 判断当前运行时

`src/db.ts` 的第一个关键设计，是在模块顶部完成运行时检测。检测方式极其简洁——通过检查全局对象上是否存在 `Bun` 属性来判断：

```ts
// 文件: src/db.ts L14
const isBun = typeof globalThis.Bun !== "undefined";
```

这行代码利用了 Bun 运行时向 `globalThis` 注入 `Bun` 命名空间的特性。在 Node.js 环境下，`globalThis.Bun` 为 `undefined`，表达式求值为 `false`。这种检测方式比嗅探 `process.versions` 或检查特定模块是否可用更加可靠，因为它直接探测运行时的标志性特征。

检测结果存储在模块级常量 `isBun` 中，后续所有分支逻辑都依赖这个布尔值。这意味着运行时判断只执行一次，不会在每次打开数据库时重复计算。

### Bun 路径：bun:sqlite 与 Homebrew SQLite

当 `isBun` 为 `true` 时，模块通过动态 `import()` 加载 Bun 内置的 SQLite 模块：

```ts
// 文件: src/db.ts L21-22
const { Database: BunDatabase } = await import("bun:sqlite");
```

Bun 将 SQLite 绑定作为内置模块提供，无需安装额外的 npm 包。但紧接着，代码面对了一个 macOS 特有的难题。

Apple 在 macOS 上预装的系统 SQLite 编译时开启了 `SQLITE_OMIT_LOAD_EXTENSION` 选项。这意味着通过系统 SQLite 库无法调用 `loadExtension()` 来加载 sqlite-vec 向量搜索扩展。qmd 的解决方案是检测 Homebrew 安装的 SQLite，并用它替换 Bun 默认链接的系统库：

```ts
// 文件: src/db.ts L26-36
if (process.platform === "darwin") {
  // 尝试 Homebrew 安装路径
  BunDatabase.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
}
```

`setCustomSQLite()` 是 Bun 提供的 API，允许在运行时替换 SQLite 动态链接库。代码尝试了 `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` 这一 Homebrew 在 Apple Silicon Mac 上的标准安装路径。如果用户通过 Homebrew 安装了 SQLite，这个库文件将支持扩展加载。

这段代码只在 `process.platform === "darwin"` 时执行。在 Linux 上，系统 SQLite 通常没有此限制，无需特殊处理。

### Node.js 路径：better-sqlite3

当 `isBun` 为 `false` 时，模块走 Node.js 分支，导入社区维护的 `better-sqlite3` 包：

```ts
// 文件: src/db.ts L53
const Database = require("better-sqlite3");
```

`better-sqlite3` 是 Node.js 生态中最流行的同步 SQLite 绑定库，其 API 风格与 Bun 内置的 `bun:sqlite` 高度相似——两者都提供 `prepare()`、`exec()` 等方法，且都采用同步调用模型。这种相似性是 qmd 能用极少代码实现跨运行时兼容的基础。

## sqlite-vec 扩展加载

### 启动时的扩展探测

sqlite-vec 是一个 SQLite 扩展，为数据库添加向量搜索能力。qmd 在模块初始化阶段就会尝试加载这个扩展，以确定当前环境是否支持向量搜索：

```ts
// 文件: src/db.ts L42-51
// 在内存数据库中测试 sqlite-vec 是否可用
const testDb = new DatabaseImpl(":memory:");
try {
  testDb.loadExtension(sqliteVecPath);
  _sqliteVecLoad = sqliteVecPath;
} catch {
  _sqliteVecLoad = null;
} finally {
  testDb.close();
}
```

这段代码创建一个临时的内存数据库（`:memory:`），尝试加载 sqlite-vec 扩展。如果加载成功，将扩展路径存储在模块级变量 `_sqliteVecLoad` 中；如果失败，将其设为 `null`。无论成功与否，临时数据库都会被关闭。

使用内存数据库进行测试是一个精妙的设计：它不会产生任何文件系统副作用，即使扩展加载失败也不会影响用户的实际数据库。

### 优雅降级策略

`_sqliteVecLoad` 为 `null` 时，qmd 不会崩溃，而是优雅地降级——向量搜索功能不可用，但基于 BM25 的全文搜索仍然正常工作。这一设计让 qmd 在各种环境下都能运行，即使是编译选项受限的系统 SQLite 也不会阻止用户使用基本的搜索功能。

这种"尽力而为"的策略贯穿了 qmd 的设计哲学：核心功能（文档索引与 BM25 搜索）始终可用，高级功能（向量相似度搜索）在条件允许时自动启用。

## 统一接口设计

### Database 接口

`src/db.ts` 的核心产出是一套跨运行时的统一接口。`Database` 接口定义了上层代码所需的最小方法集：

```ts
// 文件: src/db.ts L68-73
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  loadExtension(path: string): void;
  close(): void;
}
```

四个方法，每一个都不可或缺。`exec()` 用于执行不返回结果的 SQL 语句，如 `CREATE TABLE` 和 `PRAGMA` 设置。`prepare()` 创建预编译语句，是所有参数化查询的入口。`loadExtension()` 用于加载 sqlite-vec 等扩展。`close()` 释放数据库连接和相关资源。

这个接口是 Bun 原生 API 和 better-sqlite3 API 的最大公约数。两个运行时都原生支持这四个方法，无需编写任何适配器代码。

### Statement 接口

预编译语句同样有统一的接口定义：

```ts
// 文件: src/db.ts L75-78
interface Statement {
  run(...params: any[]): any;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}
```

`run()` 执行语句但不返回行数据，适用于 `INSERT`、`UPDATE`、`DELETE` 操作。`get()` 返回第一行结果，适用于 `SELECT` 单条记录。`all()` 返回所有匹配行，适用于 `SELECT` 多条记录。三个方法覆盖了 SQL 操作的全部读写场景。

### openDatabase 工厂函数

有了运行时检测和统一接口，打开数据库的操作被封装为一个极简的工厂函数：

```ts
// 文件: src/db.ts L61-63
function openDatabase(path: string): Database {
  return new DatabaseImpl(path);
}
```

`DatabaseImpl` 在模块初始化阶段已经根据 `isBun` 的值绑定到了正确的实现类。上层代码调用 `openDatabase()` 时，无需传入任何运行时相关的参数，工厂函数自动返回当前环境下正确的数据库实例。

## loadSqliteVec：带平台提示的扩展加载

模块导出的 `loadSqliteVec()` 函数供上层代码在打开实际数据库后加载向量扩展：

```ts
// 文件: src/db.ts L87-96
function loadSqliteVec(db: Database): void {
  if (!_sqliteVecLoad) {
    throw new Error(
      "sqlite-vec not available. " +
      (process.platform === "darwin"
        ? "Try: brew install sqlite"
        : "Ensure sqlite-vec is installed")
    );
  }
  db.loadExtension(_sqliteVecLoad);
}
```

函数首先检查启动时的探测结果。如果 `_sqliteVecLoad` 为 `null`，说明扩展不可用，此时抛出的错误信息会根据平台给出具体的修复建议——macOS 用户会看到 `brew install sqlite` 的提示，因为这是解决系统 SQLite 缺少扩展加载支持的最常见方法。其他平台则给出通用提示。

这种平台感知的错误消息是 CLI 工具用户体验设计的重要细节。用户遇到问题时不会看到晦涩的底层错误，而是直接获得可操作的修复步骤。

## 架构决策与权衡

### 为什么不用 ORM

qmd 选择直接使用 SQLite 绑定而非 ORM（如 Drizzle 或 Prisma），原因有三。首先，qmd 大量使用了 SQLite 特有功能——FTS5 全文搜索、sqlite-vec 向量扩展、`INSERT OR IGNORE` 等，这些在 ORM 中要么不支持，要么需要退回到原始 SQL。其次，直接绑定的性能开销更小，对于需要索引大量文档的 CLI 工具而言，减少抽象层意味着更快的批量操作。最后，`Database` 和 `Statement` 两个接口已经足够简洁，ORM 带来的额外抽象反而增加复杂度。

### sqlite-vec 可选的设计意义

将向量搜索作为可选功能是一个务实的架构决策。BM25 全文搜索依赖 SQLite 内置的 FTS5 模块，在所有平台上都可用。向量搜索需要额外的扩展和正确编译的 SQLite 库，在某些受限环境中可能无法满足。通过将两者解耦，qmd 确保了基础功能的普遍可用性，同时为有条件的用户提供更强大的语义搜索能力。

## 本章小结

`src/db.ts` 用 96 行代码解决了一个看似复杂的工程问题：让同一套数据库操作代码运行在 Bun 和 Node.js 两个截然不同的运行时上。其核心策略包括：通过 `globalThis.Bun` 进行零开销的运行时检测；利用 `setCustomSQLite()` 绕过 macOS 系统 SQLite 的扩展限制；在启动时通过内存数据库探测 sqlite-vec 可用性并支持优雅降级；以及提供 `Database` / `Statement` 两个最小化接口作为跨运行时的统一抽象。这一层薄而精确的封装，使得上层数百行的存储逻辑（`src/store.ts`）完全无需处理任何平台兼容性问题。
