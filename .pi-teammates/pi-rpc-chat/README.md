# pi-rpc-chat pi-teammate 配置

这个目录用于在 `/WorkSpace/pi-rpc-chat` 中按任务复杂度启动只读 support teammate。主 agent 仍然负责写代码、集成、验证和最终交付。

## 推荐使用方式

日常在项目根目录启动普通 `pi`：

```bash
cd /WorkSpace/pi-rpc-chat
pi
```

主 agent 根据 `AGENTS.md` 将需求评定为 `tiny`、`standard` 或 `major`：

- `tiny`：通常不启动 teammate。
- `standard`：需要独立调查或审查时启动 `frontend-scout backend-scout reviewer`。
- `major`：先维护 `.workflow/changes/<slug>/brief.yaml`，再启动 `frontend-scout backend-scout reviewer qa`。

自动只读协作：

```bash
./.pi-teammates/pi-rpc-chat/auto-team <slug> standard <task-file>
./.pi-teammates/pi-rpc-chat/auto-team <slug> major <task-file>
```

报告会写入：

```text
.pi-teammates/pi-rpc-chat/runs/<slug>/<timestamp>/
```

主 agent 读取这些报告后继续实现、验证和交付。

## 可用角色

- `coordinator`：任务分级、规划真源、分工和验证计划。
- `frontend-scout`：React/Vite UI、markdown、消息渲染、样式和交互调查。
- `backend-scout`：Node HTTP/WebSocket、Pi RPC 子进程、认证、端口和生命周期调查。
- `reviewer`：只读 diff 审查，重点关注行为 bug、会话丢失、安全和验证缺口。
- `qa`：构建、服务启动、浏览器流程和错误路径验证建议。

## 实时 channel 调试

平时不需要手动使用。需要实时观察 teammate 对话时可运行：

```bash
cd /WorkSpace/pi-rpc-chat
./.pi-teammates/pi-rpc-chat/pi-with-team pi-rpc-chat-demo-1 standard --new
```

major 任务：

```bash
./.pi-teammates/pi-rpc-chat/pi-with-team pi-rpc-chat-risky-change major --new
```

查看支持 teammate：

```bash
tmux attach -t pi-rpc-chat-team-pi-rpc-chat-demo-1
```

## 规则

- 每个独立任务使用一个唯一 channel 或 run 目录。
- 不要让多个可写 agent 同时修改同一个仓库或 worktree。
- Support teammate 默认只读；如果需要修改代码，由主 agent 根据报告统一落地。
- 需要运行服务时先检查端口；`3030` 被占用时使用其它 `PORT`。
- 涉及 `/WorkSpace/pmCloud_New` 时，把它视作 Pi RPC 目标工作区或只读参考，除非用户明确要求修改该项目。
