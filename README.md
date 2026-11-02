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
- **DigitalOcean droplet / any VPS** (includes automatic HTTPS):
  ```bash
  echo "DOMAIN=notes.example.com" > .env   # or 203-0-113-5.sslip.io if you have no domain
  docker compose up -d --build
  ```
- **Any Docker host** (Fly.io, Railway, a VPS): `docker build -t peerpad . && docker run -p 8787:8787 -v peerpad:/data peerpad`
- Put it behind HTTPS (Render/Fly/Railway do this for you). Keep `/data` on a persistent volume or workspaces are lost on redeploy.

## Run
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/index.html (single self-contained file)
```
Host `dist/index.html` on any static host (GitHub Pages, Netlify, Cloudflare Pages). HTTPS is required for WebRTC (localhost is fine).

## AI access (MCP server)
`mcp/peerpad-mcp.js` lets AI tools read and edit a workspace: list, read and search pages; create pages from markdown; add, update and delete blocks; rename, move and delete pages. The AI joins like a teammate: edits appear live, and it shows up under "People here" while working.

It needs the workspace's invite link (Share button) and a sync server.

### Local (Claude Desktop, Claude Code, Cursor): recommended
The key stays on your computer; the server still sees only encrypted data.
```json
{
  "mcpServers": {
    "peerpad": {
      "command": "node",
      "args": ["/path/to/peerpad/mcp/peerpad-mcp.js"],
      "env": { "PEERPAD_INVITE": "https://notes.example.com/#ws=...&key=..." }
    }
  }
}
```
Claude Code: `claude mcp add peerpad -e PEERPAD_INVITE='<link>' -- node /path/to/peerpad/mcp/peerpad-mcp.js`

### Remote (claude.ai custom connector, any device)
Runs on the droplet next to the sync server. Trade-off: the droplet then holds the workspace key, so whoever controls the droplet can read that workspace.
```bash
echo "PEERPAD_INVITE=https://notes.example.com/#ws=...&key=..." >> .env
echo "MCP_TOKEN=$(openssl rand -hex 24)" >> .env
docker compose --profile mcp up -d --build
```
Connector URL: `https://notes.example.com/mcp/<MCP_TOKEN>` (or send `Authorization: Bearer <MCP_TOKEN>` to `/mcp`).

Self-check: `PEERPAD_INVITE='<link>' npm run mcp:smoke` (creates and deletes a test page).
