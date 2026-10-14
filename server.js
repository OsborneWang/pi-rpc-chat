import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "dist");
const publicDir = path.join(__dirname, "public");
const runtimeDir = path.join(__dirname, ".runtime");
const tokenFile = path.join(runtimeDir, "token");
const workspacesFile = path.join(runtimeDir, "workspaces.json");
const conversationsFile = path.join(runtimeDir, "conversations.json");
const historiesDir = path.join(runtimeDir, "histories");

const DEFAULT_WORKSPACE_PATH = process.env.PI_WORKSPACE || "/WorkSpace/pmCloud_New";
const DEFAULT_WORKSPACE_ID = "pmcloud";
const DEFAULT_CONVERSATION_ID = "conv_default";
const MAX_RUNNING_RUNTIMES = Number(process.env.PI_RPC_CHAT_MAX_RUNTIMES || 4);
const MAX_RUNNING_PER_WORKSPACE = Number(process.env.PI_RPC_CHAT_MAX_RUNTIMES_PER_WORKSPACE || 3);

async function resolveToken() {
  const authEnabled = Boolean(process.env.PI_RPC_CHAT_TOKEN) || process.env.PI_RPC_CHAT_REQUIRE_TOKEN === "1";
  if (!authEnabled || process.env.PI_RPC_CHAT_NO_AUTH === "1") {
    return { token: "", tokenSource: "disabled" };
  }

  const token = process.env.PI_RPC_CHAT_TOKEN || crypto.randomBytes(18).toString("base64url");
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await fs.chmod(tokenFile, 0o600).catch(() => undefined);

  return {
    token,
    tokenSource: process.env.PI_RPC_CHAT_TOKEN ? "PI_RPC_CHAT_TOKEN and .runtime/token" : ".runtime/token",
  };
}

const tokenInfo = await resolveToken();

const config = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 3030),
  piBin: process.env.PI_BIN || "pi",
  authDisabled: !tokenInfo.token,
  token: tokenInfo.token,
  tokenSource: tokenInfo.tokenSource,
  tokenFile,
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function staticRoot() {
  try {
    await fs.access(path.join(distDir, "index.html"));
    return distDir;
  } catch {
    return publicDir;
  }
}

function parseUrl(req) {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

function tokenFromRequest(req, url = parseUrl(req)) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return req.headers["x-pi-chat-token"] || url.searchParams.get("token") || "";
}

