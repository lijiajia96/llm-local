# vLLM Chat · Agent

一个直连 OpenAI 兼容 vLLM 服务的多模态对话网页，支持：

- 💬 **普通模式**：文字 + 图片对话，流式逐字输出，`<think>` 推理块单独渲染。
- 🤖 **Agent 模式**：ReAct 循环，模型自主调用工具（网页搜索、抓取正文、JS 沙盒、时间、Mermaid 图表）完成任务。
- 🧠 **Memory**：IndexedDB 长期记忆，本地 E5 向量 + 关键词混合检索，支持后台抽取、语义去重和时序版本。
- ◆ **Skills**：Manifest 驱动的能力注册表，支持触发匹配、prompt 注入、工具白名单和自定义 Skill。

工程位于 [web/](./web)，Vite + TypeScript，前端零后端、纯浏览器直连 vLLM。

## 文档

- [项目总体架构与流程图](./ARCHITECTURE.md)
- [本地 Agent Memory 架构](./MEMORY_ARCHITECTURE.md)
- [网页使用说明](./README_chat.md)

---

## 快速开始

需要 Node ≥ 18。

```bash
cd web
npm install
npm run dev       # 开发服务器 → http://127.0.0.1:8899
```

生产构建：

```bash
npm run build     # 输出到 web/dist
npm run preview   # 本地预览构建产物
```

---

## 目录结构

```
web/
├── index.html
├── vite.config.ts   tsconfig.json   package.json
└── src/
    ├── main.ts                # 应用装配 & 状态
    ├── config.ts / types.ts
    ├── api/
    │   ├── openai.ts          # streamChat / listModels
    │   └── stream.ts          # SSE 解析
    ├── agent/
    │   ├── context.ts         # Memory + Skills 上下文装配
    │   ├── prompt.ts          # ReAct system prompt
    │   ├── parser.ts          # trace 分块 / preamble 拆分
    │   ├── tools.ts           # 工具注册表
    │   └── runner.ts          # ReAct 循环 (事件驱动)
    ├── memory/
    │   ├── repository.ts      # IndexedDB + 时序版本 + 混合检索
    │   ├── context.ts         # 注入预算 + 显式记忆识别
    │   ├── consolidator.ts    # 后台 vLLM 记忆抽取
    │   ├── embedding.ts       # 本地向量服务
    │   ├── embedding.worker.ts# Transformers.js Web Worker
    │   ├── tools.ts           # memory_search / memory_save
    │   └── types.ts
    ├── skills/
    │   ├── builtins.ts        # 5 个内置 Skills
    │   ├── matcher.ts         # 触发匹配 + 工具权限合并
    │   ├── repository.ts      # 内置覆盖与自定义 Skill 持久化
    │   └── types.ts
    ├── sessions/
    │   └── repository.ts      # 会话列表与聊天历史持久化
    ├── storage/
    │   └── database.ts        # 版本化 IndexedDB
    ├── ui/
    │   ├── Header.ts   Composer.ts   ChatView.ts
    │   ├── Message.ts  AgentTrace.ts AgentManager.ts
    │   ├── mermaid.ts  dom.ts        # 轻量 h() 助手
    └── styles/
        ├── tokens.css         # 设计变量
        ├── base.css           # reset + backdrop
        ├── layout.css         # 网格 / 头 / 输入区
        └── components.css     # 组件视觉
```

分层原则：

- `api/*` 只与网络协议打交道，无任何 UI 引用。
- `agent/runner` 接收本次专属的 tool registry，通过 `AgentEvent` 把 trace 推给 UI，不直接操作 DOM。
- `memory/*` 和 `skills/*` 不依赖 UI；管理面板只通过 repository 访问数据。
- `ui/*` 组件都是**工厂函数** `create*() → { el, update }`，无框架、无全局状态。
- `main.ts` 是唯一持有可变状态的地方，负责编排与事件绑定。

---

## 界面

| 区域 | 说明 |
|---|---|
| 状态圆点 | 绿=已连接，红=失败，灰=未连接 |
| 服务地址 | 默认 `http://127.0.0.1:8000/v1`，可通过 `VITE_VLLM_BASE_URL` 配置；改动自动重连并保存到 localStorage |
| 模型下拉 | 拉取 `/v1/models` 结果 |
| Memory | 查看统计、搜索、手工新增、删除或清空长期记忆 |
| Skills | 启停内置 Skill、创建/删除自定义 Skill、配置工具权限 |
| Agent 模式开关 | 开 = ReAct 工具调用；关 = 普通聊天 |
| 输入框 | Enter 发送，Shift+Enter 换行；Cmd/Ctrl+V 可粘贴图片 |

---

## Agent 架构

采用 **ReAct**（Thought → Action → Observation 循环），因当前 vLLM 未启用原生 tool calling，走文本模式：

