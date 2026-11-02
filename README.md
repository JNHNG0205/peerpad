# PeerPad

A self-hosted, end-to-end encrypted workspace for notes, docs and tasks. Your team writes together in real time; your server stores only encrypted data, so even whoever runs it can't read your pages.

Built with Next.js, React, TypeScript, Tailwind CSS, Motion and [BlockNote](https://www.blocknotejs.org/).

## Features
- Block editor with real formatting: headings, lists, to-dos, quotes, code, tables, images, files, callouts, **charts** (bar or line from an editable data table) and **table of contents**
- `/` menu, drag handles, Markdown shortcuts, formatting toolbar, undo/redo
- Real-time collaboration with live cursors and names; edits merge without conflicts
- Nested pages with icons, breadcrumbs, and search (Ctrl+K) over titles and the text of pages you have opened
- Share links with **Can edit** or **Can view** access, enforced by the server
- **AI agents**: connect Claude or Codex from the app, with edit or view access, and disconnect them any time
- Light, dark and system themes; works on phones
- Works offline: each browser keeps a copy and syncs when it reconnects
- Import Markdown files as pages; export pages as Markdown (charts, tables and images included)

## How it works
```
 Browser ──┐                                   ┌── Browser
           │  encrypted edits, presence, files │
           └────────►  PeerPad server  ◄───────┘
                    (stores encrypted data,
                     serves the web app)
```
- **Encryption happens in the browser.** Each workspace has a secret key that lives only in its invite links (after the `#`, which browsers never send to servers). Every edit and file is encrypted with it (AES-GCM) before it leaves the browser.
- **The server stores and relays encrypted data.** It keeps an always-on copy of each workspace, so teammates get changes even when nobody else is online. It never sees page content, titles, names or keys.
- **Permissions are enforced with signatures.** Edit links carry a private signing key; view links only the matching public key. The server rejects any change without a valid signature, so a view link can't edit, even with a modified app.

| Part | Tech |
|---|---|
| Documents | Yjs (conflict-free merging): a small root document (page list, titles) plus one document per page, loaded when the page is opened |
| Editor | BlockNote (ProseMirror); custom blocks in `components/blocks` |
| Presence and cursors | Yjs awareness, sent encrypted |
| Files | Shrunk in the browser, encrypted, stored on the server |
| Storage | SQLite on the server: each document's encrypted history is appended as rows; editors' browsers periodically replace long histories with one encrypted snapshot (the server can't, since it can't read them) |
| Traffic | Edits are bundled per 40 ms burst; presence and cursors at most ~8 updates/s; you only receive edits for pages you have open |
| Offline copy | IndexedDB in each browser (every page you've opened) |

## Project layout
```
app/          Next.js entry (layout, global styles)
components/   UI: App, Sidebar, Topbar, PageView, Editor, Dialogs, CommandPalette, blocks/
lib/          shared TypeScript: remote.ts (encrypted transport), sync.ts, pages.ts, markdown.ts, blocks.ts
server/       PeerPad server (Node): encrypted storage + relay, serves the web app from out/
mcp/          AI agents service (MCP): per-connection endpoints, connection registry
```

## Self-host

### DigitalOcean droplet or any VPS (automatic HTTPS)
GitHub builds the PeerPad image on every push (`.github/workflows/docker.yml`) and publishes it to GitHub Container Registry, so your server only downloads it; nothing is compiled there.

1. Point a domain or subdomain (DNS **A** record) at the server. No domain? Use `<your-ip-with-dashes>.sslip.io`.
2. Install Docker: `curl -fsSL https://get.docker.com | sh`
3. If the GitHub repository is private, let the server download the image. Create a GitHub token with only the `read:packages` permission (Settings → Developer settings → Personal access tokens → Tokens (classic)), then:
   ```bash
   echo <token> | docker login ghcr.io -u <github-username> --password-stdin
   ```
   (Public repository: skip this, or make just the package public under the repository's **Packages**.)
4. Start it:
   ```bash
   git clone https://github.com/JNHNG0205/peerpad.git && cd peerpad
   echo "DOMAIN=notes.example.com" > .env
   docker compose pull && docker compose up -d
   ```
5. Open `https://notes.example.com`, then **Share** to invite your team.

**Updating:** push to `main`, wait for the **Build image** run to finish (repository → Actions, a few minutes), then on the server:
```bash
cd ~/peerpad && git pull && docker compose pull && docker compose up -d
```
`git pull` only matters when `docker-compose.yml` or `Caddyfile` changed; the app itself comes from the image. A failed build never reaches the server: it keeps running the last good image.

**Data:** workspaces live in the `peerpad_peerpad-data` Docker volume (`peerpad.db`, a SQLite database, plus encrypted files), AI connections in `peerpad_mcp-data`. Never run `docker compose down -v` unless you want to delete them. Workspaces saved by earlier versions are imported into the database automatically the first time they are opened.

**Building on the server instead** (e.g. for a fork): `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`. On a 1 GB server, add 2 GB of swap first.

### Other hosts
- **Render**: New → Blueprint → pick this repo (`render.yaml`, includes a persistent disk). This runs the app and server only; AI agents need the Docker setup or a second service (see below).
- **Any Docker host**: `docker run -p 8787:8787 -v peerpad:/data ghcr.io/jnhng0205/peerpad:latest`, behind HTTPS.

### Local development
```bash
npm install
npm run build && npm start   # app + server on http://localhost:8787
npm run dev                  # UI with hot reload on http://localhost:3000 (set the server in workspace menu → Server)
```

## Sharing
- **Can edit**: write, rename and delete pages.
- **Can view**: read every page and see changes live.

Links contain the workspace key, so share them privately. There are no accounts: to remove someone's access, create a new workspace and move the pages over.

Workspaces created before view links existed have a single link that can edit. **Share → Turn on view-only links** upgrades them; older links then become view-only, so send editors the new edit link.

## AI agents (Claude, Codex)
Anyone in a workspace can connect an AI agent from the app; nobody needs server access.

1. Click **AI agents** (top right).
2. Pick **Claude** or **Codex**, choose **Can edit** or **Can view**, and click **Connect**. People with a view link can only connect read-only agents.
3. Copy the address it shows and follow the steps on screen:
   - **Claude (web, desktop, mobile):** Settings → Connectors → **Add custom connector** → name it `PeerPad`, paste the address → Add. Then turn PeerPad on in a chat's tools menu.
   - **Claude Code:** `claude mcp add --transport http peerpad "<address>"`
   - **Codex:** `codex mcp add peerpad --url "<address>"`, or add `[mcp_servers.peerpad]` with `url = "<address>"` to `~/.codex/config.toml`.

Then ask, for example: *"List my PeerPad pages"*, *"Add today's meeting notes to Project tasks"*, *"Create a page with a bar chart of our monthly signups"*. The agent can list, read and search pages; create pages from Markdown (with tables, charts and images); add, edit and delete blocks; and rename, move and delete pages. It appears under **People here** while it works, and its edits show up live.

**Managing connections:** the same dialog lists your connections. Editors see every AI connection in the workspace and can disconnect any of them; a disconnected address stops working immediately.

**Privacy:** each connection address contains a secret. The server stores the connection's workspace link encrypted with that secret and keeps only a hash of it, so its files on disk reveal nothing. While an agent is working, the server decrypts that workspace to answer it; when the agent is idle, the server cannot read it. Treat connection addresses like passwords.

### For whoever runs the server
AI agents are on by default in the Docker setup (the `mcp` service). Connections are stored in the `peerpad_mcp-data` volume. Health check: `curl -s https://notes.example.com/mcp/agents/status` should print `{"enabled":true}`.

Running without Docker: start the AI service with `TRANSPORT=http PORT=3333 DATA_DIR=./data/mcp PEERPAD_SYNC_URL=http://127.0.0.1:8787 node mcp/peerpad-mcp.ts` and the server with `MCP_UPSTREAM=http://127.0.0.1:3333 npm start`, which forwards `/mcp` to it.

Setups from before the AI agents button (`PEERPAD_INVITE` + `MCP_TOKEN` in `.env`) keep working at `https://<domain>/mcp/<MCP_TOKEN>`.

### Advanced: run an agent's MCP server on your own computer
For desktop AI apps, if you want the workspace key to never reach the server. Needs Node.js 22.18+:
```bash
git clone https://github.com/JNHNG0205/peerpad.git && cd peerpad && npm install
claude mcp add peerpad -e PEERPAD_INVITE='<link from Share>' -- node "$(pwd)/mcp/peerpad-mcp.ts"
codex mcp add peerpad --env PEERPAD_INVITE='<link from Share>' -- node "$(pwd)/mcp/peerpad-mcp.ts"
```
Self-check: `PEERPAD_INVITE='<edit link>' npm run mcp:smoke` (creates and deletes a test page).
