import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  Bot,
  CheckCircle2,
  Clock3,
  Command,
  Cpu,
  KeyRound,
  Loader2,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  SendHorizontal,
  Sparkles,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import { cn, formatTime } from "./lib/utils.js";

const params = new URLSearchParams(window.location.search);
const initialToken = params.get("token") || window.localStorage.getItem("piRpcChatToken") || "";
const initialConversationId = params.get("conversationId") || window.localStorage.getItem("piRpcActiveConversationId") || "";

if (params.get("token")) {
  window.localStorage.setItem("piRpcChatToken", params.get("token"));
}

const eventLabels = {
  agent_start: "任务开始",
  agent_end: "任务轮次结束",
  agent_settled: "任务完成",
  turn_start: "回复开始",
  turn_end: "回复结束",
  message_start: "消息开始",
  message_update: "消息更新",
  message_end: "消息结束",
  response: "命令响应",
  extension_ui_request: "扩展界面请求",
  tool_execution_start: "工具开始",
  tool_execution_update: "工具更新",
  tool_execution_end: "工具结束",
  queue_update: "队列更新",
  stderr: "错误输出",
  error: "错误",
  protocol: "协议错误",
  process: "进程",
  client: "浏览器",
  thinking: "思考",
};

const commandLabels = {
  prompt: "发送消息",
  abort: "停止任务",
  clear_queue: "清空队列",
  get_state: "刷新状态",
  restart: "重启 Pi",
  extension_ui_response: "扩展界面响应",
};

const streamLabels = {
  text_delta: "文本增量",
  text_start: "文本开始",
  text_end: "文本结束",
  thinking_delta: "思考增量",
  thinking_start: "思考开始",
  thinking_end: "思考结束",
  toolcall_start: "工具调用开始",
  toolcall_delta: "工具调用参数",
  toolcall_end: "工具调用结束",
};

const uiMethodLabels = {
  notify: "通知",
  setStatus: "设置状态",
  setWidget: "设置面板",
  setTitle: "设置标题",
  set_editor_text: "填充输入框",
  select: "选择",
  confirm: "确认",
  input: "输入",
  editor: "编辑器",
};

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function appendLimited(list, item, limit = 120) {
  const next = [...list, item];
  if (next.length > limit) next.splice(0, next.length - limit);
  return next;
}

function createLeaf(conversationId = null) {
  return { type: "leaf", paneId: createId("pane"), conversationId };
}

function loadLayout() {
  try {
    return JSON.parse(window.localStorage.getItem("piRpcSplitLayout") || "null");
  } catch {
    return null;
  }
}

function findFirstPaneId(node) {
  if (!node) return null;
  if (node.type === "leaf") return node.paneId;
  return findFirstPaneId(node.first) || findFirstPaneId(node.second);
}

function updateLeaf(node, paneId, updater) {
  if (node.type === "leaf") return node.paneId === paneId ? updater(node) : node;
  return { ...node, first: updateLeaf(node.first, paneId, updater), second: updateLeaf(node.second, paneId, updater) };
}

function splitLeaf(node, paneId, direction, newLeaf = createLeaf(null)) {
  return updateLeaf(node, paneId, (leaf) => ({ type: "split", direction, first: leaf, second: newLeaf }));
}

