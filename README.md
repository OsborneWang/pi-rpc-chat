# Pi 远程对话

这是一个独立的局域网 Web 应用，用浏览器聊天框驱动本机 Pi 的 RPC 模式。默认会在 Ubuntu 上启动 `pi --mode rpc --approve`，并把 Pi 的工作目录设为 `/WorkSpace/pmCloud_New`。

## 启动

```bash
cd /WorkSpace/pi-rpc-chat
npm install
npm run dev
```

默认监听：

```text
0.0.0.0:3030
```

当前调试阶段默认不启用 token。启动后可以直接访问：

```text
http://localhost:3030/
```

在 Mac 上访问时，把 `localhost` 换成 Ubuntu 的局域网 IP。

## 认证策略

当前版本为了局域网内个人调试，默认关闭 token 校验。也就是说，只要能访问端口 `3030`，就能打开页面并驱动 Pi。

未来接入账号体系前，如果你想临时恢复 token，可以这样启动：

```bash
PI_RPC_CHAT_REQUIRE_TOKEN=1 npm run dev
```

这种模式下，如果没有设置固定 token，服务启动时会用 Node.js 安全随机数生成一个 token：

```js
crypto.randomBytes(18).toString("base64url")
```

也可以指定固定 token：

```bash
PI_RPC_CHAT_TOKEN='your-fixed-token' npm run dev
```

启用 token 时，服务会把 token 写到：

```bash
/WorkSpace/pi-rpc-chat/.runtime/token
```

## 配置项

- `PORT`：HTTP 端口，默认 `3030`。
- `HOST`：监听地址，默认 `0.0.0.0`。
- `PI_WORKSPACE`：Pi 工作目录，默认 `/WorkSpace/pmCloud_New`。
- `PI_BIN`：Pi 可执行文件，默认 `pi`。
- `PI_RPC_CHAT_REQUIRE_TOKEN=1`：启用随机 token 校验。
- `PI_RPC_CHAT_TOKEN`：启用并固定访问 token。
- `PI_RPC_CHAT_NO_AUTH=1`：强制关闭 token 校验。

## 安全说明

能打开这个页面的人，就能驱动 Pi 以当前 Ubuntu 用户权限读写文件、执行命令、消耗模型额度。当前默认无认证，只适合可信局域网个人调试。不用时建议关闭服务。
