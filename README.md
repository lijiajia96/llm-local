# vLLM Chat Agent

浏览器端 vLLM Chat / Agent 应用，使用 Vite + TypeScript 构建。

主要能力：

- OpenAI 兼容 vLLM API 与 SSE 流式输出
- 文字和图片输入
- ReAct Agent 与运行时工具权限控制
- 本地 Memory、混合检索与时序版本
- Skills 注册、匹配和可视化管理
- 单用户多会话隔离、历史保存和会话切换
- Web Worker + Transformers.js 本地 embedding

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
