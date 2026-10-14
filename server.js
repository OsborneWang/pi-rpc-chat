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
  workspace: process.env.PI_WORKSPACE || "/WorkSpace/pmCloud_New",
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
    this.startedAt = new Date().toISOString();

    const args = ["--mode", "rpc", "--approve", "--name", "pi-rpc-chat"];
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
      this.lastExit = { code, signal, at: new Date().toISOString() };
      this.isAgentRunning = false;
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Pi RPC process exited"));
      }
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
      this.pushLimited(this.recentStderr, { at: new Date().toISOString(), text: line }, 80);
      this.emit("stderr", line);
    }
  }

  recordRecent(record) {
    const compact = { at: new Date().toISOString(), type: record.type };
    if (record.type === "response") compact.command = record.command;
    if (record.type === "extension_ui_request") compact.method = record.method;
    this.pushLimited(this.recentEvents, compact, 120);

    if (record.type?.startsWith("tool_execution_")) {
      this.pushLimited(this.recentToolEvents, {
        at: new Date().toISOString(),
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
    if (!this.processRunning || !this.child?.stdin?.writable) {
      throw new Error("Pi RPC 进程未运行");
    }
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

const bridge = new PiRpcBridge(config);
const clients = new Set();

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const socket of clients) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

bridge.on("record", (record) => broadcast({ type: "rpc_record", record }));
bridge.on("status", (status) => broadcast({ type: "status", status }));
bridge.on("stderr", (line) => broadcast({ type: "stderr", line }));
bridge.on("protocol_error", (error) => broadcast({ type: "protocol_error", error }));
bridge.on("error_event", (error) => broadcast({ type: "error", error }));
bridge.on("process_exit", (exit) => broadcast({ type: "process_exit", exit }));

const server = http.createServer(async (req, res) => {
  const url = parseUrl(req);

  if (url.pathname === "/api/config") {
    if (!isAuthorized(req, url)) return sendJson(res, 401, { error: "未授权" });
    return sendJson(res, 200, {
      workspace: config.workspace,
      port: config.port,
      host: config.host,
      authRequired: !config.authDisabled,
      tokenSource: config.tokenSource,
      status: bridge.snapshot(),
    });
  }

  if (url.pathname === "/api/status") {
    if (!isAuthorized(req, url)) return sendJson(res, 401, { error: "未授权" });
    return sendJson(res, 200, bridge.snapshot());
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
        // Fall through to the plain 404 below.
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

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "hello", config: publicConfig(), status: bridge.snapshot() }));

  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      return ws.send(JSON.stringify({ type: "error", error: { message: `JSON 格式错误：${error.message}` } }));
    }

    try {
      if (message.type === "prompt") {
        const text = String(message.message || "").trim();
        if (!text) throw new Error("消息内容不能为空");
        await bridge.start();
        const response = await bridge.prompt(text);
        ws.send(JSON.stringify({ type: "command_response", response }));
      } else if (message.type === "abort") {
        const response = await bridge.abort();
        ws.send(JSON.stringify({ type: "command_response", response }));
      } else if (message.type === "restart") {
        await bridge.restart();
        ws.send(JSON.stringify({ type: "command_response", response: { command: "restart", success: true } }));
      } else if (message.type === "get_state") {
        await bridge.start();
        const response = await bridge.getState();
        ws.send(JSON.stringify({ type: "command_response", response }));
      } else if (message.type === "extension_ui_response") {
        await bridge.respondToExtensionUi(message.response);
        ws.send(JSON.stringify({ type: "command_response", response: { command: "extension_ui_response", success: true } }));
      } else {
        throw new Error(`不支持的浏览器消息类型：${message.type}`);
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", error: { message: error.message } }));
    }
  });

  ws.on("close", () => clients.delete(ws));
});

function publicConfig() {
  return {
    workspace: config.workspace,
    port: config.port,
    host: config.host,
    authRequired: !config.authDisabled,
    tokenSource: config.tokenSource,
  };
}

server.listen(config.port, config.host, async () => {
  const localUrl = config.authDisabled
    ? `http://localhost:${config.port}/`
    : `http://localhost:${config.port}/?token=${encodeURIComponent(config.token)}`;
  console.log(`Pi 远程对话已监听：http://${config.host}:${config.port}`);
  console.log(`工作区：${config.workspace}`);
  console.log(`本机打开：${localUrl}`);
  if (!config.authDisabled) {
    console.log(`Token 来源：${config.tokenSource}`);
    console.log(`Token 文件：${config.tokenFile}`);
    console.log("在 Mac 上访问时，把上面 URL 里的 localhost 换成这台 Ubuntu 的局域网 IP。");
  } else {
    console.log("Token 校验已关闭：当前为局域网调试模式。只应在可信网络中使用。");
  }

  try {
    await bridge.start();
    await bridge.getState().catch(() => null);
  } catch (error) {
    console.error(`Pi RPC 进程启动失败：${error.message}`);
  }
});

process.on("SIGINT", async () => {
  console.log("正在关闭...");
  await bridge.stopProcess();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bridge.stopProcess();
  process.exit(0);
});