function isAuthorized(req, url) {
  return config.authDisabled || tokenFromRequest(req, url) === config.token;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function safeFileId(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
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

function normalizeChatMessage(message) {
  if (!message || !["user", "assistant", "system"].includes(message.role)) return null;
  const text = typeof message.text === "string" ? message.text : extractMessageText(message);
  if (!text.trim()) return null;
  return {
    id: String(message.id || makeId("msg")),
    role: message.role,
    text,
    streaming: Boolean(message.streaming),
    createdAt: message.createdAt || nowIso(),
    updatedAt: message.updatedAt || nowIso(),
  };
}

class ChatHistoryStore {
  constructor() {
    this.histories = new Map();
    this.saveTimers = new Map();
  }

  historyFile(conversationId) {
    return path.join(historiesDir, `${safeFileId(conversationId)}.json`);
  }

  async loadAll(conversations) {
    await fs.mkdir(historiesDir, { recursive: true });
    await Promise.all(conversations.map((conversation) => this.load(conversation.id)));
  }

  async load(conversationId) {
    if (this.histories.has(conversationId)) return this.histories.get(conversationId);
    let messages = [];
    try {
      const raw = await fs.readFile(this.historyFile(conversationId), "utf8");
      const parsed = JSON.parse(raw);
      messages = (Array.isArray(parsed?.messages) ? parsed.messages : [])
        .map((message) => normalizeChatMessage({ ...message, streaming: false }))
        .filter(Boolean);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const history = { messages, activeAssistantId: null };
    this.histories.set(conversationId, history);
    return history;
  }

  get(conversationId) {
    if (!this.histories.has(conversationId)) this.histories.set(conversationId, { messages: [], activeAssistantId: null });
    return this.histories.get(conversationId);
  }

  snapshot(conversationId) {
    return this.get(conversationId).messages.map((message) => ({ ...message }));
  }

  schedulePersist(conversationId) {
    if (this.saveTimers.has(conversationId)) clearTimeout(this.saveTimers.get(conversationId));
    const timer = setTimeout(() => {
      this.saveTimers.delete(conversationId);
      this.persist(conversationId).catch((error) => console.error(`保存会话历史失败：${error.message}`));
    }, 250);
    timer.unref?.();
    this.saveTimers.set(conversationId, timer);
  }

  async persist(conversationId) {
    const history = this.get(conversationId);
    await fs.mkdir(historiesDir, { recursive: true });
    const messages = history.messages.map((message) => ({ ...message, streaming: false }));
    await fs.writeFile(this.historyFile(conversationId), `${JSON.stringify({ messages }, null, 2)}\n`, "utf8");
  }

  async delete(conversationId) {
    if (this.saveTimers.has(conversationId)) {
      clearTimeout(this.saveTimers.get(conversationId));
      this.saveTimers.delete(conversationId);
    }
    this.histories.delete(conversationId);
    await fs.rm(this.historyFile(conversationId), { force: true });
  }

  pushMessage(conversationId, message) {
    const normalized = normalizeChatMessage(message);
    if (!normalized) return null;
    const history = this.get(conversationId);
    history.messages.push(normalized);
    if (history.messages.length > 300) history.messages.splice(0, history.messages.length - 300);
    this.schedulePersist(conversationId);
    return normalized;
  }

  addUserMessage(conversationId, text) {
    return this.pushMessage(conversationId, { id: makeId("user"), role: "user", text, createdAt: nowIso(), updatedAt: nowIso() });
  }

  ensureAssistantMessage(conversationId) {
    const history = this.get(conversationId);
    if (history.activeAssistantId && history.messages.some((message) => message.id === history.activeAssistantId)) return history.activeAssistantId;
    const message = {
      id: makeId("assistant"),
      role: "assistant",
      text: "",
      streaming: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    history.messages.push(message);
    if (history.messages.length > 300) history.messages.splice(0, history.messages.length - 300);
    history.activeAssistantId = message.id;
    this.schedulePersist(conversationId);
    return message.id;
  }

  updateAssistantText(conversationId, text, mode = "append") {
    const assistantId = this.ensureAssistantMessage(conversationId);
    if (!assistantId) return;
    const history = this.get(conversationId);
    const message = history.messages.find((item) => item.id === assistantId);
    if (!message) return;
    message.text = mode === "replace" ? text : `${message.text || ""}${text}`;
    message.streaming = true;
    message.updatedAt = nowIso();
    this.schedulePersist(conversationId);
  }

  finalizeAssistant(conversationId, text = "") {
    const history = this.get(conversationId);
    const finalText = text.trim();
    const assistantId = history.activeAssistantId;
    if (!assistantId) {
      const lastMessage = history.messages[history.messages.length - 1];
      if (finalText && lastMessage?.role === "assistant") {
        if (lastMessage.text !== finalText) {
          lastMessage.text = finalText;
          lastMessage.streaming = false;
          lastMessage.updatedAt = nowIso();
          this.schedulePersist(conversationId);
        }
        return;
      }
      const lastAssistant = [...history.messages].reverse().find((message) => message.role === "assistant");
      if (finalText && lastAssistant?.text !== finalText) {
        this.pushMessage(conversationId, { id: makeId("assistant"), role: "assistant", text: finalText, createdAt: nowIso(), updatedAt: nowIso() });
      }
      return;
    }
    history.activeAssistantId = null;
    const index = history.messages.findIndex((message) => message.id === assistantId);
    if (index === -1) return;
    const message = history.messages[index];
    const nextText = finalText || message.text || "";
    if (!nextText.trim()) {
      history.messages.splice(index, 1);
    } else {
      history.messages[index] = { ...message, text: nextText, streaming: false, updatedAt: nowIso() };
    }
    this.schedulePersist(conversationId);
  }

  recordRpcRecord(conversationId, record) {
    if (record.type === "message_update") {
      const update = record.assistantMessageEvent;
      if (update?.type === "text_delta") this.updateAssistantText(conversationId, update.delta || "");
      if (update?.type === "text_end") this.updateAssistantText(conversationId, update.content || "", "replace");
    } else if (record.type === "message_end" && record.message?.role === "assistant") {
      this.finalizeAssistant(conversationId, extractMessageText(record.message));
    } else if (record.type === "agent_settled") {
      this.finalizeAssistant(conversationId);
    }
  }
}

function slugifyId(value, fallbackPrefix) {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || makeId(fallbackPrefix);
}

async function ensureDirectory(dir) {
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) throw new Error(`不是目录：${dir}`);
}

class RegistryStore {
  constructor() {
    this.workspaces = [];
    this.conversations = [];
  }

  async load() {
    await fs.mkdir(runtimeDir, { recursive: true });
    this.workspaces = await readJsonFile(workspacesFile, []);
    this.conversations = await readJsonFile(conversationsFile, []);
    await this.ensureDefaults();
  }

  async ensureDefaults() {
    if (!this.workspaces.some((workspace) => workspace.id === DEFAULT_WORKSPACE_ID)) {
      this.workspaces.push({
        id: DEFAULT_WORKSPACE_ID,
        name: "pmCloud 管理系统",
        path: DEFAULT_WORKSPACE_PATH,
        description: "默认工作区",
        createdAt: nowIso(),
        lastUsedAt: nowIso(),
      });
    }

    if (!this.conversations.some((conversation) => conversation.id === DEFAULT_CONVERSATION_ID)) {
      this.conversations.push({
        id: DEFAULT_CONVERSATION_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        title: "默认会话",
        createdAt: nowIso(),
        lastUsedAt: nowIso(),
        status: "stopped",
      });
    }

    await this.save();
  }

  async save() {
    await writeJsonFile(workspacesFile, this.workspaces);
    await writeJsonFile(conversationsFile, this.conversations);
  }

  getWorkspace(id) {
    return this.workspaces.find((workspace) => workspace.id === id) || null;
  }

  getConversation(id) {
    return this.conversations.find((conversation) => conversation.id === id) || null;
  }

  async createWorkspace(input) {
    const workspacePath = path.resolve(String(input.path || ""));
    await ensureDirectory(workspacePath);
    if (!workspacePath.startsWith("/WorkSpace")) throw new Error("第一版只允许添加 /WorkSpace 下的目录");
    if (this.workspaces.some((workspace) => workspace.path === workspacePath)) throw new Error("工作区路径已存在");

    const baseId = slugifyId(input.id || input.name || path.basename(workspacePath), "ws");
    let id = baseId;
    let suffix = 2;
    while (this.getWorkspace(id)) id = `${baseId}-${suffix++}`;

    const workspace = {
      id,
      name: String(input.name || path.basename(workspacePath)),
      path: workspacePath,
      description: String(input.description || ""),
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
    };
    this.workspaces.push(workspace);
    await this.save();
    return workspace;
  }

  async createConversation(input) {
    const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new Error("工作区不存在");
    const conversation = {
      id: makeId("conv"),
      workspaceId,
      title: String(input.title || "新会话"),
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
      status: "stopped",
    };
    this.conversations.push(conversation);
    await this.save();
    return conversation;
  }

  async touchConversation(id, patch = {}) {
    const conversation = this.getConversation(id);
    if (!conversation) return null;
    Object.assign(conversation, patch, { lastUsedAt: nowIso() });
    const workspace = this.getWorkspace(conversation.workspaceId);
    if (workspace) workspace.lastUsedAt = nowIso();
    await this.save();
    return conversation;
  }

  async deleteConversation(id) {
    const index = this.conversations.findIndex((conversation) => conversation.id === id);
    if (index === -1) return null;
    if (this.conversations.length <= 1) throw new Error("至少保留一个会话");
    const [conversation] = this.conversations.splice(index, 1);
    const workspace = this.getWorkspace(conversation.workspaceId);
    if (workspace) workspace.lastUsedAt = nowIso();
    await this.save();
    return conversation;
  }
}

class PiRpcBridge extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.child = null;
    this.decoder = new StringDecoder("utf8");
    this.stdoutBuffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.isAgentRunning = false;
    this.startedAt = null;
    this.lastExit = null;
    this.lastError = null;
    this.statuses = new Map();
    this.widgets = new Map();
    this.pendingDialogs = new Map();
    this.recentEvents = [];
    this.recentToolEvents = [];
    this.recentStderr = [];
  }

  get processRunning() {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }

  snapshot() {
    return {
      conversationId: this.options.conversationId,
      workspaceId: this.options.workspaceId,
      processRunning: this.processRunning,
      isAgentRunning: this.isAgentRunning,
      pid: this.child?.pid || null,
      startedAt: this.startedAt,
      lastExit: this.lastExit,
      lastError: this.lastError,
      workspace: this.options.workspace,
      piBin: this.options.piBin,
      statuses: Object.fromEntries(this.statuses),
      widgets: Object.fromEntries(this.widgets),
      pendingDialogs: Array.from(this.pendingDialogs.values()),
      recentToolEvents: this.recentToolEvents,
      recentEvents: this.recentEvents,
      recentStderr: this.recentStderr,
    };
  }

  async start() {
    if (this.processRunning) return;

    this.stdoutBuffer = "";
    this.decoder = new StringDecoder("utf8");
    this.isAgentRunning = false;
    this.lastExit = null;
    this.lastError = null;
    this.startedAt = nowIso();

    const sessionId = this.options.conversationId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const args = ["--mode", "rpc", "--approve", "--session-id", sessionId, "--name", this.options.title || sessionId];
    this.child = spawn(this.options.piBin, args, {
      cwd: this.options.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.emitStatus();

    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.handleStderr(chunk));
    this.child.on("error", (error) => {
      this.lastError = error.message;
      this.emit("error_event", { message: error.message });
      this.emitStatus();
    });
    this.child.on("exit", (code, signal) => {
      this.lastExit = { code, signal, at: nowIso() };
      this.isAgentRunning = false;
      for (const pending of this.pending.values()) pending.reject(new Error("Pi RPC process exited"));
      this.pending.clear();
      this.emit("process_exit", this.lastExit);
      this.emitStatus();
    });
  }

  async restart() {
    await this.stopProcess();
    this.statuses.clear();
    this.widgets.clear();
    this.pendingDialogs.clear();
    this.recentEvents = [];
    this.recentToolEvents = [];
    this.recentStderr = [];
    await this.start();
    await this.getState().catch(() => null);
  }

  async stopProcess() {
    if (!this.child) return;
    const child = this.child;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      child.once("exit", finish);
      try {
        child.stdin.end();
      } catch {
        // Process may already be gone.
      }
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
      }, 1500).unref();
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        finish();
      }, 3500).unref();
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += this.decoder.write(chunk);
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      this.handleRecordLine(line);
    }
  }

  handleRecordLine(line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      this.emit("protocol_error", { message: error.message, line });
      return;
    }
    this.options.historyStore?.recordRpcRecord(this.options.conversationId, record);
    this.recordRecent(record);
    this.updateStateFromRecord(record);
    if (record.type === "response" && record.id && this.pending.has(record.id)) {
      const pending = this.pending.get(record.id);
      this.pending.delete(record.id);
      pending.resolve(record);
    }
    this.emit("record", record);
    this.emitStatus();
  }

  handleStderr(chunk) {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      this.pushLimited(this.recentStderr, { at: nowIso(), text: line }, 80);
      this.emit("stderr", line);
    }
  }

  recordRecent(record) {
    const compact = { at: nowIso(), type: record.type };
    if (record.type === "response") compact.command = record.command;
    if (record.type === "extension_ui_request") compact.method = record.method;
    this.pushLimited(this.recentEvents, compact, 120);
    if (record.type?.startsWith("tool_execution_")) {
      this.pushLimited(this.recentToolEvents, {
        at: nowIso(),
        type: record.type,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        isError: record.isError,
        durationMs: record.durationMs,
      }, 80);
    }
  }

  updateStateFromRecord(record) {
    if (record.type === "agent_start") this.isAgentRunning = true;
    if (record.type === "agent_settled") this.isAgentRunning = false;
    if (record.type === "extension_ui_request") {
      if (record.method === "setStatus") {
        if (record.statusText) this.statuses.set(record.statusKey || record.id, record.statusText);
        else this.statuses.delete(record.statusKey || record.id);
      } else if (record.method === "setWidget") {
        if (Array.isArray(record.widgetLines)) {
          this.widgets.set(record.widgetKey || record.id, {
            key: record.widgetKey || record.id,
            placement: record.widgetPlacement || "aboveEditor",
            lines: record.widgetLines,
          });
        } else {
          this.widgets.delete(record.widgetKey || record.id);
        }
      } else if (["select", "confirm", "input", "editor"].includes(record.method)) {
        this.pendingDialogs.set(record.id, record);
      }
    }
  }

  pushLimited(target, value, limit) {
    target.push(value);
    if (target.length > limit) target.splice(0, target.length - limit);
  }

  emitStatus() {
    this.emit("status", this.snapshot());
  }

  async writeRecord(record) {
    if (!this.processRunning || !this.child?.stdin?.writable) throw new Error("Pi RPC 进程未运行");
    const payload = `${JSON.stringify(record)}\n`;
    if (this.child.stdin.write(payload)) return;
    await new Promise((resolve, reject) => {
      this.child.stdin.once("drain", resolve);
      this.child.stdin.once("error", reject);
    });
  }

  sendCommand(command, timeoutMs = 30000) {
    const id = command.id || `web-${Date.now()}-${this.nextId++}`;
    const record = { ...command, id };
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out: ${record.type}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    this.writeRecord(record).catch((error) => {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(error);
    });
    return promise;
  }

  prompt(message) {
    this.options.historyStore?.addUserMessage(this.options.conversationId, message);
    const command = { type: "prompt", message };
    if (this.isAgentRunning) command.streamingBehavior = "followUp";
    return this.sendCommand(command, 10000);
  }

  async abort() {
    await this.sendCommand({ type: "clear_queue" }, 10000).catch(() => null);
    return this.sendCommand({ type: "abort" }, 60000);
  }

  getState() {
    return this.sendCommand({ type: "get_state" }, 15000);
  }

  async respondToExtensionUi(response) {
    if (!response?.id) throw new Error("扩展界面响应缺少 id");
    this.pendingDialogs.delete(response.id);
    await this.writeRecord({ type: "extension_ui_response", ...response });
    this.emitStatus();
  }
}

