# MTA Subway Radio WebRTC Server

A Node.js WebRTC signaling server and demo client that simulates subway radio behavior for MTA-style operations.

## Features

- WebRTC peer mesh voice with WebSocket signaling.
- One fixed room (`mta-main`) and one fixed radio channel (`operations`).
- Push-to-talk arbitration with queueing (single active transmitter).
- Two roles: `operator` and `tower`.
- Server-generated user names.
- Mobile-friendly PTT behavior and walkie-talkie style audio processing.
- Optional local HTTPS mode for secure mobile microphone access.

## Requirements

- Node.js 18+ recommended.

## Install

```bash
npm install
```

## Run (HTTP)

```bash
npm start
```

Open browser tabs (or multiple devices) at:

- http://localhost:8080

## Run (HTTPS local)

Set these environment variables before starting:

- `HTTPS=true`
- `SSL_KEY_PATH=<path to key.pem>`
- `SSL_CERT_PATH=<path to cert.pem>`

Example (Git Bash):

```bash
HTTPS=true SSL_KEY_PATH=./certs/localhost-key.pem SSL_CERT_PATH=./certs/localhost.pem npm start
```

Example (PowerShell):

```powershell
$env:HTTPS="true"
$env:SSL_KEY_PATH="./certs/localhost-key.pem"
$env:SSL_CERT_PATH="./certs/localhost.pem"
npm start
```

Then open:

- https://localhost:8080

If you test from a phone, use your PC LAN host and a trusted cert:

- https://<your-lan-ip>:8080

## mkcert quick setup

1. Install `mkcert`.
2. Run `mkcert -install`.
3. Generate cert files (example):

```bash
mkdir -p certs
mkcert -key-file certs/localhost-key.pem -cert-file certs/localhost.pem localhost 127.0.0.1 ::1
```

4. Start server with the HTTPS env vars above.

Note:

- Phone microphone access usually requires HTTPS with a trusted certificate chain on the phone.

## How to test quickly

1. Open two browser tabs.
2. Join same network session.
3. Use one tab as transmitter and one as receiver.
4. Hold Push To Talk in one tab.
5. Try holding Push To Talk in the other tab to see queue behavior.

## API

- `GET /api/rooms` returns room/channel occupancy snapshot.

## Message overview

WebSocket message types used by the client:

- `join`
- `joined`
- `peer-joined`
- `peer-left`
- `peer-updated`
- `signal` (offer/answer/ice)
- `set-channel`
- `set-presence`
- `ptt-request`
- `ptt-release`
- `ptt-granted`
- `ptt-queued`
- `ptt-released`
- `ptt-revoked`
- `tx-state`
- `channel-state`

## Notes for production

- Add TURN (coturn) for NAT traversal.
- Add authentication and authorization for roles/channels.
- Add persistence and operational logging.
- Consider SFU architecture (mediasoup/Janus) for larger rooms.
# openbve-voice-server
