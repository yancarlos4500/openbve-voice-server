require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const { randomUUID, timingSafeEqual, createHmac, randomBytes } = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
const HTTPS_ENABLED = String(process.env.HTTPS || "").toLowerCase() === "true";
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || "";
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || "";
const ACCESS_TOKEN = String(process.env.ACCESS_TOKEN || "").trim();
const AUTH_PASSWORD = String(process.env.AUTH_PASSWORD || "").trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || "").trim() || randomBytes(32).toString("hex");
const SESSION_TTL_SECONDS = Math.max(60, Number(process.env.SESSION_TTL_SECONDS) || 43200);
const TRUST_PROXY = String(process.env.TRUST_PROXY || "").toLowerCase() === "true";
const REQUIRE_HTTPS = String(process.env.REQUIRE_HTTPS || "").toLowerCase() === "true";
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const ALLOWED_IPS = String(process.env.ALLOWED_IPS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000);
const RATE_LIMIT_AUTH_MAX = Math.max(1, Number(process.env.RATE_LIMIT_AUTH_MAX) || 10);
const RATE_LIMIT_WS_MAX = Math.max(1, Number(process.env.RATE_LIMIT_WS_MAX) || 60);
const AUTH_COOKIE_NAME = "openbve_auth";
const HEALTHCHECK_PATH = "/healthz";
const DEFAULT_ROOM_ID = "mta-main";
const DEFAULT_CHANNEL = "operations";
const ALLOWED_ROLES = new Set(["operator", "tower"]);

const CHANNELS = [DEFAULT_CHANNEL];
const AUTH_ENABLED = Boolean(AUTH_PASSWORD || ACCESS_TOKEN);

const authRateLimit = new Map();
const wsRateLimit = new Map();

const app = express();
app.set("trust proxy", TRUST_PROXY);
app.use(express.json());

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) {
    return result;
  }

  const pairs = String(cookieHeader).split(";");
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx === -1) {
      continue;
    }

    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) {
      continue;
    }

    try {
      result[key] = decodeURIComponent(value);
    } catch (_err) {
      result[key] = value;
    }
  }

  return result;
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : `${normalized}${"=".repeat(4 - pad)}`;
  return Buffer.from(padded, "base64").toString("utf8");
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

function signSessionToken(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", SESSION_SECRET).update(signingInput).digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${signingInput}.${signature}`;
}

function verifySessionToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac("sha256", SESSION_SECRET).update(signingInput).digest();
  const got = Buffer.from(String(signature || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return null;
  }

  const payload = safeJsonParse(base64UrlDecode(encodedPayload));
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return null;
  }

  if (payload.scope !== "webrtc") {
    return null;
  }

  return payload;
}

function getTokenFromRequestUrl(urlText, host) {
  try {
    const urlObj = new URL(urlText || "/", `http://${host || "localhost"}`);
    return String(urlObj.searchParams.get("token") || "").trim();
  } catch (_err) {
    return "";
  }
}

function getTokenFromHeaders(headers) {
  const tokenHeader = String(headers["x-access-token"] || "").trim();
  if (tokenHeader) {
    return tokenHeader;
  }

  const authHeader = String(headers.authorization || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  const cookies = parseCookies(headers.cookie);
  return String(cookies[AUTH_COOKIE_NAME] || "").trim();
}

function isValidAccessToken(candidate) {
  if (!ACCESS_TOKEN) {
    return false;
  }

  const left = Buffer.from(String(candidate || ""));
  const right = Buffer.from(ACCESS_TOKEN);
  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function isValidAuthToken(candidate) {
  if (!candidate) {
    return false;
  }

  return Boolean(verifySessionToken(candidate)) || isValidAccessToken(candidate);
}

function isSecureFromHeaders(headers) {
  const proto = String(headers["x-forwarded-proto"] || "").toLowerCase();
  if (!proto) {
    return false;
  }
  return proto.split(",").map((v) => v.trim()).includes("https");
}

function isLocalRequestHost(host) {
  const hostOnly = String(host || "").split(":")[0].toLowerCase();
  return hostOnly === "localhost" || hostOnly === "127.0.0.1" || hostOnly === "::1";
}

function getClientIpFromRequest(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xf) {
      return xf;
    }
  }

  return String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "");
}