class RuntimeRegistry extends EventEmitter {
  constructor(store, historyStore) {
    super();
    this.store = store;
    this.historyStore = historyStore;
    this.runtimes = new Map();
    this.clients = new Map();
  }

  conversationSnapshot(conversation) {
    const runtime = this.runtimes.get(conversation.id);
    return {
      ...conversation,
      runtime: runtime?.snapshot() || null,
    };
  }

  listConversations() {
    return this.store.conversations.map((conversation) => this.conversationSnapshot(conversation));
  }

  getDefaultConversationId() {
    return this.store.getConversation(DEFAULT_CONVERSATION_ID)?.id || this.store.conversations[0]?.id;
  }

  getConversationOrThrow(id) {
    const conversation = this.store.getConversation(id || this.getDefaultConversationId());
    if (!conversation) throw new Error("会话不存在");
    const workspace = this.store.getWorkspace(conversation.workspaceId);
    if (!workspace) throw new Error("会话所属工作区不存在");
    return { conversation, workspace };
  }

  ensureRuntime(conversationId) {
    const { conversation, workspace } = this.getConversationOrThrow(conversationId);
    if (this.runtimes.has(conversation.id)) return this.runtimes.get(conversation.id);

    const runtime = new PiRpcBridge({
      conversationId: conversation.id,
      workspaceId: workspace.id,
      title: conversation.title,
      workspace: workspace.path,
      piBin: config.piBin,
      historyStore: this.historyStore,
    });
    this.runtimes.set(conversation.id, runtime);
    this.wireRuntime(conversation.id, runtime);
    return runtime;
  }

