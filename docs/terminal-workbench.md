# 多会话终端工作台设计

## 目标升级

Pi RPC Chat 的 UI 目标从“单一聊天框”升级为“多会话终端工作台”。

新的产品目标是：在一个浏览器窗口中同时管理多个工作区、多个会话和多个独立 Pi RPC 运行时，让用户可以像使用 tmux 一样并行观察、切换和操作多个工程任务。

## 核心对象

- `Workspace`：一个本地工程目录，例如 `/WorkSpace/pmCloud_New`。
- `Conversation`：某个工作区下的一条独立任务线。
- `Runtime`：一个 conversation 背后的独立 `pi --mode rpc` 子进程。
- `Pane`：前端分屏中的一个视图区域，绑定一个 conversation。

## 第一阶段边界

第一阶段先实现多工作区、多 conversation、多 Pi RPC runtime 的后端底座，并让前端能够按 conversation 切换。分屏 UI 在这个底座稳定后实现。

第一阶段不做：

- 多用户认证。
- 跨设备布局同步。
- 文件级锁。
- 同一个 conversation 同时显示在多个 pane。
- 长期归档和搜索。

## 目标体验

最终界面应支持两种工作方式：

- 列表工作台：左侧选择 workspace/conversation，中间查看一个 conversation。
- 分屏工作台：主区域按横向或竖向拆分为多个 pane，每个 pane 绑定一个 conversation。

用户可以：

- 在同一工作区下同时打开多个 conversation。
- 在不同工作区下同时运行多个 Pi RPC 子进程。
- 让后台 conversation 继续运行，同时聚焦另一个 conversation。
- 最大化某个 pane，临时占满主区域，再恢复原分屏布局。

## 默认限制

- 同时运行的 Pi runtime 上限：4。
- 单 workspace 同时运行的 runtime 上限：3。
- 同屏 pane 数量上限：6。
- 关闭 pane 只关闭视图，不停止背后的 conversation。
- 停止 conversation 必须通过明确的停止动作。

## 风险提示

多个 Pi runtime 同时操作同一工作区时可能产生文件修改冲突。第一版只做显式风险提示和运行数量限制，不做文件级锁。

## 核心设计原则

- 后端只管理 workspace、conversation 和 runtime，不感知前端 pane。
- 前端 pane 是 conversation 的视图，不是 runtime 本身。
- 一个 conversation 第一版只允许出现在一个 pane，避免重复输入和状态混乱。
- 每个 conversation 独立启动一个 Pi RPC 子进程，保证并发能力。
- conversation 切换不应停止后台 Pi runtime。
- pane 关闭不等于停止 conversation。

## 布局状态模型

分屏布局使用可序列化树结构：

```json
{
  "type": "split",
  "direction": "horizontal",
  "ratio": 0.55,
  "first": {
    "type": "leaf",
    "paneId": "pane_1",
    "conversationId": "conv_a"
  },
  "second": {
    "type": "leaf",
    "paneId": "pane_2",
    "conversationId": "conv_b"
  }
}
```

`horizontal` 表示左右分屏，`vertical` 表示上下分屏。`leaf` 节点显示一个 conversation 或 conversation picker。

## 拖拽调整尺寸

第一版使用 `react-resizable-panels` 管理嵌套分屏和拖拽尺寸。布局树保存 pane 结构，具体拖拽尺寸由 panel group 状态或 localStorage 保存。

## Pane 最大化

最大化不修改布局树，只记录：

```js
maximizedPaneId = "pane_2"
```

渲染时只显示该 pane，并提供“还原分屏”。还原后恢复原布局树。

## Pane 聚焦

点击 pane 任意区域设置 `focusedPaneId`。聚焦 pane 使用更明显的边框和标题栏强调。键盘快捷键默认作用于 focused pane。

## Pane 内部布局

每个 pane 使用紧凑结构：

```text
[标题栏: workspace / conversation / 状态 / 操作]
[消息滚动区]
[输入框 + run state]
```

pane 内不放完整右侧 inspector；工具日志和扩展状态可在 pane 内折叠，或由全局 inspector 显示 focused pane 的详情。

## 全局左侧栏

左侧栏保留 workspace/conversation tree。它负责：

- 新建 workspace。
- 新建 conversation。
- 查看后台运行状态。
- 把 conversation 打开到 focused pane。
- 切换列表模式和分屏模式。

## Conversation 与 Pane 的关系

第一版一个 conversation 只能绑定一个 pane。重复打开时聚焦已有 pane。关闭 pane 只移除视图，不停止 runtime。

## 新建 Pane 默认行为

在 focused pane 上执行左右/上下分屏时，原 pane 保持原 conversation，新 pane 显示 conversation picker。

## Conversation Picker

空 pane 显示 conversation picker，支持：

- 搜索 conversation。
- 选择已有 conversation。
- 新建 conversation。
- 按 workspace 分组显示。

## 后端与 Pane 解耦

pane layout 第一版保存在浏览器 localStorage。后端不需要知道 pane，仅管理 conversation/runtime。

## 消息渲染复用

当前工程化 Markdown 渲染、路径高亮、代码块、输入框状态条均作为 pane 内消息组件复用。pane 只增加 compact 变体，不复制渲染逻辑。

## WebSocket 连接策略

WebSocket 按 conversation 分流：

```text
/ws?conversationId=conv_a
```

每个 active conversation 保持一个 WebSocket。第一版限制 conversation 不重复打开，因此可以按 pane 建连接；后续可升级为前端 conversation store 去重连接。

## 第一版实现范围

第一版实现：

- 多 workspace 配置。
- 多 conversation 配置。
- runtime registry。
- 每个 conversation 一个 Pi RPC 子进程。
- 左侧 workspace/conversation tree。
- 单 conversation 页面适配 `conversationId`。
- split layout tree。
- pane 左右/上下分屏、关闭、聚焦、最大化/还原。
- localStorage 保存布局。

## 分屏最小闭环

最小闭环包含：

- 至少两个 conversation 可同时运行。
- 两个 pane 可同时展示不同 conversation。
- focused pane 可发送消息。
- 非 focused pane 可继续显示后台输出。
- 最大化 pane 后仍能还原分屏。

## 待确认问题

默认决策如下，除非后续明确修改：

- 分屏模式默认开启。
- 每个 pane 都有独立输入框。
- 关闭 pane 不停止 Pi。
- 同屏最多 6 个 pane。
- 同时运行最多 4 个 Pi runtime。
- 单 workspace 最多 3 个运行中 conversation。
- 工作区路径第一版允许 `/WorkSpace` 下目录。

## 最终设计

最终结构：

```text
左侧：Workspace / Conversation Tree
中间：Tmux-style Split Workspace
  Pane A -> Conversation A
  Pane B -> Conversation B
  Pane C -> Conversation C
右侧：可折叠 Inspector
  focused pane 的工具日志、扩展状态、运行状态
```

## 技术选型

- React + Vite + Tailwind：当前前端栈。
- `react-resizable-panels`：分屏拖拽。
- React context 或轻量 store：管理 conversations 和 layout。
- Node runtime registry：管理多个 Pi RPC 子进程。

## 实施顺序

1. 后端多 workspace/conversation/runtime registry。
2. 前端 conversation tree。
3. 单 conversation 页面适配 `conversationId`。
4. split layout tree。
5. pane 操作按钮。
6. 最大化/还原。
7. localStorage layout 持久化。
8. 多 conversation 并发验证。