function isAllowedIp(ip) {
  if (ALLOWED_IPS.length === 0) {
    return true;
  }

  const normalized = String(ip || "").replace(/^::ffff:/, "");
  return ALLOWED_IPS.includes(normalized);
}

function hitRateLimit(bucket, key, maxCount) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const current = bucket.get(key) || [];
  const next = current.filter((time) => time > cutoff);
  if (next.length >= maxCount) {
    bucket.set(key, next);
    return true;
  }

  next.push(now);
  bucket.set(key, next);
  return false;
}

function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.length === 0) {
    return true;
  }

  if (!origin) {
    return false;
  }

  return ALLOWED_ORIGINS.includes(String(origin));
}

function setAuthCookie(res, token) {
  const attrs = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];

  if (HTTPS_ENABLED || REQUIRE_HTTPS) {
    attrs.push("Secure");
  }

  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearAuthCookie(res) {
  const attrs = [
    `${AUTH_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0"
  ];
  if (HTTPS_ENABLED || REQUIRE_HTTPS) {
    attrs.push("Secure");
  }
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function issueSession(res, ip) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "openbve-radio",
    scope: "webrtc",
    ip,
    iat: now,
    exp: now + SESSION_TTL_SECONDS
  };

  const token = signSessionToken(payload);
  setAuthCookie(res, token);
  return token;
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

app.use((req, res, next) => {
  if (req.path === HEALTHCHECK_PATH) {
    next();
    return;
  }

  if (!REQUIRE_HTTPS) {
    next();
    return;
  }

  const secure = Boolean(req.secure) || isSecureFromHeaders(req.headers);
  if (secure || isLocalRequestHost(req.headers.host)) {
    next();
    return;
  }

  res.status(426).json({ error: "HTTPS_REQUIRED", message: "HTTPS is required." });
});

app.use((req, res, next) => {
  if (req.path === HEALTHCHECK_PATH) {
    next();
    return;
  }

  const ip = getClientIpFromRequest(req);
  if (!isAllowedIp(ip)) {
    res.status(403).json({ error: "IP_BLOCKED", message: "IP not allowed." });
    return;
  }
  req.clientIp = ip;
  next();
});

app.get("/login", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Openbve Radio Login</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101418; color: #d0d0d0; }
      .card { width: min(420px, 92vw); background: #1a1f24; border: 1px solid #2b343f; border-radius: 10px; padding: 18px; }
      h1 { margin: 0 0 8px; font-size: 1.2rem; }
      p { margin: 0 0 12px; color: #9cabbb; font-size: 0.9rem; }
      input, button { width: 100%; box-sizing: border-box; border-radius: 6px; border: 1px solid #2b343f; padding: 10px; font-size: 0.95rem; }
      input { background: #0f1419; color: #d0d0d0; margin-bottom: 10px; }
      button { background: #d4a018; color: #201300; font-weight: bold; cursor: pointer; }
      #msg { min-height: 18px; margin-top: 10px; color: #e09191; font-size: 0.86rem; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Openbve Radio</h1>
      <p>Enter access password to continue.</p>
      <form id="loginForm">
        <input id="pw" type="password" autocomplete="current-password" placeholder="Access password" required />
        <button type="submit">Sign In</button>
      </form>
      <div id="msg"></div>
    </main>
    <script>
      const form = document.getElementById("loginForm");
      const pw = document.getElementById("pw");
      const msg = document.getElementById("msg");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        msg.textContent = "";
        try {
          const response = await fetch("/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: pw.value || "" })
          });
          if (!response.ok) {
            msg.textContent = "Invalid password.";
            return;
          }
          location.href = "/";
        } catch (_err) {
          msg.textContent = "Login failed.";
        }
      });
    </script>
  </body>
</html>`);
});

