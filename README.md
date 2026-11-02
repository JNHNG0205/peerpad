# PeerPad

A self-hosted, end-to-end encrypted workspace for notes, docs and tasks. Your team writes together in real time; your server stores only encrypted data, so even whoever runs it can't read your pages.

Built with Next.js, React, TypeScript, Tailwind CSS, Motion and [BlockNote](https://www.blocknotejs.org/).

## Features
- Block editor with real formatting: headings, lists, to-dos, quotes, code, tables, images, files, callouts, **charts** (bar or line from an editable data table) and **table of contents**
- `/` menu, drag handles, Markdown shortcuts, formatting toolbar, undo/redo
- Real-time collaboration with live cursors and names; edits merge without conflicts
- Nested pages with icons, breadcrumbs, and search over titles and page text (Ctrl+K)
- Share links with **Can edit** or **Can view** access, enforced by the server
- AI access: Claude, Codex and other MCP clients can read and edit pages
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
- **Browsers also connect directly when they can** (WebRTC), which makes typing between teammates feel instant. The server remains the source of truth.

| Part | Tech |
|---|---|
| Documents | Yjs (conflict-free merging): a `pages` map plus one BlockNote document per page |
| Editor | BlockNote (ProseMirror); custom blocks in `components/blocks` |
| Presence and cursors | Yjs awareness, sent encrypted |
| Files | Shrunk in the browser, encrypted, stored on the server |
| Offline copy | IndexedDB in each browser |

## Project layout
```
app/          Next.js entry (layout, global styles)
components/   UI: App, Sidebar, Topbar, PageView, Editor, Dialogs, CommandPalette, blocks/
lib/          shared TypeScript: remote.ts (encrypted transport), sync.ts, pages.ts, markdown.ts, blocks.ts
server/       PeerPad server (Node): encrypted storage + relay, serves the web app from out/
mcp/          MCP server for AI tools
```

## Self-host

### DigitalOcean droplet or any VPS (automatic HTTPS)
1. Point a domain or subdomain (DNS **A** record) at the server. No domain? Use `<your-ip-with-dashes>.sslip.io`.
2. Install Docker: `curl -fsSL https://get.docker.com | sh`
3. On a 1 GB server, add swap so the build has enough memory:
   ```bash
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```
4. Start it:
   ```bash
   git clone https://github.com/JNHNG0205/peerpad.git && cd peerpad
   echo "DOMAIN=notes.example.com" > .env
   docker compose up -d --build
   ```
5. Open `https://notes.example.com`, then **Share** to invite your team.

Update later with `git pull && docker compose up -d --build`. Workspaces live in the `peerpad_peerpad-data` Docker volume; never run `docker compose down -v` unless you want to delete them.

### Other hosts
- **Render**: New → Blueprint → pick this repo (`render.yaml`, includes a persistent disk).
- **Any Docker host**: `docker build -t peerpad . && docker run -p 8787:8787 -v peerpad:/data peerpad`, behind HTTPS.

### Local development
```bash
npm install
npm run build && npm start   # app + server on http://localhost:8787
npm run dev                  # UI with hot reload on http://localhost:3000 (set the server in workspace menu → Sync server)
```

## Sharing
- **Can edit**: write, rename and delete pages.
- **Can view**: read every page and see changes live.

Links contain the workspace key, so share them privately. There are no accounts: to remove someone's access, create a new workspace and move the pages over.

Workspaces created before view links existed have a single link that can edit. **Share → Turn on view-only links** upgrades them; older links then become view-only, so send editors the new edit link.

## AI access (MCP)
PeerPad includes an MCP server so AI assistants can work in a workspace: list, read and search pages; create pages from Markdown (with tables, charts and images); add, edit and delete blocks; rename, move and delete pages. The AI shows up under **People here** while it works, and its edits appear live for everyone.

### 1. Turn it on (once, on your server)
In PeerPad, click **Share** and copy the link the AI should use: **Can edit** to let it write, **Can view** for read-only. Then:
```bash
cd ~/peerpad
echo "PEERPAD_INVITE='<paste the link>'" >> .env    # keep the single quotes
echo "PEERPAD_AI_NAME=AI assistant" >> .env
echo "MCP_TOKEN=$(openssl rand -hex 24)" >> .env
docker compose --profile mcp up -d --build
echo "https://$(grep ^DOMAIN .env | cut -d= -f2)/mcp/$(grep ^MCP_TOKEN .env | cut -d= -f2)"
```
The last command prints your **connector address**. Treat it like a password: anyone with it can use the AI tools with the access of the link you chose.

### 2. Connect your AI tool
**Claude (web, desktop and mobile):** Settings → Connectors → **Add custom connector** → name `PeerPad`, paste the connector address → Add. Then turn PeerPad on in a chat's tools menu.

**Claude Code:**
```bash
claude mcp add --transport http peerpad "<connector address>"
```

**Codex:**
```bash
codex mcp add peerpad --url "<connector address>"
```
Or in `~/.codex/config.toml`, keeping the token out of the file:
```toml
[mcp_servers.peerpad]
url = "https://notes.example.com/mcp"
bearer_token_env_var = "PEERPAD_MCP_TOKEN"
```

Then ask, for example: *"List my PeerPad pages"*, *"Add today's meeting notes to Project tasks"*, *"Create a page with a bar chart of our monthly signups"*.

### Good to know
- One MCP server works with one workspace (the link in `.env`).
- The server needs that workspace's key to let the AI read pages, so the server can read that workspace. Other workspaces stay unreadable to it.
- To revoke access: put a new `MCP_TOKEN` in `.env`, run `docker compose --profile mcp up -d`, and update the address in your AI tools.
- Health check: `curl -s -o /dev/null -w "%{http_code}\n" https://notes.example.com/mcp` should print `401`.

### Advanced: run the MCP server on your own computer
For maximum privacy (the key never leaves your machine) with desktop AI apps. Needs Node.js 22.18+:
```bash
git clone https://github.com/JNHNG0205/peerpad.git && cd peerpad && npm install
claude mcp add peerpad -e PEERPAD_INVITE='<link>' -- node "$(pwd)/mcp/peerpad-mcp.ts"
codex mcp add peerpad --env PEERPAD_INVITE='<link>' -- node "$(pwd)/mcp/peerpad-mcp.ts"
```
Self-check: `PEERPAD_INVITE='<edit link>' npm run mcp:smoke` (creates and deletes a test page).