  wireRuntime(conversationId, runtime) {
    runtime.on("record", (record) => this.broadcast(conversationId, { type: "rpc_record", conversationId, record }));
    runtime.on("status", async (status) => {
      await this.store.touchConversation(conversationId, { status: status.processRunning ? (status.isAgentRunning ? "running" : "idle") : "stopped" });
      this.broadcast(conversationId, { type: "status", conversationId, status });
      this.emit("conversation_change", this.conversationSnapshot(this.store.getConversation(conversationId)));
    });
    runtime.on("stderr", (line) => this.broadcast(conversationId, { type: "stderr", conversationId, line }));
    runtime.on("protocol_error", (error) => this.broadcast(conversationId, { type: "protocol_error", conversationId, error }));
    runtime.on("error_event", (error) => this.broadcast(conversationId, { type: "error", conversationId, error }));
    runtime.on("process_exit", async (exit) => {
      await this.store.touchConversation(conversationId, { status: "stopped" });
      this.broadcast(conversationId, { type: "process_exit", conversationId, exit });
      this.emit("conversation_change", this.conversationSnapshot(this.store.getConversation(conversationId)));
    });
  }

  runningCounts(workspaceId) {
    let total = 0;
    let workspaceTotal = 0;
    for (const [conversationId, runtime] of this.runtimes.entries()) {
      if (!runtime.processRunning) continue;
      total += 1;
      const conversation = this.store.getConversation(conversationId);
      if (conversation?.workspaceId === workspaceId) workspaceTotal += 1;
    }
    return { total, workspaceTotal };
  }

