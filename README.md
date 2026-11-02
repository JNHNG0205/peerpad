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

Note: sync needs at least one peer with the latest changes online. There is no always-on server.

## Run
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/index.html (single self-contained file)
```
Host `dist/index.html` on any static host (GitHub Pages, Netlify, Cloudflare Pages). HTTPS is required for WebRTC (localhost is fine).
