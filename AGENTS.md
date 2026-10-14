# pi-rpc-chat Agent Rules

本仓库是一个独立的局域网 Web 应用：React/Vite 前端、Node.js HTTP/WebSocket 后端，默认驱动 Pi RPC 进程并把 Pi 工作目录指向 `/WorkSpace/pmCloud_New`。

## 任务分级

每次收到需求后，先按影响面分为 `tiny`、`standard` 或 `major`，再决定是否调用 `.pi-teammates/pi-rpc-chat` 中的只读 support teammate。

### tiny

满足以下条件时归为 `tiny`：

- 单文件或少量局部改动。
- 不改变 RPC 协议、认证、进程生命周期、WebSocket 消息契约或构建方式。
- 可通过阅读代码和一次 `npm run build` 或等价轻量检查验证。

处理方式：主 agent 直接实现和验证，通常不启动 teammate。

### standard

满足任一条件时归为 `standard`：

- 涉及前端和后端两个边界之一的行为变化。
- 修改消息渲染、链接处理、状态流、extension UI 桥接、WebSocket 事件处理、错误处理或安全提示。
- 需要独立代码审查，或需要先调查现有实现再动手。

处理方式：主 agent 仍是唯一写代码者。必要时创建或维护 `.workflow/changes/<slug>/brief.yaml`，并可调用：

```bash
./.pi-teammates/pi-rpc-chat/auto-team <slug> standard <task-file>
```

默认 support roles：`frontend-scout backend-scout reviewer`。

### major

满足任一条件时归为 `major`：

- 改变整体架构、RPC 协议封装、认证策略、权限边界、进程管理模型或部署方式。
- 引入持久化、多会话恢复、文件打开/编辑能力、跨项目操作、复杂浏览器 QA，或影响 `/WorkSpace/pmCloud_New` 的协作方式。
- 需要并行探索多个方案，或风险无法通过单次局部 diff 审查覆盖。

处理方式：必须先维护 `.workflow/changes/<slug>/brief.yaml` 作为唯一规划真源。并行开发时使用 `.worktrees/<slug>/` 和独立端口，避免多个 agent 共用一个 worktree 或 dev server。可调用：

```bash
./.pi-teammates/pi-rpc-chat/auto-team <slug> major <task-file>
```

默认 support roles：`frontend-scout backend-scout reviewer qa`。

## 分工规则

- 主 agent 是唯一可写角色，负责最终实现、集成、验证和交付说明。
- Support teammate 默认只读，适合做侦察、风险审查和 QA 验证建议。
- 不允许多个可写 agent 同时修改同一个仓库、worktree 或同一组文件。
- 涉及浏览器体验时，先确认当前服务端口；如果 `3030` 已被占用，使用其它端口并在报告中说明。
- 涉及 `/WorkSpace/pmCloud_New` 的行为时，只能把它作为 Pi RPC 的目标工作区或只读参考，除非用户明确要求修改该项目。

## 验证基线

- 默认构建检查：`npm run build`。
- 需要运行服务时优先使用 `npm run dev`，并明确 `PORT`、`PI_WORKSPACE`、认证环境变量和访问 URL。
- 认证、安全或进程生命周期变更必须说明残余风险。
- UI 变更要至少覆盖桌面宽度下的主要流程；复杂交互或回归风险高时交给 `qa` teammate 做独立验证建议。