  async startConversation(conversationId) {
    const { conversation, workspace } = this.getConversationOrThrow(conversationId);
    const runtime = this.ensureRuntime(conversation.id);
    if (!runtime.processRunning) {
      const counts = this.runningCounts(workspace.id);
      if (counts.total >= MAX_RUNNING_RUNTIMES) throw new Error(`运行中会话已达上限：${MAX_RUNNING_RUNTIMES}`);
      if (counts.workspaceTotal >= MAX_RUNNING_PER_WORKSPACE) throw new Error(`该工作区运行中会话已达上限：${MAX_RUNNING_PER_WORKSPACE}`);
    }
    await runtime.start();
    await this.store.touchConversation(conversation.id, { status: runtime.isAgentRunning ? "running" : "idle" });
    return runtime;
  }

  async restartConversation(conversationId) {
    const runtime = this.ensureRuntime(conversationId);
    await runtime.restart();
    return runtime;
  }

  async stopConversation(conversationId) {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return null;
    await runtime.stopProcess();
    await this.store.touchConversation(conversationId, { status: "stopped" });
    return runtime;
  }

  async deleteConversation(conversationId) {
    const { conversation } = this.getConversationOrThrow(conversationId);
    if (this.store.conversations.length <= 1) throw new Error("至少保留一个会话");

    const runtime = this.runtimes.get(conversation.id);
    if (runtime) {
      await runtime.stopProcess();
      runtime.removeAllListeners();
      this.runtimes.delete(conversation.id);
    }

    const clients = this.clients.get(conversation.id);
    if (clients) {
      const payload = JSON.stringify({ type: "conversation_deleted", conversationId: conversation.id });
      for (const socket of clients) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
        socket.close(1000, "conversation deleted");
      }
      this.clients.delete(conversation.id);
    }

