# PeerPad

A peer-to-peer collaborative workspace for notes, docs and tasks. Browsers sync directly and everything is end-to-end encrypted; an optional sync server keeps an always-on encrypted copy.

Built with Next.js (static export), React, TypeScript, Tailwind CSS, Motion and [BlockNote](https://www.blocknotejs.org/).

## Features
- Block editor with real formatting: headings, lists, to-dos, quotes, code, tables, images, files, callouts, **charts** (bar or line from an editable data table) and **table of contents**
- `/` menu, drag handles, Markdown shortcuts, formatting toolbar, undo/redo
- Real-time collaboration with live cursors and names, conflict-free merging (Yjs CRDT)
- Nested pages with icons, breadcrumbs, command palette search (Ctrl+K) over titles and page text
- Share links with **Can edit** or **Can view** access, enforced cryptographically
- Light, dark and system themes; works on phones
- Offline-first: every browser keeps a full copy; edits merge when peers reconnect
- Import Markdown files as pages; export pages as Markdown (charts, tables and images included)
- AI access for Claude, Codex and other MCP clients (see below)

## How it works
| Layer | Tech |
|---|---|
| Data model | Yjs: `pages` map (title, icon, parent) + one `Y.XmlFragment` per page (BlockNote document) |
| Editor | BlockNote (ProseMirror) bound to the page fragment; custom blocks in `components/blocks` |
| P2P transport | WebRTC via Trystero; public Nostr relays are used only for peer discovery |
| Presence and cursors | y-protocols awareness, sent over the same encrypted channels |
| Security | The invite link carries a random workspace ID + key in the URL fragment (never sent to servers) |
| Permissions | Edit links carry an ECDSA P-256 private key, view links only the public key. Every change is signed; the sync server and peers drop unsigned changes |
| Images and files | Shrunk in the browser, encrypted with the workspace key, stored as opaque files on the sync server. Without a server, files up to 1.5 MB are embedded |
| Persistence | IndexedDB in each browser; the sync server stores encrypted updates |

Pages from the first version of PeerPad are converted to the new format automatically the first time an editor opens them (the old data is kept).

## Project layout
```
app/          Next.js entry (layout, global styles)
components/   UI: App, Sidebar, Topbar, PageView, Editor, Dialogs, CommandPalette, blocks/
lib/          shared TypeScript: remote.ts (encrypted transport), sync.ts, pages.ts, markdown.ts, blocks.ts
server/       sync server (Node): encrypted storage + relay, serves the built app from out/
mcp/          MCP server for AI tools (TypeScript, run directly by Node 22.18+)
```

## Run locally
```bash
npm install
npm run build     # static export -> out/
npm start         # sync server + app on http://localhost:8787
```
For UI development, `npm run dev` (http://localhost:3000) and point it at a running sync server via workspace menu → Sync server.

## Sharing: Can edit / Can view
New workspaces get both link types (Share button). A view link can read everything and sees changes live, but cannot change anything, even with a modified app.

Workspaces created before view links existed have one link that can edit. Share → **Turn on view-only links** upgrades them (needs a sync server). After the upgrade, older links become view-only, so send editors the new edit link.

Limits: there are no accounts, so access can't be revoked per person; to remove someone, create a new workspace.

## Deploy
- **DigitalOcean droplet / any VPS** (automatic HTTPS with Caddy):
  ```bash
  echo "DOMAIN=notes.example.com" > .env   # or 203-0-113-5.sslip.io if you have no domain
  docker compose up -d --build
  ```
- **Render**: push to GitHub → render.com → New → Blueprint → pick the repo (`render.yaml`, includes a persistent disk).
- **Any Docker host**: `docker build -t peerpad . && docker run -p 8787:8787 -v peerpad:/data peerpad`

Keep `/data` on a persistent volume, and serve over HTTPS (needed for encryption and WebRTC).

## AI access (MCP server)
`mcp/peerpad-mcp.ts` lets AI tools read and edit a workspace: list, read and search pages; create pages from Markdown (including tables, charts and images); add, update and delete blocks; rename, move and delete pages. The AI joins like a teammate: edits appear live and it shows up under "People here".

### Local (Claude Desktop, Claude Code, Codex, Cursor): key stays on your computer
Needs Node.js 22.18+ and `npm install` in a clone of this repo.
```json
{
  "mcpServers": {
    "peerpad": {
      "command": "node",
      "args": ["/path/to/peerpad/mcp/peerpad-mcp.ts"],
      "env": { "PEERPAD_INVITE": "https://notes.example.com/#ws=...&key=...&pk=...&sk=..." }
    }
  }
}
```
Claude Code: `claude mcp add peerpad -e PEERPAD_INVITE='<link>' -- node /path/to/peerpad/mcp/peerpad-mcp.ts`

### Remote (claude.ai custom connector, any device)
Runs on the server next to the sync server. Trade-off: the server then holds that workspace's key.
```bash
echo "PEERPAD_INVITE='https://notes.example.com/#ws=...'" >> .env
echo "MCP_TOKEN=$(openssl rand -hex 24)" >> .env
docker compose --profile mcp up -d --build
```
Connector URL: `https://notes.example.com/mcp/<MCP_TOKEN>` (or send `Authorization: Bearer <MCP_TOKEN>` to `/mcp`).

Use a **Can view** link to give the AI read-only access. Self-check: `PEERPAD_INVITE='<edit link>' npm run mcp:smoke`.
