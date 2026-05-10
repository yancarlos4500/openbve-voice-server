const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
const HTTPS_ENABLED = String(process.env.HTTPS || "").toLowerCase() === "true";
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || "";
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || "";
const DEFAULT_ROOM_ID = "mta-main";
const DEFAULT_CHANNEL = "operations";
const ALLOWED_ROLES = new Set(["operator", "tower"]);

const CHANNELS = [DEFAULT_CHANNEL];

const app = express();
app.use(express.json());
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
const wss = new WebSocket.Server({ server });

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
