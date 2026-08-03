# vLLM Chat Agent

浏览器端 vLLM Chat / Agent 应用，使用 Vite + TypeScript 构建。

## 项目定位

本项目是一个面向单用户的、**本地优先的浏览器端多 Agent Runtime**。它直接连接 OpenAI 兼容的私有 vLLM 服务，在不引入业务后端和独立向量数据库的情况下，提供对话、工具调用、Memory、Skills、`@角色` 并行任务和可视化运行状态。

项目关注的不是替代 LangChain、AutoGen 或 CrewAI 的完整生态，而是用更短的部署链路实现一个隐私优先、过程透明、容易修改的本地 Agent 工作台。

## 核心优势

### 私有模型与本地数据

- 直接连接本地或内网 vLLM，不依赖第三方 Agent 云服务；
- Memory、会话、Skills 和角色配置保存在浏览器 IndexedDB；
- multilingual-e5 在 Web Worker 中通过 ONNX/WASM 生成本地向量；
- 不需要远程数据库或独立向量数据库。

### 浏览器内完整 Agent 闭环

- TypeScript 前端负责 ReAct、工具执行、Memory 检索、Skill 匹配和任务调度；
- 支持文字、图片和 SSE 流式输出；
- Skill 与角色工具白名单共同约束运行时权限；
- 重复调用拦截、真实网络失败熔断和异常回答合成降低失控风险。

### `@角色` 并行工作

- 使用 `@researcher`、`@coder`、`@reviewer` 显式派发角色任务；
- Scheduler 提供有界并发、排队和独立取消；
- 子 Agent 不阻塞主对话，可继续派发其他任务；
- 完成结果自动写回任务所属主会话。

### 可观察、可诊断

- Tasks 面板展示排队、运行、完成、失败和取消状态；
- 实时显示 ReAct Step、耗时、流式心跳和工具调用；
- Agent、Memory 和 Skills 均提供可视化管理入口；
- 网络搜索支持 Jina、BBC/Bing RSS 和 GitHub REST API 降级链路。

### Local Memory OS

- 支持 `preference`、`fact`、`episode` 三类记忆；
- Memory 按会话隔离；
- 结合语义、关键词、时效、重要度和置信度进行混合检索；
- 支持语义去重、事实强化、失效时间和 supersede 时序版本；
- 回答完成后由 vLLM 在后台抽取和巩固稳定记忆。

## 与常见 Agent 框架对比

| 维度 | 本项目 | LangChain / AutoGen / CrewAI 等 |
|---|---|---|
| 运行位置 | 浏览器 | 通常是 Python/Node 服务端 |
| 模型连接 | 直接连接私有 vLLM | 支持更多模型供应商 |
| 部署复杂度 | 低，无业务后端 | 通常需要服务端、任务系统和数据库 |
| 多 Agent | `@角色` 显式派发和并行运行 | 通常支持更复杂的自动协作 |
| 可观察性 | 原生 Tasks UI | 常依赖日志或外部 tracing 平台 |
| Memory | IndexedDB + 本地 embedding | 常依赖外部向量库或 Memory 服务 |
| 跨页面持续运行 | 暂不支持 | 服务端框架通常支持 |
| 生态规模 | 工具较少、权限易控制 | 集成丰富，但复杂度更高 |

## 适用边界

适合本地或内网 vLLM 验证、单用户研究与开发助手、隐私敏感场景，以及需要可视化并行 Agent 但不希望部署复杂后端的应用。

当前不适合多租户、跨设备同步、页面关闭后持续运行、大规模分布式调度，以及 Agent 自主组队和递归委派。后续重点是任务持久化、后端任务队列、Agent 私有 Memory 和受控委派。

## 主要能力

- OpenAI 兼容 vLLM API 与 SSE 流式输出
- 文字和图片输入
- ReAct Agent 与运行时工具权限控制
- 本地 Memory、混合检索与时序版本
- Skills 注册、匹配和可视化管理
- 单用户多会话隔离、历史保存和会话切换
- Web Worker + Transformers.js 本地 embedding

## Web 界面示例

在主输入框输入 `@` 会打开角色选择菜单。内置角色包括代码员、评审员和研究员，菜单同时展示角色名称、mention 和职责说明。

![Agent 角色选择菜单](./docs/images/web-agent-picker.png)

主对话不会被子 Agent 阻塞，可以连续提交多个任务：

```text
@coder 用三点总结本项目的工程优势
@reviewer 评审本项目当前最重要的两个风险，并给出具体改进方向
```

Scheduler 会在并发上限内同时运行任务。Tasks 面板独立展示每个任务的角色、状态、耗时、ReAct Step 和流式输出进度。

![多个子 Agent 并行运行](./docs/images/web-parallel-tasks.png)

任务完成后，最终答案会以带角色标识的消息回写到原主会话；切换会话不会导致结果串写。

![子 Agent 结果回写主会话](./docs/images/web-subagent-results.png)

## 子 Agent 运行示例

在主输入框输入：

```text
@researcher 看一下最新的bbc新闻
```

输入中的 `@researcher` 会被解析为“研究员”角色任务。任务由 Scheduler 在后台运行，Tasks 面板实时展示当前步骤、流式输出心跳和耗时，主输入框仍可继续使用。

![研究员子 Agent 运行过程](./docs/images/bbc-agent-running.png)

搜索链路优先尝试 Jina；连接超时时自动回退到 BBC 官方 RSS。任务完成后，结果以带角色标识的消息发布到任务所属主会话并持久化。

![研究员子 Agent 最终结果](./docs/images/bbc-agent-result.png)

## 文档

- [使用说明](./README_chat.md)
- [项目架构与 Mermaid 流程图](./ARCHITECTURE.md)
- [Memory 架构](./MEMORY_ARCHITECTURE.md)

## 启动

```bash
cd web
npm install
npm run dev
```

默认连接 `http://127.0.0.1:8000/v1`。也可以通过环境变量配置服务地址：

```bash
VITE_VLLM_BASE_URL=http://your-vllm-host:8000/v1 npm run dev
```

生产构建：

```bash
cd web
npm run build
```
