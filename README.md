# PeerPad

A peer-to-peer collaborative workspace for notes, docs and tasks. No server, no accounts: browsers sync directly.

## Features
- Nested pages, page icons, breadcrumbs, search (Ctrl+K)
- Block editor: text, H1–H3, bulleted / numbered / to-do lists, quote, callout, code, divider, sub-page links
- `/` command menu, markdown shortcuts (`# `, `- `, `1. `, `[] `, `> `, ```` ``` ````, `---`), Tab to indent, drag to reorder, multi-line paste
- Real-time collaboration with conflict-free merging (Yjs CRDT), live presence (who is on which page and block)
- Offline-first: every browser keeps a full copy in IndexedDB; edits merge when peers reconnect
- Undo/redo, Markdown export, multiple workspaces, invite links

## How it works
| Layer | Tech |
|---|---|
| Data model | Yjs CRDT (`pages` map → page → `blocks` array → `Y.Text`) |
| P2P transport | WebRTC via Trystero; public Nostr relays are used only for peer discovery |
| Security | Invite link carries a random workspace ID + key; the key encrypts the WebRTC handshake and never leaves the URL fragment |
| Same-device tabs | BroadcastChannel |
| Persistence | IndexedDB |

## Sync server (optional, recommended)
`server/server.js` keeps an always-on copy of every workspace, so edits sync even when nobody else is online, and connections work on networks that block WebRTC.

- **End-to-end encrypted**: browsers encrypt every change (AES-GCM, key derived from the invite key) before sending. The server stores and relays opaque blobs and never sees page content, names or keys. Workspace IDs are hashed too.
- **Serves the app**: open the server's address and the app uses that server automatically; invite links point there.
- Point any copy of the app at a server via workspace menu → **Sync server…**.

```bash
npm install && npm run build
npm start        # http://localhost:8787  (PORT, DATA_DIR env vars)
```

### Deploy
- **Render**: push this repo to GitHub → render.com → New → Blueprint → pick the repo (uses `render.yaml`, includes a 1 GB persistent disk).
- **Any Docker host** (Fly.io, Railway, a VPS): `docker build -t peerpad . && docker run -p 8787:8787 -v peerpad:/data peerpad`
- Put it behind HTTPS (Render/Fly/Railway do this for you). Keep `/data` on a persistent volume or workspaces are lost on redeploy.

## Run
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/index.html (single self-contained file)
```
Host `dist/index.html` on any static host (GitHub Pages, Netlify, Cloudflare Pages). HTTPS is required for WebRTC (localhost is fine).