function removeLeaf(node, paneId) {
  if (node.type === "leaf") return node.paneId === paneId ? null : node;
  const first = removeLeaf(node.first, paneId);
  const second = removeLeaf(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function countLeaves(node) {
  if (!node) return 0;
  if (node.type === "leaf") return 1;
  return countLeaves(node.first) + countLeaves(node.second);
}

function findPaneByConversation(node, conversationId) {
  if (!node || !conversationId) return null;
  if (node.type === "leaf") return node.conversationId === conversationId ? node.paneId : null;
  return findPaneByConversation(node.first, conversationId) || findPaneByConversation(node.second, conversationId);
}

function findFirstEmptyPaneId(node) {
  if (!node) return null;
  if (node.type === "leaf") return node.conversationId ? null : node.paneId;
  return findFirstEmptyPaneId(node.first) || findFirstEmptyPaneId(node.second);
}

function getOpenConversationIds(node, ids = new Set()) {
  if (!node) return ids;
  if (node.type === "leaf") {
    if (node.conversationId) ids.add(node.conversationId);
    return ids;
  }
  getOpenConversationIds(node.first, ids);
  getOpenConversationIds(node.second, ids);
  return ids;
}

function extractMessageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeRecord(record) {
  if (record.type === "response") {
    return `${commandLabels[record.command] || record.command || "命令"}：${record.success === false ? record.error || "失败" : "成功"}`;
  }
  if (record.type === "message_update") return streamLabels[record.assistantMessageEvent?.type] || record.assistantMessageEvent?.type || "更新";
  if (record.type === "message_start" || record.type === "message_end") return record.message?.role === "assistant" ? "Pi" : record.message?.role || "消息";
  if (record.type === "extension_ui_request") return uiMethodLabels[record.method] || record.method || "界面请求";
  if (record.type?.startsWith("tool_execution_")) return record.toolName || "工具";
  if (record.type === "agent_settled") return record.aborted ? "已中止" : "已完成";
  return "";
}

function usePiRpc() {
  const [token, setTokenState] = useState(initialToken);
  const [activeConversationId, setActiveConversationIdState] = useState(initialConversationId);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState({ processRunning: false, isAgentRunning: false, workspace: "" });
  const [runState, setRunState] = useState({ phase: "idle", label: "Pi 空闲，等待输入" });
  const [workspaces, setWorkspaces] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [messages, setMessages] = useState([
    {
      id: "welcome",
      role: "system",
      text: "这里会显示对话内容和界面事件。服务端已在 /WorkSpace/pmCloud_New 中启动 Pi RPC。Enter 发送，Shift + Enter 换行。",
    },
  ]);
  const [events, setEvents] = useState([]);
  const [toolEvents, setToolEvents] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [widgets, setWidgets] = useState({});
  const [dialog, setDialog] = useState(null);
  const [toasts, setToasts] = useState([]);
  const socketRef = useRef(null);
  const activeAssistantIdRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  const pushToast = (text, variant = "info") => {
    const toast = { id: createId("toast"), text, variant };
    setToasts((list) => [...list, toast]);
    window.setTimeout(() => {
      setToasts((list) => list.filter((item) => item.id !== toast.id));
    }, 7000);
  };

  const addEvent = (type, detail) => {
    setEvents((list) => appendLimited(list, { id: createId("event"), at: new Date(), type, detail }));
  };

  const ensureAssistantMessage = () => {
    if (activeAssistantIdRef.current) return activeAssistantIdRef.current;
    const id = createId("assistant");
    activeAssistantIdRef.current = id;
    setMessages((list) => [...list, { id, role: "assistant", text: "", streaming: true }]);
    return id;
  };

  const updateAssistantText = (text, mode = "append") => {
    const id = ensureAssistantMessage();
    setMessages((list) =>
      list.map((message) => {
        if (message.id !== id) return message;
        const nextText = mode === "replace" ? text : `${message.text || ""}${text}`;
        return { ...message, text: nextText, streaming: true };
      }),
    );
  };

  const finalizeAssistant = (text) => {
    const id = activeAssistantIdRef.current;
    if (!id) {
      if (text.trim()) setMessages((list) => [...list, { id: createId("assistant"), role: "assistant", text }]);
      return;
    }

    activeAssistantIdRef.current = null;
    setMessages((list) =>
      list.flatMap((message) => {
        if (message.id !== id) return [message];
        const finalText = text.trim() ? text : message.text || "";
        if (!finalText.trim()) return [];
        return [{ ...message, text: finalText, streaming: false }];
      }),
    );
  };

  const applyStatus = (nextStatus) => {
    setStatus((current) => ({ ...current, ...nextStatus }));
    if (nextStatus.statuses) setStatuses(nextStatus.statuses);
    if (nextStatus.widgets) setWidgets(nextStatus.widgets);
  };

  const applyCatalog = (config) => {
    if (Array.isArray(config.workspaces)) setWorkspaces(config.workspaces);
    if (Array.isArray(config.conversations)) setConversations(config.conversations);
  };

  const applyConfig = (config) => {
    applyCatalog(config);
    if (config.activeConversationId && config.activeConversationId !== activeConversationId) {
      setActiveConversationIdState(config.activeConversationId);
      window.localStorage.setItem("piRpcActiveConversationId", config.activeConversationId);
    }
  };

  const handleExtensionUi = (record) => {
    if (record.method === "notify") {
      pushToast(record.message || "通知", record.notifyType || "info");
    } else if (record.method === "setStatus") {
      setStatuses((current) => {
        const next = { ...current };
        if (record.statusText) next[record.statusKey || record.id] = record.statusText;
        else delete next[record.statusKey || record.id];
        return next;
      });
    } else if (record.method === "setWidget") {
      setWidgets((current) => {
        const next = { ...current };
        if (Array.isArray(record.widgetLines)) {
          next[record.widgetKey || record.id] = {
            key: record.widgetKey || record.id,
            lines: record.widgetLines,
            placement: record.widgetPlacement || "aboveEditor",
          };
        } else {
          delete next[record.widgetKey || record.id];
        }
        return next;
      });
    } else if (record.method === "setTitle") {
      document.title = record.title || "Pi 远程对话";
    } else if (record.method === "set_editor_text") {
      window.dispatchEvent(new CustomEvent("pi:set-composer-text", { detail: record.text || "" }));
    } else if (["select", "confirm", "input", "editor"].includes(record.method)) {
      setDialog(record);
    }
  };

  const handleRecord = (record) => {
    addEvent(record.type, summarizeRecord(record));

    if (record.type === "agent_start") {
      applyStatus({ isAgentRunning: true });
      setRunState({ phase: "running", label: "Pi 正在处理请求" });
    } else if (record.type === "agent_settled") {
      applyStatus({ isAgentRunning: false });
      setRunState({ phase: "idle", label: record.aborted ? "任务已中止，可以继续输入" : "Pi 已完成，等待下一条消息" });
      activeAssistantIdRef.current = null;
    } else if (record.type === "message_update") {
      const update = record.assistantMessageEvent;
      if (update?.type === "text_delta") {
        setRunState({ phase: "responding", label: "Pi 正在生成回复" });
        updateAssistantText(update.delta || "");
      } else if (update?.type === "text_end") {
        updateAssistantText(update.content || "", "replace");
      } else if (update?.type === "thinking_delta") {
        setRunState({ phase: "thinking", label: "Pi 正在思考" });
        addEvent("thinking", update.delta || "");
      } else if (update?.type?.startsWith("toolcall_")) {
        setRunState({ phase: "tool", label: `Pi 正在准备工具调用${update.toolName ? `：${update.toolName}` : ""}` });
        addEvent(update.type, update.toolName || update.id || "工具调用");
      }
    } else if (record.type === "message_end") {
      if (record.message?.role === "assistant") finalizeAssistant(extractMessageText(record.message));
    } else if (record.type?.startsWith("tool_execution_")) {
      if (record.type === "tool_execution_start") {
        setRunState({ phase: "tool", label: `Pi 正在执行工具：${record.toolName || "工具"}` });
      } else if (record.type === "tool_execution_update") {
        setRunState({ phase: "tool", label: `工具执行中：${record.toolName || "工具"}` });
      } else if (record.type === "tool_execution_end") {
        setRunState({ phase: record.isError ? "error" : "running", label: record.isError ? `工具执行失败：${record.toolName || "工具"}` : "工具执行完成，Pi 正在整理结果" });
      }
      setToolEvents((list) =>
        appendLimited(
          list,
          {
            id: createId("tool"),
            at: new Date(),
            type: record.type,
            toolName: record.toolName || "工具",
            detail: record.toolCallId || "",
            isError: record.isError,
          },
          80,
        ),
      );
    } else if (record.type === "extension_ui_request") {
      handleExtensionUi(record);
    }
  };

  const handleServerMessage = (message) => {
    if (message.type === "hello") {
      applyConfig(message.config || {});
      applyStatus(message.status || {});
    } else if (message.type === "status") {
      applyStatus(message.status || {});
    } else if (message.type === "rpc_record") {
      handleRecord(message.record);
    } else if (message.type === "stderr") {
      addEvent("stderr", message.line);
    } else if (message.type === "error") {
      const text = message.error?.message || "服务端错误";
      pushToast(text, "error");
      addEvent("error", text);
    } else if (message.type === "protocol_error") {
      addEvent("protocol", message.error?.message || "协议错误");
    } else if (message.type === "process_exit") {
      addEvent("process", `Pi 进程已退出，code=${message.exit?.code ?? ""} signal=${message.exit?.signal ?? ""}`);
    } else if (message.type === "command_response") {
      const response = message.response || {};
      addEvent("response", `${commandLabels[response.command] || response.command || "命令"}：${response.success === false ? "失败" : "成功"}`);
    }
  };

  const connect = () => {
    if (socketRef.current) socketRef.current.close();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams();
    if (token) query.set("token", token);
    if (activeConversationId) query.set("conversationId", activeConversationId);
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws${query.toString() ? `?${query}` : ""}`);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnected(true);
      const configQuery = new URLSearchParams();
      if (token) configQuery.set("token", token);
      if (activeConversationId) configQuery.set("conversationId", activeConversationId);
      fetch(`/api/config${configQuery.toString() ? `?${configQuery}` : ""}`, { cache: "no-store" })
        .then((response) => {
          if (response.status === 401) throw new Error("Token 无效或已过期");
          return response.json();
        })
        .then((config) => {
          applyConfig(config);
          applyStatus(config.status || { workspace: config.workspace });
        })
        .catch((error) => pushToast(error.message, "error"));
    });

    socket.addEventListener("message", (event) => {
      try {
        handleServerMessage(JSON.parse(event.data));
      } catch (error) {
        addEvent("client", `服务端消息格式错误：${error.message}`);
      }
    });

    socket.addEventListener("close", () => {
      setConnected(false);
      applyStatus({ processRunning: false, isAgentRunning: false });
      reconnectTimerRef.current = window.setTimeout(() => connect(), 2500);
    });

    socket.addEventListener("error", () => {
      pushToast("WebSocket 连接异常", "error");
    });
  };

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, [token, activeConversationId]);

  const send = (payload) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      pushToast("WebSocket 尚未连接", "error");
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  };

  const setToken = (value) => {
    setTokenState(value);
    if (value) window.localStorage.setItem("piRpcChatToken", value);
  };

  const resetMessagesForConversation = (conversation) => {
    activeAssistantIdRef.current = null;
    setRunState({ phase: "idle", label: "Pi 空闲，等待输入" });
    setMessages([
      {
        id: `system-${conversation?.id || "default"}`,
        role: "system",
        text: conversation ? `已切换到会话：${conversation.title}` : "已切换会话。",
      },
    ]);
    setEvents([]);
    setToolEvents([]);
  };

  const setActiveConversationId = (conversationId) => {
    if (!conversationId || conversationId === activeConversationId) return;
    const conversation = conversations.find((item) => item.id === conversationId);
    setActiveConversationIdState(conversationId);
    window.localStorage.setItem("piRpcActiveConversationId", conversationId);
    resetMessagesForConversation(conversation);
  };

  const refreshCatalog = async () => {
    const [workspaceResponse, conversationResponse] = await Promise.all([
      fetch("/api/workspaces", { cache: "no-store" }),
      fetch("/api/conversations", { cache: "no-store" }),
    ]);
    if (workspaceResponse.ok) setWorkspaces((await workspaceResponse.json()).workspaces || []);
    if (conversationResponse.ok) setConversations((await conversationResponse.json()).conversations || []);
  };

  const createConversation = async (workspaceId) => {
    const title = window.prompt("新会话标题", "新会话");
    if (!title) return;
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, title }),
    });
    const body = await response.json();
    if (!response.ok) {
      pushToast(body.error || "创建会话失败", "error");
      return;
    }
    await refreshCatalog();
    setActiveConversationId(body.conversation.id);
    return body.conversation;
  };

  const submitPrompt = (text) => {
    const content = text.trim();
    if (!content) return false;
    if (send({ type: "prompt", message: content })) {
      setRunState({ phase: "queued", label: status.isAgentRunning ? "消息已排队，Pi 会在当前任务后处理" : "消息已发送，等待 Pi 接收" });
      setMessages((list) => [...list, { id: createId("user"), role: "user", text: content }]);
      return true;
    }
    return false;
  };

  const respondToDialog = (cancelled, value) => {
    if (!dialog) return;
    const response = { id: dialog.id };
    if (cancelled) response.cancelled = true;
    else if (dialog.method === "confirm") response.confirmed = true;
    else response.value = value || "";
    send({ type: "extension_ui_response", response });
    setDialog(null);
  };

  return {
    token,
    setToken,
    pushToast,
    applyCatalog,
    activeConversationId,
    setActiveConversationId,
    workspaces,
    conversations,
    refreshCatalog,
    createConversation,
    connected,
    status,
    runState,
    messages,
    events,
    toolEvents,
    statuses,
    widgets,
    dialog,
    toasts,
    submitPrompt,
    abort: () => send({ type: "abort" }),
    restart: () => send({ type: "restart" }),
    refreshState: () => send({ type: "get_state" }),
    clearEvents: () => setEvents([]),
    respondToDialog,
    dismissToast: (id) => setToasts((list) => list.filter((toast) => toast.id !== id)),
  };
}

function usePaneRpc(conversationId, appRpc) {
  const conversation = appRpc.conversations.find((item) => item.id === conversationId);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState({ processRunning: false, isAgentRunning: false, workspace: "" });
  const [runState, setRunState] = useState({ phase: "idle", label: conversationId ? "Pi 空闲，等待输入" : "请选择或创建会话" });
  const [messages, setMessages] = useState(() => [
    {
      id: `system-${conversationId || "empty"}`,
      role: "system",
      text: conversationId ? `已打开会话：${conversation?.title || conversationId}` : "请选择或创建会话。",
    },
  ]);
  const [events, setEvents] = useState([]);
  const [toolEvents, setToolEvents] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [widgets, setWidgets] = useState({});
  const [dialog, setDialog] = useState(null);
  const socketRef = useRef(null);
  const activeAssistantIdRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  const addEvent = (type, detail) => {
    setEvents((list) => appendLimited(list, { id: createId("event"), at: new Date(), type, detail }));
  };

  const ensureAssistantMessage = () => {
    if (activeAssistantIdRef.current) return activeAssistantIdRef.current;
    const id = createId("assistant");
    activeAssistantIdRef.current = id;
    setMessages((list) => [...list, { id, role: "assistant", text: "", streaming: true }]);
    return id;
  };

  const updateAssistantText = (text, mode = "append") => {
    const id = ensureAssistantMessage();
    setMessages((list) =>
      list.map((message) => {
        if (message.id !== id) return message;
        const nextText = mode === "replace" ? text : `${message.text || ""}${text}`;
        return { ...message, text: nextText, streaming: true };
      }),
    );
  };

  const finalizeAssistant = (text) => {
    const id = activeAssistantIdRef.current;
    if (!id) {
      if (text.trim()) setMessages((list) => [...list, { id: createId("assistant"), role: "assistant", text }]);
      return;
    }

    activeAssistantIdRef.current = null;
    setMessages((list) =>
      list.flatMap((message) => {
        if (message.id !== id) return [message];
        const finalText = text.trim() ? text : message.text || "";
        if (!finalText.trim()) return [];
        return [{ ...message, text: finalText, streaming: false }];
      }),
    );
  };

  const applyStatus = (nextStatus) => {
    setStatus((current) => ({ ...current, ...nextStatus }));
    if (nextStatus.statuses) setStatuses(nextStatus.statuses);
    if (nextStatus.widgets) setWidgets(nextStatus.widgets);
  };

  const handleExtensionUi = (record) => {
    if (record.method === "notify") {
      appRpc.pushToast(record.message || "通知", record.notifyType || "info");
    } else if (record.method === "setStatus") {
      setStatuses((current) => {
        const next = { ...current };
        if (record.statusText) next[record.statusKey || record.id] = record.statusText;
        else delete next[record.statusKey || record.id];
        return next;
      });
    } else if (record.method === "setWidget") {
      setWidgets((current) => {
        const next = { ...current };
        if (Array.isArray(record.widgetLines)) {
          next[record.widgetKey || record.id] = {
            key: record.widgetKey || record.id,
            lines: record.widgetLines,
            placement: record.widgetPlacement || "aboveEditor",
          };
        } else {
          delete next[record.widgetKey || record.id];
        }
        return next;
      });
    } else if (record.method === "setTitle") {
      document.title = record.title || "Pi 远程对话";
    } else if (record.method === "set_editor_text") {
      window.dispatchEvent(new CustomEvent(`pi:set-composer-text:${conversationId}`, { detail: record.text || "" }));
    } else if (["select", "confirm", "input", "editor"].includes(record.method)) {
      setDialog(record);
    }
  };

  const handleRecord = (record) => {
    addEvent(record.type, summarizeRecord(record));

    if (record.type === "agent_start") {
      applyStatus({ isAgentRunning: true });
      setRunState({ phase: "running", label: "Pi 正在处理请求" });
    } else if (record.type === "agent_settled") {
      applyStatus({ isAgentRunning: false });
      setRunState({ phase: "idle", label: record.aborted ? "任务已中止，可以继续输入" : "Pi 已完成，等待下一条消息" });
      activeAssistantIdRef.current = null;
      appRpc.refreshCatalog();
    } else if (record.type === "message_update") {
      const update = record.assistantMessageEvent;
      if (update?.type === "text_delta") {
        setRunState({ phase: "responding", label: "Pi 正在生成回复" });
        updateAssistantText(update.delta || "");
      } else if (update?.type === "text_end") {
        updateAssistantText(update.content || "", "replace");
      } else if (update?.type === "thinking_delta") {
        setRunState({ phase: "thinking", label: "Pi 正在思考" });
        addEvent("thinking", update.delta || "");
      } else if (update?.type?.startsWith("toolcall_")) {
        setRunState({ phase: "tool", label: `Pi 正在准备工具调用${update.toolName ? `：${update.toolName}` : ""}` });
        addEvent(update.type, update.toolName || update.id || "工具调用");
      }
    } else if (record.type === "message_end") {
      if (record.message?.role === "assistant") finalizeAssistant(extractMessageText(record.message));
    } else if (record.type?.startsWith("tool_execution_")) {
      if (record.type === "tool_execution_start") {
        setRunState({ phase: "tool", label: `Pi 正在执行工具：${record.toolName || "工具"}` });
      } else if (record.type === "tool_execution_update") {
        setRunState({ phase: "tool", label: `工具执行中：${record.toolName || "工具"}` });
      } else if (record.type === "tool_execution_end") {
        setRunState({ phase: record.isError ? "error" : "running", label: record.isError ? `工具执行失败：${record.toolName || "工具"}` : "工具执行完成，Pi 正在整理结果" });
      }
      setToolEvents((list) =>
        appendLimited(
          list,
          {
            id: createId("tool"),
            at: new Date(),
            type: record.type,
            toolName: record.toolName || "工具",
            detail: record.toolCallId || "",
            isError: record.isError,
          },
          80,
        ),
      );
    } else if (record.type === "extension_ui_request") {
      handleExtensionUi(record);
    }
  };

  const handleServerMessage = (message) => {
    if (message.conversationId && message.conversationId !== conversationId) return;

    if (message.type === "hello") {
      appRpc.applyCatalog(message.config || {});
      applyStatus(message.status || {});
    } else if (message.type === "status") {
      applyStatus(message.status || {});
    } else if (message.type === "rpc_record") {
      handleRecord(message.record);
    } else if (message.type === "stderr") {
      addEvent("stderr", message.line);
    } else if (message.type === "error") {
      const text = message.error?.message || "服务端错误";
      appRpc.pushToast(text, "error");
      addEvent("error", text);
    } else if (message.type === "protocol_error") {
      addEvent("protocol", message.error?.message || "协议错误");
    } else if (message.type === "process_exit") {
      addEvent("process", `Pi 进程已退出，code=${message.exit?.code ?? ""} signal=${message.exit?.signal ?? ""}`);
      appRpc.refreshCatalog();
    } else if (message.type === "command_response") {
      const response = message.response || {};
      addEvent("response", `${commandLabels[response.command] || response.command || "命令"}：${response.success === false ? "失败" : "成功"}`);
      appRpc.refreshCatalog();
    }
  };

  useEffect(() => {
    activeAssistantIdRef.current = null;
    setConnected(false);
    setStatus({ processRunning: false, isAgentRunning: false, workspace: "" });
    setRunState({ phase: "idle", label: conversationId ? "Pi 空闲，等待输入" : "请选择或创建会话" });
    setMessages([
      {
        id: `system-${conversationId || "empty"}`,
        role: "system",
        text: conversationId ? `已打开会话：${conversation?.title || conversationId}` : "请选择或创建会话。",
      },
    ]);
    setEvents([]);
    setToolEvents([]);
    setStatuses({});
    setWidgets({});
    setDialog(null);
  }, [conversationId]);

  useEffect(() => {
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    socketRef.current?.close();
    socketRef.current = null;
    if (!conversationId) return undefined;

    let disposed = false;
    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const query = new URLSearchParams({ conversationId });
      if (appRpc.token) query.set("token", appRpc.token);
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws?${query}`);
      socketRef.current = socket;

      socket.addEventListener("open", () => setConnected(true));
      socket.addEventListener("message", (event) => {
        try {
          handleServerMessage(JSON.parse(event.data));
        } catch (error) {
          addEvent("client", `服务端消息格式错误：${error.message}`);
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        setConnected(false);
        applyStatus({ processRunning: false, isAgentRunning: false });
        reconnectTimerRef.current = window.setTimeout(connect, 2500);
      });
      socket.addEventListener("error", () => appRpc.pushToast(`会话 ${conversation?.title || conversationId} 的 WebSocket 连接异常`, "error"));
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [appRpc.token, conversationId]);

  const send = (payload) => {
    const socket = socketRef.current;
    if (!conversationId) {
      appRpc.pushToast("请先选择或创建会话", "error");
      return false;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appRpc.pushToast("WebSocket 尚未连接", "error");
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  };

  const submitPrompt = (text) => {
    const content = text.trim();
    if (!content) return false;
    if (send({ type: "prompt", message: content })) {
      setRunState({ phase: "queued", label: status.isAgentRunning ? "消息已排队，Pi 会在当前任务后处理" : "消息已发送，等待 Pi 接收" });
      setMessages((list) => [...list, { id: createId("user"), role: "user", text: content }]);
      return true;
    }
    return false;
  };

  const respondToDialog = (cancelled, value) => {
    if (!dialog) return;
    const response = { id: dialog.id };
    if (cancelled) response.cancelled = true;
    else if (dialog.method === "confirm") response.confirmed = true;
    else response.value = value || "";
    send({ type: "extension_ui_response", response });
    setDialog(null);
  };

  return {
    conversationId,
    connected,
    status,
    runState,
    messages,
    events,
    toolEvents,
    statuses,
    widgets,
    dialog,
    submitPrompt,
    abort: () => send({ type: "abort" }),
    restart: () => send({ type: "restart" }),
    refreshState: () => send({ type: "get_state" }),
    clearEvents: () => setEvents([]),
    respondToDialog,
  };
}

export function App() {
  const rpc = usePiRpc();
  const [layout, setLayout] = useState(() => loadLayout() || createLeaf(null));
  const [focusedPaneId, setFocusedPaneId] = useState(() => findFirstPaneId(layout));
  const [maximizedPaneId, setMaximizedPaneId] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const openConversationIds = useMemo(() => getOpenConversationIds(layout), [layout]);

  useEffect(() => {
    window.localStorage.setItem("piRpcSplitLayout", JSON.stringify(layout));
    if (!focusedPaneId || !findFirstPaneId(layout)) setFocusedPaneId(findFirstPaneId(layout));
  }, [layout, focusedPaneId]);

  const splitPane = (paneId, direction) => {
    if (countLeaves(layout) >= 6) {
      rpc.pushToast("同屏最多打开 6 个 pane", "error");
      return;
    }
    const newLeaf = createLeaf(null);
    setLayout((current) => splitLeaf(current, paneId, direction, newLeaf));
    setFocusedPaneId(newLeaf.paneId);
  };

  const closePane = (paneId) => {
    setLayout((current) => removeLeaf(current, paneId) || createLeaf(null));
    if (focusedPaneId === paneId) setFocusedPaneId(null);
    if (maximizedPaneId === paneId) setMaximizedPaneId(null);
  };

  const setPaneConversation = (paneId, conversationId) => {
    const existingPaneId = findPaneByConversation(layout, conversationId);
    if (existingPaneId && existingPaneId !== paneId) {
      setFocusedPaneId(existingPaneId);
      rpc.setActiveConversationId(conversationId);
      return;
    }
    setLayout((current) => updateLeaf(current, paneId, (leaf) => ({ ...leaf, conversationId })));
    setFocusedPaneId(paneId);
    rpc.setActiveConversationId(conversationId);
  };

  const openConversation = (conversationId) => {
    const existingPaneId = findPaneByConversation(layout, conversationId);
    if (existingPaneId) {
      setFocusedPaneId(existingPaneId);
      rpc.setActiveConversationId(conversationId);
      return;
    }

    const targetPaneId = focusedPaneId && !findLeaf(layout, focusedPaneId)?.conversationId
      ? focusedPaneId
      : findFirstEmptyPaneId(layout) || focusedPaneId || findFirstPaneId(layout);
    if (targetPaneId) setPaneConversation(targetPaneId, conversationId);
  };

  const createConversationForPane = async (paneId, workspaceId) => {
    const conversation = await rpc.createConversation(workspaceId);
    if (conversation) setPaneConversation(paneId, conversation.id);
  };

  return (
    <div className="h-dvh overflow-hidden bg-[linear-gradient(180deg,_#f6f8f7,_#edf2f0)] text-slate-950">
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
        <Header rpc={rpc} />
        <main className={cn(
          "grid h-full min-h-0 overflow-hidden max-[1180px]:grid-rows-[minmax(0,1fr)_minmax(180px,34vh)]",
          sidebarCollapsed
            ? "grid-cols-[52px_minmax(0,1fr)_390px] max-[1180px]:grid-cols-[52px_minmax(0,1fr)]"
            : "grid-cols-[280px_minmax(0,1fr)_390px] max-[1180px]:grid-cols-[240px_minmax(0,1fr)]",
        )}>
          <WorkspaceSidebar rpc={rpc} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((value) => !value)} openConversationIds={openConversationIds} onOpenConversation={openConversation} />
          <SplitWorkbench
            rpc={rpc}
            layout={layout}
            focusedPaneId={focusedPaneId || findFirstPaneId(layout)}
            maximizedPaneId={maximizedPaneId}
            onFocus={setFocusedPaneId}
            onSplit={splitPane}
            onClose={closePane}
            onMaximize={setMaximizedPaneId}
            onPaneConversation={setPaneConversation}
            onCreateConversation={createConversationForPane}
          />
          <div className="max-[1180px]:col-span-2">
            <SidePanel rpc={rpc} />
          </div>
        </main>
      </div>
      <TokenDialog rpc={rpc} />
      <ExtensionDialog dialog={rpc.dialog} onRespond={rpc.respondToDialog} />
      <ToastStack toasts={rpc.toasts} onDismiss={rpc.dismissToast} />
    </div>
  );
}

function WorkspaceSidebar({ rpc, collapsed, onToggleCollapsed, openConversationIds, onOpenConversation }) {
  if (collapsed) {
    return (
      <aside className="flex min-h-0 items-start justify-center border-r border-slate-200/80 bg-[#f3f7f5] p-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="展开会话栏"
          className="flex h-14 w-9 flex-col items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-900"
        >
          <PanelLeftOpen className="size-4" />
          <span className="text-[11px] leading-none">展开</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="min-h-0 overflow-y-auto border-r border-slate-200/80 bg-[#f3f7f5] p-3">
      <div className="mb-3 flex items-center justify-between gap-2 px-1">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">工作区 / 会话</h2>
          <p className="text-xs text-slate-500">后台会话会继续运行</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button onClick={rpc.refreshCatalog} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">刷新</button>
          <button onClick={onToggleCollapsed} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50" title="收起会话栏"><PanelLeftClose className="size-3.5" />收起</button>
        </div>
      </div>
      <div className="space-y-3">
        {rpc.workspaces.map((workspace) => {
          const conversations = rpc.conversations.filter((conversation) => conversation.workspaceId === workspace.id);
          return (
            <section key={workspace.id} className="rounded-2xl border border-slate-200/90 bg-white/80 p-2 shadow-sm">
              <div className="mb-2 flex items-start justify-between gap-2 px-1">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-800">{workspace.name}</div>
                  <div className="truncate text-xs text-slate-500">{workspace.path}</div>
                </div>
                <button onClick={() => rpc.createConversation(workspace.id)} className="shrink-0 rounded-lg bg-slate-700 px-2 py-1 text-xs text-white hover:bg-slate-800">+ 会话</button>
              </div>
              <div className="space-y-1">
                {conversations.map((conversation) => (
                  <ConversationItem
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === rpc.activeConversationId}
                    open={openConversationIds.has(conversation.id)}
                    onClick={() => onOpenConversation(conversation.id)}
                  />
                ))}
                {!conversations.length && <div className="px-2 py-3 text-xs text-slate-400">暂无会话</div>}
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function ConversationItem({ conversation, active, open, onClick }) {
  const running = conversation.runtime?.isAgentRunning || conversation.status === "running";
  const processRunning = conversation.runtime?.processRunning || conversation.status === "idle" || running;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-xl border px-2 py-2 text-left transition",
        active || open ? "border-sky-200 bg-sky-50 text-sky-900" : "border-transparent bg-transparent text-slate-700 hover:bg-slate-50",
      )}
    >
      <span className={cn("size-2 shrink-0 rounded-full", running ? "bg-sky-500" : processRunning ? "bg-emerald-500" : "bg-slate-300")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{conversation.title}</span>
        <span className="block truncate text-xs text-slate-500">{open ? "已在 pane 中打开" : running ? "执行中" : processRunning ? "空闲" : "已停止"}</span>
      </span>
    </button>
  );
}

function Header({ rpc }) {
  return (
    <header className="flex min-h-16 items-center border-b border-slate-200/80 bg-[#f9fbfa]/90 px-5 py-3 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-slate-800 text-sm font-bold text-white shadow-sm">pi</div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-lg font-semibold tracking-normal">Pi 远程对话</h1>
            <span className="hidden rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-xs text-cyan-700 sm:inline-flex">RPC 工作台</span>
          </div>
          <p className="truncate text-sm text-slate-500">{rpc.status.workspace || "/WorkSpace/pmCloud_New"}</p>
        </div>
      </div>
    </header>
  );
}

function SplitWorkbench({ rpc, layout, focusedPaneId, maximizedPaneId, onFocus, onSplit, onClose, onMaximize, onPaneConversation, onCreateConversation }) {
  const maximizedNode = maximizedPaneId ? findLeaf(layout, maximizedPaneId) : null;
  return (
    <section className="h-full min-h-0 overflow-hidden bg-[#f8faf9]/65">
      {maximizedNode ? (
        <PaneView
          node={maximizedNode}
          rpc={rpc}
          focused
          maximized
          onFocus={onFocus}
          onSplit={onSplit}
          onClose={onClose}
          onMaximize={onMaximize}
          onPaneConversation={onPaneConversation}
          onCreateConversation={onCreateConversation}
        />
      ) : (
        <SplitNode
          node={layout}
          rpc={rpc}
          focusedPaneId={focusedPaneId}
          onFocus={onFocus}
          onSplit={onSplit}
          onClose={onClose}
          onMaximize={onMaximize}
          onPaneConversation={onPaneConversation}
          onCreateConversation={onCreateConversation}
        />
      )}
    </section>
  );
}

function findLeaf(node, paneId) {
  if (!node) return null;
  if (node.type === "leaf") return node.paneId === paneId ? node : null;
  return findLeaf(node.first, paneId) || findLeaf(node.second, paneId);
}

function SplitNode(props) {
  const { node } = props;
  if (node.type === "leaf") return <PaneView {...props} focused={node.paneId === props.focusedPaneId} />;
  return (
    <Group orientation={node.direction} className="h-full min-h-0 w-full overflow-hidden">
      <Panel minSize={18} defaultSize={50} className="min-h-0 min-w-0 overflow-hidden">
        <SplitNode {...props} node={node.first} />
      </Panel>
      <Separator className={cn("bg-slate-200 transition hover:bg-cyan-300", node.direction === "horizontal" ? "w-1" : "h-1")} />
      <Panel minSize={18} defaultSize={50} className="min-h-0 min-w-0 overflow-hidden">
        <SplitNode {...props} node={node.second} />
      </Panel>
    </Group>
  );
}

function PaneView({ node, rpc, focused, maximized, onFocus, onSplit, onClose, onMaximize, onPaneConversation, onCreateConversation }) {
  const conversationId = node.conversationId || "";
  const conversation = rpc.conversations.find((item) => item.id === conversationId);
  const paneRpc = usePaneRpc(conversationId, rpc);

  const focusPane = () => {
    onFocus(node.paneId);
    if (conversationId && conversationId !== rpc.activeConversationId) rpc.setActiveConversationId(conversationId);
  };

  return (
    <div onMouseDown={focusPane} className={cn("grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border", focused ? "border-cyan-300 bg-white" : "border-slate-200 bg-white/65")}>
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/90 px-2 py-1.5">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-slate-700">{conversation?.title || "选择会话"}</div>
          <div className="truncate text-[11px] text-slate-500">{conversation?.id || node.paneId}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <select value={conversationId || ""} onChange={(event) => event.target.value && onPaneConversation(node.paneId, event.target.value)} className="h-7 max-w-36 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700">
            <option value="">选择会话</option>
            {rpc.conversations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          <button onClick={() => onSplit(node.paneId, "horizontal")} className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-200">左右</button>
          <button onClick={() => onSplit(node.paneId, "vertical")} className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-200">上下</button>
          <button onClick={() => onMaximize(maximized ? null : node.paneId)} className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-200">{maximized ? "还原" : "最大"}</button>
          <button onClick={() => onClose(node.paneId)} className="rounded-md px-2 py-1 text-xs text-rose-600 hover:bg-rose-50">关闭</button>
        </div>
      </div>
      {conversationId ? (
        <>
          <ChatPane rpc={paneRpc} conversationId={conversationId} />
          <ExtensionDialog dialog={paneRpc.dialog} onRespond={paneRpc.respondToDialog} />
        </>
      ) : (
        <PaneConversationPicker rpc={rpc} paneId={node.paneId} onPaneConversation={onPaneConversation} onCreateConversation={onCreateConversation} />
      )}
    </div>
  );
}

function PaneConversationPicker({ rpc, paneId, onPaneConversation, onCreateConversation }) {
  const defaultWorkspaceId = rpc.workspaces[0]?.id || "pmcloud";
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">为这个 pane 选择会话</h2>
        <p className="mt-1 text-xs text-slate-500">分屏后每个 pane 需要显式绑定一个 Pi 会话。</p>
      </div>
      <div className="grid gap-2">
        {rpc.conversations.map((item) => {
          const running = item.runtime?.isAgentRunning || item.status === "running";
          const processRunning = item.runtime?.processRunning || item.status === "idle" || running;
          return (
            <button key={item.id} type="button" onClick={() => onPaneConversation(paneId, item.id)} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-700 hover:border-cyan-200 hover:bg-cyan-50/60">
              <span className={cn("size-2 shrink-0 rounded-full", running ? "bg-sky-500" : processRunning ? "bg-emerald-500" : "bg-slate-300")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{item.title}</span>
                <span className="block truncate text-xs text-slate-500">{running ? "执行中" : processRunning ? "空闲" : "已停止"}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-auto border-t border-slate-200 pt-4">
        <Button variant="secondary" onClick={() => onCreateConversation(paneId, defaultWorkspaceId)}>新建 Pi 会话</Button>
      </div>
    </div>
  );
}

function ChatPane({ rpc, conversationId }) {
  const [draft, setDraft] = useState("");
  const viewportRef = useRef(null);

  useEffect(() => {
    const handler = (event) => setDraft(event.detail || "");
    const eventName = `pi:set-composer-text:${conversationId}`;
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  }, [conversationId]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [rpc.messages]);

  const send = () => {
    if (rpc.submitPrompt(draft)) setDraft("");
  };

  return (
    <section className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden border-r border-slate-200/80 bg-[#f8faf9]/65 max-[1080px]:border-r-0">
      <div ref={viewportRef} className="min-h-0 overflow-y-auto px-5 py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          {rpc.messages.map((message) => <MessageBubble key={message.id} message={message} />)}
        </div>
      </div>
      <div className="border-t border-slate-200/80 bg-[#f9fbfa]/92 p-4 backdrop-blur-xl">
        <div className={cn(
          "mx-auto max-w-5xl rounded-2xl border bg-white p-2 shadow-[0_18px_46px_rgba(15,23,42,0.07)] transition-colors",
          rpc.status.isAgentRunning ? "border-sky-200/90" : "border-slate-200/90",
        )}>
          <ComposerStatus runState={rpc.runState} connected={rpc.connected} />
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                send();
              }
            }}
            rows={3}
            placeholder="让 Pi 检查、修改或解释当前工作区"
            className="max-h-52 min-h-20 w-full resize-y rounded-xl border-0 bg-transparent px-3 py-3 text-[15px] leading-6 outline-none placeholder:text-slate-400"
          />
          <div className="flex items-center justify-between gap-3 px-2 pb-1">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Command className="size-3.5" />
              <span>Enter 发送，Shift + Enter 换行。Pi 忙碌时新消息会排队。</span>
            </div>
            <Button onClick={send} disabled={!rpc.connected || !draft.trim()} icon={SendHorizontal}>发送</Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ComposerStatus({ runState, connected }) {
  const active = ["running", "thinking", "responding", "tool", "queued"].includes(runState.phase);
  const failed = runState.phase === "error";

  return (
    <div className={cn(
      "mb-1 flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs",
      active && "border-sky-200 bg-sky-50 text-sky-700",
      !active && !failed && connected && "border-emerald-200 bg-emerald-50 text-emerald-700",
      failed && "border-rose-200 bg-rose-50 text-rose-700",
      !connected && "border-amber-200 bg-amber-50 text-amber-700",
    )}>
      <div className="flex min-w-0 items-center gap-2">
        {active ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : connected ? <CheckCircle2 className="size-3.5 shrink-0" /> : <Clock3 className="size-3.5 shrink-0" />}
        <span className="truncate">{connected ? runState.label : "未连接到 Pi，消息暂时无法发送"}</span>
      </div>
      {active && <span className="hidden shrink-0 text-sky-600/80 sm:inline">可继续输入，新消息会排队</span>}
    </div>
  );
}

function MessageBubble({ message }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isAssistant = message.role === "assistant";

  if (isAssistant) {
    return (
      <article className="flex justify-start">
        <div className="w-full max-w-5xl rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
              <Bot className="size-3.5" />
              <span>Pi 输出</span>
              {message.streaming && <span className="inline-flex items-center gap-1 text-sky-600"><Loader2 className="size-3 animate-spin" />生成中</span>}
            </div>
          </div>
          <div className="px-4 py-3">
            <AssistantMarkdown text={message.text} />
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={cn("flex", isUser ? "justify-end" : "justify-start", isSystem && "justify-center")}>
      <div className={cn(
        "max-w-[min(820px,92%)] rounded-2xl border px-4 py-3 shadow-sm",
        isUser && "border-sky-200 bg-sky-50 text-sky-950",
        message.role === "assistant" && "border-slate-200 bg-white text-slate-900",
        isSystem && "border-amber-200 bg-amber-50/80 text-slate-800",
      )}>
        <div className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-500">
          {message.role === "assistant" ? <Bot className="size-3.5" /> : isUser ? <MessagesSquare className="size-3.5" /> : <Sparkles className="size-3.5" />}
          <span>{isUser ? "我" : message.role === "assistant" ? "Pi" : "系统"}</span>
          {message.streaming && <span className="inline-flex items-center gap-1 text-sky-600"><Loader2 className="size-3 animate-spin" />生成中</span>}
        </div>
        <div className="whitespace-pre-wrap break-words text-[15px] leading-7"><PathAwareText text={message.text} /></div>
      </div>
    </article>
  );
}

function AssistantMarkdown({ text }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="my-2 leading-7 text-slate-800">{children}</p>,
        h1: ({ children }) => <h1 className="mb-3 mt-1 text-xl font-semibold text-slate-950">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-5 border-b border-slate-200 pb-1 text-lg font-semibold text-slate-950">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold text-slate-900">{children}</h3>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 text-slate-800">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 text-slate-800">{children}</ol>,
        li: ({ children }) => <li className="leading-7">{children}</li>,
        blockquote: ({ children }) => <blockquote className="my-3 border-l-4 border-sky-200 bg-sky-50/60 px-3 py-2 text-slate-700">{children}</blockquote>,
        a: ({ children, href }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
        table: ({ children }) => <div className="my-3 overflow-x-auto rounded-xl border border-slate-200"><table className="w-full border-collapse text-sm">{children}</table></div>,
        th: ({ children }) => <th className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-left font-medium text-slate-700">{children}</th>,
        td: ({ children }) => <td className="border-b border-slate-100 px-3 py-2 align-top text-slate-700">{children}</td>,
        code: ({ className, children }) => {
          const value = String(children ?? "");
          const language = /language-(\w+)/.exec(className || "")?.[1];
          if (!language && !value.includes("\n")) return <InlineCode>{value}</InlineCode>;
          return <CodeBlock language={language} code={value.replace(/\n$/, "")} />;
        },
        pre: ({ children }) => <>{children}</>,
        text: ({ children }) => <PathAwareText text={String(children)} />,
      }}
    >
      {text || ""}
    </ReactMarkdown>
  );
}

function isExternalHref(href = "") {
  return /^(https?:|mailto:|tel:)/i.test(href);
}

function isHashHref(href = "") {
  return href.startsWith("#");
}

function textFromChildren(children) {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textFromChildren).join("");
  return "";
}

function MarkdownLink({ children, href }) {
  if (isExternalHref(href)) {
    return (
      <a className="font-medium text-sky-700 underline underline-offset-4" href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }

  if (isHashHref(href)) {
    return <a className="font-medium text-sky-700 underline underline-offset-4" href={href}>{children}</a>;
  }

  const label = textFromChildren(children) || href || "";
  return <PathToken value={label} title={href && href !== label ? href : undefined} />;
}

function CodeBlock({ language, code }) {
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-950">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-xs text-slate-400">
        <span>{language || "code"}</span>
      </div>
      <pre className="overflow-x-auto p-3 text-sm leading-6 text-slate-100"><code>{code}</code></pre>
    </div>
  );
}

function InlineCode({ children }) {
  return <code className="rounded-md border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[0.92em] text-slate-800">{children}</code>;
}

function PathAwareText({ text }) {
  const pattern = /((?:\.?\.?\/|\/)?(?:[\w.@-]+\/)+[\w.@-]+(?:\.[\w-]+)?|[\w.-]+\.(?:jsx?|tsx?|vue|java|kt|py|go|rs|md|ya?ml|json|css|scss|html|sql|sh|xml|properties))(?:[:#]\d+)?/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(<PathToken key={`${match[0]}-${match.index}`} value={match[0]} />);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

function PathToken({ value, title }) {
  return (
    <span title={title} className="rounded-md border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 font-mono text-[0.92em] text-cyan-800 underline decoration-cyan-300 underline-offset-4">
      {value}
    </span>
  );
}

function SidePanel({ rpc }) {
  const statusEntries = Object.entries(rpc.statuses || {});
  const widgetEntries = Object.values(rpc.widgets || {});

  return (
    <aside className="min-h-0 overflow-y-auto border-l border-slate-200/80 bg-[#eef4f2] p-4 text-slate-900">
      <div className="flex flex-col gap-3">
        <PanelCard title="运行状态" icon={Cpu}>
          <InfoGrid items={[
            ["Pi", rpc.status.processRunning ? "运行中" : "已停止"],
            ["任务", rpc.status.isAgentRunning ? "执行中" : "空闲"],
            ["PID", rpc.status.pid || "-"],
            ["启动", formatTime(rpc.status.startedAt)],
          ]} />
        </PanelCard>

        <PanelCard title="扩展状态" icon={PanelRight}>
          {statusEntries.length ? <KeyValueList entries={statusEntries} /> : <EmptyText>暂无扩展状态。</EmptyText>}
        </PanelCard>

        <PanelCard title="扩展面板" icon={Sparkles}>
          {widgetEntries.length ? <WidgetList widgets={widgetEntries} /> : <EmptyText>暂无扩展面板。</EmptyText>}
        </PanelCard>

        <PanelCard title="工具日志" icon={Wrench}>
          {rpc.toolEvents.length ? <EventList events={rpc.toolEvents} tool /> : <EmptyText>暂无工具调用。</EmptyText>}
        </PanelCard>

        <PanelCard title="事件" icon={TerminalSquare} action={<button onClick={rpc.clearEvents} className="text-xs text-slate-500 hover:text-slate-800">清空</button>}>
          {rpc.events.length ? <EventList events={rpc.events} /> : <EmptyText>暂无事件。</EmptyText>}
        </PanelCard>
      </div>
    </aside>
  );
}

function PanelCard({ title, icon: Icon, action, children }) {
  return (
    <section className="rounded-2xl border border-slate-200/90 bg-white/78 p-4 shadow-[0_10px_24px_rgba(15,23,42,0.04)] backdrop-blur-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium text-slate-800"><Icon className="size-4 text-cyan-600" />{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function InfoGrid({ items }) {
  return (
    <dl className="grid gap-2 text-sm">
      {items.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
          <dt className="text-slate-500">{key}</dt>
          <dd className="break-words text-slate-700">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function KeyValueList({ entries }) {
  return (
    <div className="grid gap-2">
      {entries.map(([key, value]) => (
        <div key={key} className="rounded-xl border border-slate-200/90 bg-slate-50/80 p-3">
          <div className="text-xs text-slate-500">{key}</div>
          <div className="mt-1 break-words text-sm text-slate-700">{value}</div>
        </div>
      ))}
    </div>
  );
}

function WidgetList({ widgets }) {
  return (
    <div className="grid gap-2">
      {widgets.map((widget) => (
        <div key={widget.key} className="rounded-xl border border-slate-200/90 bg-slate-50/80 p-3">
          <div className="text-xs text-slate-500">{widget.key}</div>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-slate-700">{(widget.lines || []).join("\n")}</pre>
        </div>
      ))}
    </div>
  );
}

function EventList({ events, tool = false }) {
  return (
    <div className="max-h-64 overflow-y-auto pr-1">
      <div className="flex flex-col-reverse gap-2">
        {events.map((event) => (
          <div key={event.id} className="rounded-xl border border-slate-200/90 bg-slate-50/80 p-3 text-xs">
            <div className="flex items-center justify-between gap-2 text-slate-500">
              <span>{tool ? event.toolName : eventLabels[event.type] || event.type}</span>
              <span>{event.at?.toLocaleTimeString?.() || ""}</span>
            </div>
            <div className="mt-1 break-words text-slate-700">{tool ? event.detail : event.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyText({ children }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}

function TokenDialog({ rpc }) {
  const [value, setValue] = useState(rpc.token || "");
  if (rpc.token || rpc.connected) return null;
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-slate-800 text-white"><KeyRound className="size-5" /></div>
          <div>
            <h2 className="font-semibold">访问 Token</h2>
            <p className="text-sm text-slate-500">请输入服务端启动时打印的 token，或打开完整 token 链接。</p>
          </div>
        </div>
        <input value={value} onChange={(event) => setValue(event.target.value)} className="h-11 w-full rounded-xl border border-slate-200 px-3 outline-none focus:border-sky-400 focus:ring-4 focus:ring-sky-100" placeholder="访问 token" />
        <div className="mt-4 flex justify-end">
          <Button onClick={() => rpc.setToken(value.trim())} disabled={!value.trim()}>连接</Button>
        </div>
      </div>
    </div>
  );
}

function ExtensionDialog({ dialog, onRespond }) {
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(dialog?.prefill || "");
  }, [dialog?.id]);

  if (!dialog) return null;
  const isConfirm = dialog.method === "confirm";

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
        <h2 className="text-base font-semibold">{dialog.title || "Pi 请求确认"}</h2>
        {dialog.message && <p className="mt-2 text-sm text-slate-500">{dialog.message}</p>}
        {!isConfirm && (
          <div className="mt-4">
            {dialog.method === "select" ? (
              <select value={value} onChange={(event) => setValue(event.target.value)} className="h-11 w-full rounded-xl border border-slate-200 px-3 outline-none focus:border-sky-400 focus:ring-4 focus:ring-sky-100">
                {(dialog.options || []).map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : dialog.method === "editor" ? (
              <textarea value={value} onChange={(event) => setValue(event.target.value)} className="min-h-44 w-full rounded-xl border border-slate-200 p-3 outline-none focus:border-sky-400 focus:ring-4 focus:ring-sky-100" />
            ) : (
              <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={dialog.placeholder || ""} className="h-11 w-full rounded-xl border border-slate-200 px-3 outline-none focus:border-sky-400 focus:ring-4 focus:ring-sky-100" />
            )}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onRespond(true)}>取消</Button>
          <Button onClick={() => onRespond(false, value)}>{isConfirm ? "确认" : "提交"}</Button>
        </div>
      </div>
    </div>
  );
}

function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className={cn("rounded-2xl border bg-white p-4 shadow-xl", toast.variant === "error" ? "border-red-200" : "border-slate-200")}>
          <div className="flex items-start gap-3">
            <div className={cn("mt-0.5 size-2 rounded-full", toast.variant === "error" ? "bg-red-500" : "bg-sky-500")} />
            <div className="min-w-0 flex-1 break-words text-sm text-slate-800">{toast.text}</div>
            <button onClick={() => onDismiss(toast.id)} className="text-slate-400 hover:text-slate-700"><X className="size-4" /></button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Button({ children, icon: Icon, variant = "primary", disabled, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" && "bg-slate-700 text-white shadow-sm hover:bg-slate-800",
        variant === "secondary" && "border border-slate-200 bg-white/85 text-slate-700 hover:bg-slate-50",
        variant === "danger" && "bg-rose-500 text-white shadow-sm hover:bg-rose-600",
      )}
    >
      {Icon && <Icon className="size-4" />}
      {children}
    </button>
  );
}