    const deleted = await this.store.deleteConversation(conversation.id);
    await this.historyStore.delete(conversation.id);
    return {
      deleted,
      activeConversationId: this.getDefaultConversationId(),
      conversations: this.listConversations(),
    };
  }

  addClient(conversationId, ws) {
    if (!this.clients.has(conversationId)) this.clients.set(conversationId, new Set());
    this.clients.get(conversationId).add(ws);
    ws.on("close", () => this.clients.get(conversationId)?.delete(ws));
  }

  broadcast(conversationId, message) {
    const payload = JSON.stringify(message);
    for (const socket of this.clients.get(conversationId) || []) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  conversationMessages(conversationId) {
    this.getConversationOrThrow(conversationId);
    return this.historyStore.snapshot(conversationId);
  }

  async shutdownAll() {
    await Promise.allSettled(Array.from(this.runtimes.values()).map((runtime) => runtime.stopProcess()));
  }
}

const store = new RegistryStore();
await store.load();
const historyStore = new ChatHistoryStore();
await historyStore.loadAll(store.conversations);
const registry = new RuntimeRegistry(store, historyStore);

function publicConfig(conversationId = registry.getDefaultConversationId()) {
  const conversation = store.getConversation(conversationId);
  const workspace = conversation && store.getWorkspace(conversation.workspaceId);
  return {
    workspace: workspace?.path || DEFAULT_WORKSPACE_PATH,
    activeConversationId: conversation?.id || null,
    activeWorkspaceId: workspace?.id || null,
    workspaces: store.workspaces,
    conversations: registry.listConversations(),
    port: config.port,
    host: config.host,
    authRequired: !config.authDisabled,
    tokenSource: config.tokenSource,
    limits: {
      maxRunningRuntimes: MAX_RUNNING_RUNTIMES,
      maxRunningPerWorkspace: MAX_RUNNING_PER_WORKSPACE,
    },
  };
}

