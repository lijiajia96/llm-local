# 本地 Agent Memory 架构

调研时间：2026-08-01

项目总体架构、Agent/Skills/工具链路与完整 Mermaid 图见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 结论

当前 Agent Memory 的主流方向已经从“聊天记录 + 向量库”演进为：

1. **Memory OS**：记忆是独立的可治理资源，具有类型、作用域、生命周期、反馈和可视化管理。
2. **多层记忆**：工作记忆、语义记忆、情景记忆和程序记忆分别管理。
3. **多信号检索**：语义向量、关键词、实体、时间、重要度和访问反馈共同排序。
4. **后台巩固**：前台回答结束后异步抽取、去重、更新和压缩记忆。
5. **时序事实**：新事实不直接覆盖旧事实，而是保留来源和有效期。
6. **Skill evolution**：成功轨迹可以进一步固化为程序记忆或 Skill。

## GitHub 项目对比

| 项目 | Stars | 最新版本 | 核心思路 | 本项目借鉴 |
|---|---:|---|---|---|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | 62k+ | v2.0.14 | 单次事实抽取、去重、实体连接、多信号检索 | 后台抽取、智能去重 |
| [getzep/graphiti](https://github.com/getzep/graphiti) | 29k+ | v0.29.3 | Episode、实体关系、双时间、语义+BM25+图检索 | `validFrom/validTo`、来源和 supersedes |
| [letta-ai/letta](https://github.com/letta-ai/letta) | 24k+ | 0.16.8 | Core / Recall / Archival 分层，Agent 自主管理 | 热记忆注入 + 冷记忆工具搜索 |
| [MemTensor/MemOS](https://github.com/MemTensor/MemOS) | 10k+ | v2.0.27 | Memory OS、MemCube、异步调度、Skill memory | 作用域、管理 UI、后台调度、Skills |
| [langchain-ai/langmem](https://github.com/langchain-ai/langmem) | 1.5k+ | pre-1.0 | Semantic / Episodic / Procedural，hot path + background | 记忆类型与后台巩固 |

以上数据来自 GitHub API。各项目均在 2026 年 7 月末仍有提交。

## 为什么不直接引入整套框架

当前应用是 Vite + TypeScript 的浏览器应用，直接连接 OpenAI 兼容 vLLM 服务。

完整 Mem0、Graphiti 或 MemOS 服务通常还需要 Python、Qdrant、Neo4j、Postgres 或独立 Server。对当前单用户本地应用而言：

- 运维复杂度明显高于收益；
- 会破坏“打开本地网页即可使用”的部署方式；
- 图数据库只有在多实体、多跳、历史时间查询成为核心需求后才值得引入。

因此采用一个 **Local Memory OS Lite**：保留主流架构的关键机制，同时只依赖浏览器 IndexedDB 和本地 ONNX 推理。

## 已实现架构

```text
User / Agent turn
       |
       +---- foreground --------------------------------+
       |                                                |
       |   Query --> multilingual-e5 (Web Worker)       |
       |              + lexical tokenizer               |
       |              + recency / importance            |
       |              + confidence / access frequency   |
       |                       |                        |
       |                  Hybrid Top-K                   |
       |                       |                        |
       |            Agent Context + Memory Tools         |
       |                                                |
       +---- background --------------------------------+
           Episode append
                |
           vLLM extractor
                |
        secret/transient filtering
                |
       exact + semantic dedup
                |
      temporal supersede / reinforce
                |
             IndexedDB
```

### 存储

每条 Memory 包含：

- `kind`: `preference | fact | episode`
- `scope`: `user | project | agent`
- `namespace`: `session/{sessionId}/{scope}`，隔离不同会话和作用域
- `importance`、`confidence`
- `validFrom`、`validTo`、`supersedes`
- `lastAccessedAt`、`accessCount`
- 384 维本地 embedding 及模型版本
- 来源、标签和创建/更新时间

程序记忆由现有 Skill Manifest 表达，不与事实 Memory 混存。

### 会话隔离

- 当前 `sessionId` 保存在 localStorage，刷新页面后保持不变。
- Session 元数据和完整 `ChatMessage[]` 保存在 IndexedDB `sessions` store。
- 点击“新会话”生成新的 UUID；页头下拉框可切换历史会话。
- 切换会话时恢复聊天内容、Agent 模式和对应的 Memory namespace。
- `MemoryRepository` 只列出、检索、统计、去重和清空当前 session namespace。
- `user | project | agent` scope 保留在 session namespace 的最后一级，不跨 session 召回。
- 已排队的后台巩固会捕获发起时的 session，避免异步结果写入后续新会话。
- 旧版本 `local/*` Memory 首次读取时迁移到当时的当前 session。
- Skills 是程序能力配置，保持跨 session 共享。
- Agent trace 不持久化；历史 Agent 回答以普通 Assistant 最终消息恢复。

### 本地语义模型

- 模型：`Xenova/multilingual-e5-small`
- 运行时：Transformers.js + ONNX Runtime
- 执行位置：Web Worker，不阻塞页面
- 后端：WASM，量化权重 `q8`
- 缓存：浏览器 Cache API
- 数据：输入文本和向量均不发送到外部推理 API

首次使用需要从 Hugging Face 下载模型文件。下载完成后可离线复用。模型不可用时自动退化为关键词、时间和重要度检索。

### 混合检索

语义模型就绪时：

```text
score = semantic * 0.58
      + lexical  * 0.27
      + support  * 0.15
```

`support` 由重要度、置信度、时间衰减和访问频率组成。

模型未就绪时：

```text
score = lexical * 0.78 + support * 0.22
```

### 时序与去重

- 内容完全相同：强化重要度和置信度，不新增记录。
- 标题和作用域相同但内容变化：旧记录写入 `validTo`，新记录通过 `supersedes` 指向旧记录。
- 后台 Agent 抽取的不同标题记忆：使用向量相似度识别近重复并合并。
- 检索默认只返回当前有效事实；历史版本仍可在管理面板审计。

### 后台巩固

回答完成后异步调用当前 vLLM：

- 最多抽取 3 条长期事实；
- 只保留稳定偏好、项目事实、明确决策和纠正；
- 丢弃公开网页事实、临时计算、问候和一次性结果；
- 明确禁止保存密码、token、私钥等敏感内容；
- 写入前提供已有相关 Memory，减少重复抽取。

后台任务串行排队，不延长前台最终答案的显示时间。

## 本地运行

```bash
cd web
npm install
npm run dev
```

访问 `http://127.0.0.1:8899/`，点击顶部 `Memory`：

1. 点击“加载本地语义模型”。
2. 等待状态显示“语义检索已就绪”。
3. 已有 Memory 可点击“重建向量索引”。

## 当前边界

- IndexedDB 数据只属于当前浏览器 profile，不支持跨设备共享。
- 目前没有实体图和多跳图遍历；需要复杂关系/历史查询时再接 Graphiti。
- 本地 E5 首次下载需要网络，后续可缓存离线使用。
- 后台抽取质量受当前 vLLM 模型的结构化输出能力影响。
- 尚未接入 LoCoMo / LongMemEval 自动评测。