```
Thought: <reasoning>
Action: <tool_name>
Action Input: <JSON>
[STOP — runtime executes tool]
Observation: <result>
… 最多 8 步 …
Final Answer: <answer>
```

内置工具：

| 名称 | 说明 |
|---|---|
| `web_search` | 通用查询走 Jina Reader；GitHub 查询自动切换 GitHub REST API |
| `github_search` | 查询 GitHub 仓库、最新稳定 tag 和 release |
| `fetch_url` | 通用 URL 走 Jina Reader；GitHub 仓库 URL 自动切换 GitHub REST API |
| `run_js` | 沙盒 JS 执行（`new Function`），支持 `return x;` / 单表达式 / 语句尾自动 return |
| `get_time` | 返回当前时间与时区 |
| `render_mermaid` | 渲染 Mermaid 图表（懒加载 mermaid CDN） |
| `memory_search` | 主动搜索长期记忆 |
| `memory_save` | 保存稳定的用户偏好或事实 |

添加新工具：在 [src/agent/tools.ts](./web/src/agent/tools.ts) 里追加一条 `ToolDefinition`，`prompt` 会自动把它的 `desc` 和 `args` 注入 system prompt。

---

## Memory

Memory 和会话历史存放在浏览器 IndexedDB 数据库 `vllm-agent` 中，刷新页面后仍然保留。点击页头“新会话”会生成新的 `sessionId`；通过旁边的下拉框可切换历史会话并恢复聊天内容。Memory 按 `session/{sessionId}/{scope}` 隔离，检索、统计、去重和清空均只作用于当前会话。Skills 仍由所有会话共享。完整设计见 [MEMORY_ARCHITECTURE.md](./MEMORY_ARCHITECTURE.md)。

| 类型 | 用途 |
|---|---|
| `preference` | 用户长期偏好，例如语言和回答风格 |
| `fact` | 用户明确要求记住的稳定事实 |
| `episode` | 已完成任务及最终答案，最多保留最近 200 条 |

Agent 启动前会检索最多 6 条相关 Memory。语义模型就绪时融合 multilingual-e5 向量、关键词、重要度、置信度、时间衰减和访问频率；模型不可用时自动退化为关键词检索。注入上限为 5000 字符。

每轮回答后，后台 vLLM 会异步提取稳定偏好和事实，并执行精确/语义去重。相同主题的新事实不会覆盖旧数据：旧记录写入 `validTo`，新记录通过 `supersedes` 保留版本链。包含“请记住 / 我偏好 / 以后请”等表达的输入也会立即保存。

本地向量模型运行在 Web Worker 中。首次使用在 Memory 面板点击“加载本地语义模型”，下载完成后由浏览器缓存；已有数据可点击“重建向量索引”。

Memory 只作为可能过期的上下文，不能覆盖当前用户指令。

---

## Skills

Skill Manifest 包含：

```ts
{
  id, name, description, version,
  triggers,       // 激活关键词
  prompt,         // 激活后注入的执行规范
  allowedTools,   // 工具白名单
  enabled
}
```

内置 Skills：

- `Core Agent`：始终激活，提供基础计算、时间和 Memory 能力。
- `GitHub Research`：仓库、版本、tag、release 查询。
- `Web Research`：网页搜索与正文抓取。
- `Data Analysis`：确定性计算和数据转换。
- `Diagramming`：Mermaid 架构图、流程图和时序图。

匹配后只把各 Skill 的 `allowedTools` 并集传给 runner。未授权工具不会出现在 prompt 中，执行时也会被拒绝。自定义 Skill 保存在 IndexedDB，可在 Skills 面板创建和删除。

Agent trace 顶部的 `本次 Agent Context` 会显示实际激活的 Skills、召回的 Memory 数量和工具权限。

---

## FAQ

**连接失败？** 命令行验证 `curl -s "${VLLM_BASE_URL:-http://127.0.0.1:8000/v1}/models"`。CORS 需要服务端允许网页所在的 origin。

**Agent 循环调用同一工具？** Runner 会对相同工具参数硬去重；网络工具连续失败两次会熔断，不只依赖 prompt 约束。

**Memory 存在哪里？** 当前浏览器的 IndexedDB。不同浏览器配置文件互不共享，清理浏览器站点数据会删除 Memory 和自定义 Skills。

**新会话会读取旧会话的 Memory 吗？** 不会。当前 `sessionId` 保存在 localStorage，刷新页面不变；点击“新会话”后会切换到全新的 Memory namespace。页头会话下拉框可以切回历史会话，同时恢复该会话的聊天历史和 Memory。

**Jina Reader 抓不通？** GitHub 查询不受影响，会直接走 GitHub REST API。其他通用网页搜索仍需访问 `r.jina.ai` / `s.jina.ai`，也可以在 [tools.ts](./web/src/agent/tools.ts) 里替换成 Serper / DuckDuckGo 等。