app.get("/auth/status", (req, res) => {
  if (!AUTH_ENABLED) {
    res.json({ enabled: false, authenticated: true });
    return;
  }

  const queryToken = getTokenFromRequestUrl(req.url, req.headers.host);
  const headerToken = getTokenFromHeaders(req.headers);
  const authenticated = isValidAuthToken(queryToken) || isValidAuthToken(headerToken);
  if (authenticated && queryToken) {
    issueSession(res, req.clientIp);
  }
  res.json({ enabled: true, authenticated });
});

app.post("/auth/login", (req, res) => {
  if (!AUTH_ENABLED) {
    res.json({ ok: true, authEnabled: false });
    return;
  }

  const key = req.clientIp || "unknown";
  if (hitRateLimit(authRateLimit, key, RATE_LIMIT_AUTH_MAX)) {
    res.status(429).json({ error: "RATE_LIMITED", message: "Too many login attempts." });
    return;
  }

  const incoming = String((req.body && req.body.password) || "").trim();
  const expected = AUTH_PASSWORD || ACCESS_TOKEN;
  const valid = expected
    ? Buffer.byteLength(incoming) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(incoming), Buffer.from(expected))
    : false;

  if (!valid) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid password." });
    return;
  }

  issueSession(res, req.clientIp);
  res.json({ ok: true, expiresIn: SESSION_TTL_SECONDS });
});

app.post("/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get(HEALTHCHECK_PATH, (_req, res) => {
  res.status(200).json({ ok: true, status: "healthy" });
});

function httpAuthMiddleware(req, res, next) {
  if (
    !AUTH_ENABLED ||
    req.path.startsWith("/auth/") ||
    req.path === "/login" ||
    req.path === HEALTHCHECK_PATH
  ) {
    next();
    return;
  }

  const queryToken = getTokenFromRequestUrl(req.url, req.headers.host);
  const headerToken = getTokenFromHeaders(req.headers);
  const queryValid = isValidAuthToken(queryToken);
  const headerValid = isValidAuthToken(headerToken);

  if (!queryValid && !headerValid) {
    const accept = String(req.headers.accept || "").toLowerCase();
    if (req.method === "GET" && accept.includes("text/html")) {
      res.redirect("/login");
      return;
    }

    res.status(401).json({
      error: "Unauthorized",
      message: "Authentication required."
    });
    return;
  }

  if (queryValid) {
    issueSession(res, req.clientIp);
  }

  next();
}

app.use(httpAuthMiddleware);
app.use(express.static(path.join(__dirname, "public")));

function createWebServer() {
  if (!HTTPS_ENABLED) {
    return http.createServer(app);
  }

  if (!SSL_KEY_PATH || !SSL_CERT_PATH) {
    throw new Error("HTTPS=true requires SSL_KEY_PATH and SSL_CERT_PATH.");
  }

  const keyPath = path.resolve(SSL_KEY_PATH);
  const certPath = path.resolve(SSL_CERT_PATH);

  const key = fs.readFileSync(keyPath, "utf8");
  const cert = fs.readFileSync(certPath, "utf8");

  return https.createServer({ key, cert }, app);
}

