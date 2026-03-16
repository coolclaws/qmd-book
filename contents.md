# 目录

## 第一部分：宏观认知

- [第 1 章：项目概览](/chapters/01-overview) — qmd 是什么、为什么需要它、核心架构一览
- [第 2 章：仓库结构与构建](/chapters/02-repo-structure) — 文件组织、双运行时支持、构建流程

## 第二部分：存储基石

- [第 3 章：数据库抽象层](/chapters/03-database-layer) — db.ts 如何兼容 Bun 与 Node.js 的 SQLite
- [第 4 章：Schema 与内容寻址存储](/chapters/04-schema-design) — 表结构、FTS5 触发器、内容哈希去重
- [第 5 章：集合与上下文管理](/chapters/05-collections) — YAML 配置、Collection 抽象、层级上下文继承

## 第三部分：搜索引擎

- [第 6 章：智能分块算法](/chapters/06-smart-chunking) — 断点检测、距离衰减评分、代码围栏保护
- [第 7 章：BM25 全文搜索](/chapters/07-bm25-search) — FTS5 查询构建、分词、分数归一化
- [第 8 章：向量搜索与嵌入](/chapters/08-vector-search) — sqlite-vec、批量嵌入、余弦距离
- [第 9 章：LLM 抽象层](/chapters/09-llm-layer) — node-llama-cpp 封装、模型管理、会话复用

## 第四部分：查询管线

- [第 10 章：混合查询管线](/chapters/10-hybrid-pipeline) — 8 步管线、RRF 融合、位置感知混合
- [第 11 章：查询扩展与重排](/chapters/11-expansion-reranking) — LLM 扩展、强信号探测、缓存策略

## 第五部分：对外接口

- [第 12 章：SDK 与库模式](/chapters/12-sdk) — QMDStore 接口、内联配置、双写同步
- [第 13 章：MCP 服务器](/chapters/13-mcp-server) — MCP 协议、工具注册、HTTP 传输
- [第 14 章：CLI 与输出格式化](/chapters/14-cli-formatter) — 命令结构、多格式输出、进度显示

## 附录

- [附录 A：推荐阅读路径](/chapters/appendix-a-reading-path) — 不同背景读者的最佳阅读顺序
- [附录 B：核心类型速查](/chapters/appendix-b-type-reference) — 关键类型定义一览
- [附录 C：名词解释](/chapters/appendix-c-glossary) — 术语表
