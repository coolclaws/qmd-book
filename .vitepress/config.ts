import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'qmd 源码解析',
  description: '本地混合搜索引擎，BM25 + 向量 + 重排，专为 AI 工作流设计',
  lang: 'zh-CN',
  base: '/',

  themeConfig: {
    logo: { src: '/logo.png', alt: 'qmd' },
    nav: [
      { text: '开始阅读', link: '/chapters/01-overview' },
      { text: '目录', link: '/contents' },
      { text: 'GitHub', link: 'https://github.com/coolclaws/qmd-book' },
    ],
    sidebar: [
      {
        text: '第一部分：宏观认知',
        items: [
          { text: '第 1 章：项目概览', link: '/chapters/01-overview' },
          { text: '第 2 章：仓库结构与构建', link: '/chapters/02-repo-structure' },
        ],
      },
      {
        text: '第二部分：存储基石',
        items: [
          { text: '第 3 章：数据库抽象层', link: '/chapters/03-database-layer' },
          { text: '第 4 章：Schema 与内容寻址存储', link: '/chapters/04-schema-design' },
          { text: '第 5 章：集合与上下文管理', link: '/chapters/05-collections' },
        ],
      },
      {
        text: '第三部分：搜索引擎',
        items: [
          { text: '第 6 章：智能分块算法', link: '/chapters/06-smart-chunking' },
          { text: '第 7 章：BM25 全文搜索', link: '/chapters/07-bm25-search' },
          { text: '第 8 章：向量搜索与嵌入', link: '/chapters/08-vector-search' },
          { text: '第 9 章：LLM 抽象层', link: '/chapters/09-llm-layer' },
        ],
      },
      {
        text: '第四部分：查询管线',
        items: [
          { text: '第 10 章：混合查询管线', link: '/chapters/10-hybrid-pipeline' },
          { text: '第 11 章：查询扩展与重排', link: '/chapters/11-expansion-reranking' },
        ],
      },
      {
        text: '第五部分：对外接口',
        items: [
          { text: '第 12 章：SDK 与库模式', link: '/chapters/12-sdk' },
          { text: '第 13 章：MCP 服务器', link: '/chapters/13-mcp-server' },
          { text: '第 14 章：CLI 与输出格式化', link: '/chapters/14-cli-formatter' },
        ],
      },
      {
        text: '附录',
        items: [
          { text: '附录 A：推荐阅读路径', link: '/chapters/appendix-a-reading-path' },
          { text: '附录 B：核心类型速查', link: '/chapters/appendix-b-type-reference' },
          { text: '附录 C：名词解释', link: '/chapters/appendix-c-glossary' },
        ],
      },
    ],
    outline: { level: [2, 3], label: '本页目录' },
    search: { provider: 'local' },
    footer: {
      message: '基于 MIT 协议发布',
      copyright: 'Copyright © 2025-present',
    },
  },
  markdown: { lineNumbers: true },
})