const server = createWebServer();
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const ip = getClientIpFromRequest(req);
  if (!isAllowedIp(ip)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  if (hitRateLimit(wsRateLimit, ip || "unknown", RATE_LIMIT_WS_MAX)) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }

  if (REQUIRE_HTTPS) {
    const secure = isSecureFromHeaders(req.headers);
    if (!secure && !isLocalRequestHost(req.headers.host)) {
      socket.write("HTTP/1.1 426 Upgrade Required\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  if (!isAllowedOrigin(req.headers.origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  if (AUTH_ENABLED) {
    const queryToken = getTokenFromRequestUrl(req.url, req.headers.host);
    const headerToken = getTokenFromHeaders(req.headers);
    if (!isValidAuthToken(queryToken) && !isValidAuthToken(headerToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

const rooms = new Map();
const clientsById = new Map();

function send(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(payload));
}

function generateOperatorName(clientId) {
  const prefixes = ["Train", "Tower", "Ops", "Unit", "Control"];
  const suffix = clientId.slice(0, 4).toUpperCase();
  const bucket = Number.parseInt(clientId.slice(0, 2), 16) % prefixes.length;
  return `${prefixes[bucket]}-${suffix}`;
}

function normalizeRole(value) {
  const next = String(value || "operator").toLowerCase();
  return ALLOWED_ROLES.has(next) ? next : "operator";
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      clients: new Set(),
      channels: new Map(
        CHANNELS.map((name) => [
          name,
          {
            holderId: null,
            queue: []
          }
        ])
      )
    });
  }

  return rooms.get(roomId);
}

function getClientSummary(client) {
  return {
    id: client.id,
    name: client.name,
    role: client.role,
    line: client.line,
    trainId: client.trainId,
    channel: client.channel
  };
}

function broadcastRoom(room, payload, excludedClientId = null) {
  for (const clientId of room.clients) {
    if (excludedClientId && excludedClientId === clientId) {
      continue;
    }

    const client = clientsById.get(clientId);
    if (client) {
      send(client.ws, payload);
    }
  }
}

function removeClientFromQueues(room, clientId) {
  for (const channelState of room.channels.values()) {
    channelState.queue = channelState.queue.filter((id) => id !== clientId);
  }
}

function getChannelState(room, channelName) {
  return room.channels.get(channelName);
}

function pushChannelSnapshot(room, channelName) {
  const channelState = getChannelState(room, channelName);
  if (!channelState) {
    return;
  }

  broadcastRoom(room, {
    type: "channel-state",
    payload: {
      channel: channelName,
      holderId: channelState.holderId,
      queue: channelState.queue
    }
  });
}

function pushTxState(room, speakerId, channelName, active) {
  for (const listenerId of room.clients) {
    const listener = clientsById.get(listenerId);
    if (!listener) {
      continue;
    }

    const isOnChannel = listener.channel === channelName;

    send(listener.ws, {
      type: "tx-state",
      payload: {
        active: active && isOnChannel,
        speakerId,
        channel: channelName
      }
    });
  }
}

function releasePTT(room, client, reason = "released") {
  const channelState = getChannelState(room, client.channel);
  if (!channelState) {
    return;
  }

  channelState.queue = channelState.queue.filter((id) => id !== client.id);

  if (channelState.holderId === client.id) {
    channelState.holderId = null;

    send(client.ws, {
      type: "ptt-released",
      payload: { reason }
    });

    pushTxState(room, client.id, client.channel, false);

    while (channelState.queue.length > 0) {
      const nextId = channelState.queue.shift();
      const nextClient = clientsById.get(nextId);
      if (!nextClient || nextClient.roomId !== room.id || nextClient.channel !== client.channel) {
        continue;
      }

      channelState.holderId = nextClient.id;
      send(nextClient.ws, {
        type: "ptt-granted",
        payload: {
          channel: client.channel,
          reason: "queue-advanced"
        }
      });

      pushTxState(room, nextClient.id, client.channel, true);
      break;
    }
  }

  pushChannelSnapshot(room, client.channel);
}

function requestPTT(room, client, channelName) {
  if (!CHANNELS.includes(channelName)) {
    send(client.ws, {
      type: "error",
      payload: { message: "Unknown channel." }
    });
    return;
  }

  client.channel = channelName;
  const channelState = getChannelState(room, channelName);
  if (!channelState) {
    return;
  }

  if (!channelState.holderId || channelState.holderId === client.id) {
    channelState.holderId = client.id;

    send(client.ws, {
      type: "ptt-granted",
      payload: {
        channel: channelName,
        reason: "free-channel"
      }
    });

    pushTxState(room, client.id, channelName, true);
    pushChannelSnapshot(room, channelName);
    return;
  }

  if (!channelState.queue.includes(client.id)) {
    channelState.queue.push(client.id);
  }

  send(client.ws, {
    type: "ptt-queued",
    payload: {
      channel: channelName,
      position: channelState.queue.length
    }
  });

  pushChannelSnapshot(room, channelName);
}

app.get("/api/rooms", (_req, res) => {
  const room = getRoom(DEFAULT_ROOM_ID);
  const channels = [...room.channels.entries()].map(([name, state]) => ({
    name,
    holderId: state.holderId,
    queueLength: state.queue.length
  }));

  res.json({
    room: {
      roomId: DEFAULT_ROOM_ID,
      participants: room.clients.size,
      channels
    }
  });
});

wss.on("connection", (ws) => {
  const client = {
    id: randomUUID(),
    ws,
    roomId: null,
    name: "",
    role: "operator",
    line: "A",
    trainId: "",
    channel: DEFAULT_CHANNEL
  };

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (_err) {
      send(ws, {
        type: "error",
        payload: { message: "Invalid JSON payload." }
      });
      return;
    }

    const { type, payload = {} } = msg;

    if (type === "join") {
      const roomId = DEFAULT_ROOM_ID;
      const room = getRoom(roomId);

      client.roomId = roomId;
      client.name = generateOperatorName(client.id);
      client.role = normalizeRole(payload.role);
      client.line = String(payload.line || "A");
      client.trainId = String(payload.trainId || "");
      client.channel = DEFAULT_CHANNEL;

      room.clients.add(client.id);
      clientsById.set(client.id, client);

      const peers = [...room.clients]
        .filter((id) => id !== client.id)
        .map((id) => getClientSummary(clientsById.get(id)))
        .filter(Boolean);

      send(ws, {
        type: "joined",
        payload: {
          self: getClientSummary(client),
          peers,
          channels: CHANNELS
        }
      });

      broadcastRoom(
        room,
        {
          type: "peer-joined",
          payload: getClientSummary(client)
        },
        client.id
      );

      for (const channelName of CHANNELS) {
        pushChannelSnapshot(room, channelName);
      }

      return;
    }

    if (!client.roomId) {
      send(ws, {
        type: "error",
        payload: { message: "Join a room first." }
      });
      return;
    }

    const room = rooms.get(client.roomId);
    if (!room) {
      return;
    }

    if (type === "signal") {
      const targetId = String(payload.to || "");
      const target = clientsById.get(targetId);
      if (target) {
        send(target.ws, {
          type: "signal",
          payload: {
            from: client.id,
            data: payload.data
          }
        });
      }
      return;
    }

    if (type === "set-channel") {
      send(ws, {
        type: "channel-updated",
        payload: { channel: DEFAULT_CHANNEL }
      });
      return;
    }

    if (type === "set-presence") {
      client.line = String(payload.line || client.line || "A");
      client.trainId = String(payload.trainId || client.trainId || "");

      broadcastRoom(
        room,
        {
          type: "peer-updated",
          payload: getClientSummary(client)
        },
        client.id
      );
      return;
    }

    if (type === "ptt-request") {
      const requestedChannel = DEFAULT_CHANNEL;
      requestPTT(room, client, requestedChannel);
      return;
    }

    if (type === "ptt-release") {
      releasePTT(room, client);
      return;
    }
  });

  ws.on("close", () => {
    if (!client.roomId) {
      return;
    }

    const room = rooms.get(client.roomId);
    if (!room) {
      return;
    }

    releasePTT(room, client, "disconnect");
    removeClientFromQueues(room, client.id);

    room.clients.delete(client.id);
    clientsById.delete(client.id);

    broadcastRoom(room, {
      type: "peer-left",
      payload: { id: client.id }
    });

    for (const channelName of CHANNELS) {
      pushChannelSnapshot(room, channelName);
    }

    if (room.clients.size === 0) {
      for (const channelState of room.channels.values()) {
        channelState.holderId = null;
        channelState.queue = [];
      }
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  const protocol = HTTPS_ENABLED ? "https" : "http";
  console.log(`MTA radio server listening on ${protocol}://localhost:${PORT}`);
});