async function readBodyJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

async function handleApi(req, res, url) {
  if (!isAuthorized(req, url)) return sendJson(res, 401, { error: "未授权" });

  if (req.method === "GET" && url.pathname === "/api/config") {
    const conversationId = url.searchParams.get("conversationId") || registry.getDefaultConversationId();
    const runtime = registry.ensureRuntime(conversationId);
    return sendJson(res, 200, { ...publicConfig(conversationId), status: runtime.snapshot() });
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const conversationId = url.searchParams.get("conversationId") || registry.getDefaultConversationId();
    const runtime = registry.ensureRuntime(conversationId);
    return sendJson(res, 200, runtime.snapshot());
  }

  if (req.method === "GET" && url.pathname === "/api/workspaces") {
    return sendJson(res, 200, { workspaces: store.workspaces });
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces") {
    try {
      const workspace = await store.createWorkspace(await readBodyJson(req));
      return sendJson(res, 201, { workspace });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/conversations") {
    const workspaceId = url.searchParams.get("workspaceId");
    const conversations = registry.listConversations().filter((conversation) => !workspaceId || conversation.workspaceId === workspaceId);
    return sendJson(res, 200, { conversations });
  }

  const conversationMessages = /^\/api\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
  if (req.method === "GET" && conversationMessages) {
    try {
      const conversationId = decodeURIComponent(conversationMessages[1]);
      return sendJson(res, 200, { conversationId, messages: registry.conversationMessages(conversationId) });
    } catch (error) {
      return sendJson(res, 404, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/conversations") {
    try {
      const conversation = await store.createConversation(await readBodyJson(req));
      return sendJson(res, 201, { conversation: registry.conversationSnapshot(conversation) });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  const conversationDelete = /^\/api\/conversations\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && conversationDelete) {
    try {
      const conversationId = decodeURIComponent(conversationDelete[1]);
      const result = await registry.deleteConversation(conversationId);
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, error.message === "会话不存在" ? 404 : 400, { error: error.message });
    }
  }

  const conversationAction = /^\/api\/conversations\/([^/]+)\/(start|stop|restart)$/.exec(url.pathname);
  if (req.method === "POST" && conversationAction) {
    try {
      const [, conversationId, action] = conversationAction;
      if (action === "start") await registry.startConversation(conversationId);
      if (action === "stop") await registry.stopConversation(conversationId);
      if (action === "restart") await registry.restartConversation(conversationId);
      return sendJson(res, 200, { conversation: registry.conversationSnapshot(store.getConversation(conversationId)) });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const url = parseUrl(req);
  if (url.pathname.startsWith("/api/")) {
    const handled = await handleApi(req, res, url);
    if (handled !== false) return;
  }

  const rootDir = await staticRoot();
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(rootDir, pathname));
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end("禁止访问");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    const wantsHtml = req.headers.accept?.includes("text/html") || !path.extname(pathname);
    if (wantsHtml) {
      try {
        const index = await fs.readFile(path.join(rootDir, "index.html"));
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(index);
        return;
      } catch {
        // Fall through.
      }
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("未找到");
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = parseUrl(req);
  if (url.pathname !== "/ws" || !isAuthorized(req, url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", async (ws, req) => {
  const url = parseUrl(req);
  const conversationId = url.searchParams.get("conversationId") || registry.getDefaultConversationId();
  let runtime;
  try {
    runtime = registry.ensureRuntime(conversationId);
    registry.addClient(conversationId, ws);
    ws.send(JSON.stringify({ type: "hello", conversationId, config: publicConfig(conversationId), status: runtime.snapshot(), history: registry.conversationMessages(conversationId) }));
  } catch (error) {
    ws.send(JSON.stringify({ type: "error", conversationId, error: { message: error.message } }));
    ws.close();
    return;
  }

  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      return ws.send(JSON.stringify({ type: "error", conversationId, error: { message: `JSON 格式错误：${error.message}` } }));
    }

    try {
      if (message.type === "prompt") {
        const text = String(message.message || "").trim();
        if (!text) throw new Error("消息内容不能为空");
        await registry.startConversation(conversationId);
        const response = await runtime.prompt(text);
        ws.send(JSON.stringify({ type: "command_response", conversationId, response }));
      } else if (message.type === "abort") {
        const response = await runtime.abort();
        ws.send(JSON.stringify({ type: "command_response", conversationId, response }));
      } else if (message.type === "restart") {
        await registry.restartConversation(conversationId);
        ws.send(JSON.stringify({ type: "command_response", conversationId, response: { command: "restart", success: true } }));
      } else if (message.type === "get_state") {
        await registry.startConversation(conversationId);
        const response = await runtime.getState();
        ws.send(JSON.stringify({ type: "command_response", conversationId, response }));
      } else if (message.type === "extension_ui_response") {
        await runtime.respondToExtensionUi(message.response);
        ws.send(JSON.stringify({ type: "command_response", conversationId, response: { command: "extension_ui_response", success: true } }));
      } else {
        throw new Error(`不支持的浏览器消息类型：${message.type}`);
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", conversationId, error: { message: error.message } }));
    }
  });
});

server.listen(config.port, config.host, async () => {
  const localUrl = config.authDisabled ? `http://localhost:${config.port}/` : `http://localhost:${config.port}/?token=${encodeURIComponent(config.token)}`;
  console.log(`Pi 远程对话已监听：http://${config.host}:${config.port}`);
  console.log(`默认工作区：${DEFAULT_WORKSPACE_PATH}`);
  console.log(`本机打开：${localUrl}`);
  if (!config.authDisabled) {
    console.log(`Token 来源：${config.tokenSource}`);
    console.log(`Token 文件：${config.tokenFile}`);
  } else {
    console.log("Token 校验已关闭：当前为局域网调试模式。只应在可信网络中使用。");
  }

  try {
    const runtime = await registry.startConversation(DEFAULT_CONVERSATION_ID);
    await runtime.getState().catch(() => null);
  } catch (error) {
    console.error(`默认 Pi RPC 进程启动失败：${error.message}`);
  }
});

process.on("SIGINT", async () => {
  console.log("正在关闭...");
  await registry.shutdownAll();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await registry.shutdownAll();
  process.exit(0);
});
