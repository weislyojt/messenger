# Parley

A real-time messenger: one-to-one and group chats, photos, videos, files, voice messages, reactions, replies, read receipts, typing indicators, and voice and video calls (1:1 and small groups).

It runs on plain Node.js with **no npm dependencies**: the database is Node's built-in SQLite, realtime runs over a built-in WebSocket server, and calls use WebRTC in the browser.

## Features

- **Accounts**: sign up with a username and password; sessions last 30 days.
- **Chats**: direct messages and named groups, unread counts, search, mute, online status and "last active".
- **Messages**: text with links, photos, videos, any file up to 100 MB, voice messages with waveforms, replies, six reactions, unsend, "Seen" receipts, typing indicators, drag-and-drop and paste to send.
- **Calls**: audio and video calls with ringing, accept, decline, audio-only answer, mute, camera on/off, flip camera (phones), screen sharing (desktop) and group calls (mesh, best for up to about 6 people). Calls are logged in the chat and in the Calls tab.
- **Works everywhere**: responsive layout for phones and desktops, light and dark mode, installable as an app from the browser.

## Run it locally

Requires Node.js 22.13 or newer.

```bash
npm start
# open http://localhost:3000
```

Data (the SQLite database and uploaded files) goes in `./data`. Set `DATA_DIR` to put it elsewhere.

## Deploy on Railway

1. Create a Railway service from this GitHub repo. Railway builds it with the included `Dockerfile`.
2. **Add a volume mounted at `/data`.** This keeps the database and uploaded media across deploys. Without it, everything is erased on each deploy.
3. Generate a domain for the service. The app listens on `PORT` (Railway sets it) and has a health check at `/healthz`.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `/data` in Docker | Where the database and uploads are stored. Point it at the volume. |
| `SESSION_SECRET` | generated and saved in `DATA_DIR` | Signs login sessions. |
| `MAX_UPLOAD_MB` | `100` | Largest file people can send. |
| `TURN_URLS` | none | Comma-separated TURN server URLs, e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349`. |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | none | Credentials for the TURN server. |

### About TURN (important for calls)

Calls connect directly between browsers. That works on most home Wi-Fi, but some mobile networks and office firewalls block direct connections. A TURN server relays the call in those cases. Railway doesn't provide one, so for reliable calls sign up with a TURN provider (for example Cloudflare Calls TURN, Metered, or Twilio) and set the `TURN_*` variables above.

## Limits of this version

- One server instance. SQLite and in-memory call state mean you shouldn't scale to multiple replicas.
- Messages are protected by HTTPS in transit but are not end-to-end encrypted.
- Push notifications work while the site is open in a browser tab; closed-app push needs a native app or a service worker, which is a natural next step before the App Store / Play Store.

## Tests

With the server running on port 3100 (`PORT=3100 npm start`):

```bash
node test/smoke.mjs      # backend: accounts, messages, media, reactions, calls signalling
python3 test/e2e.py      # two browsers: chat, media, voice message, video call (needs Playwright)
python3 test/group.py    # three-way group video call
```
