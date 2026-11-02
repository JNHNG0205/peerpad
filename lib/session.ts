// Browser session: which workspace is open (from the link), its keys, the shared document and the network.
'use client'
import * as Y from 'yjs'
import { connect, loadLocal, generateWriteKeys, loadSigner, type Net } from './sync.ts'
import { pagesOf } from './pages.ts'

export type Me = { name: string; color: string }
export const COLORS = ['#e5484d', '#f76b15', '#d6a100', '#30a46c', '#12a594', '#0090ff', '#6e56cf', '#d6409f']
const ANIMALS = ['Otter', 'Heron', 'Lynx', 'Panda', 'Koala', 'Falcon', 'Badger', 'Gecko', 'Moose', 'Robin', 'Whale', 'Fox']

export const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d } catch { return d } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}
export const randToken = (n = 12): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function loadMe(): Me {
  const me = store.get<Me | null>('pp-me', null) || {
    name: ANIMALS[Math.floor(Math.random() * ANIMALS.length)] + ' ' + Math.floor(Math.random() * 90 + 10),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }
  store.set('pp-me', me)
  return me
}

export type Recent = { ws: string; key: string; name?: string; srv?: string | null; pk?: string | null; sk?: string | null; ts?: number }
export type Session = {
  ws: string; key: string
  srv: string | null          // from the link: a server address, 'none', or null
  serverUrl: string | null    // the server actually used
  servedByServer: boolean     // this page was loaded from a PeerPad sync server
  pk: string | null; sk: string | null
  readOnly: boolean
  createdHere: boolean
  doc: Y.Doc
  pages: Y.Map<Y.Map<any>>
  meta: Y.Map<any>
  net: Net
}

export const params = () => new URLSearchParams(location.hash.slice(1))
export function hashFor(w: Recent, page?: string | null, extra = ''): string {
  const p = new URLSearchParams({ ws: w.ws, key: w.key })
  for (const k of ['srv', 'pk', 'sk'] as const) if (w[k]) p.set(k, w[k] as string)
  if (page) p.set('p', page)
  return p.toString() + extra
}

/** Read the link (or the last workspace), load the offline copy and connect. */
export async function startSession(): Promise<Session> {
  const p = params()
  const recent = store.get<Recent[]>('pp-recent', [])
  let ws: string, key: string, srv: string | null, pk: string | null, sk: string | null, createdHere = false
  if (p.get('ws') && p.get('key')) {
    ws = p.get('ws')!; key = p.get('key')!
    const known = recent.find((w) => w.ws === ws)
    srv = p.get('srv') || known?.srv || null
    pk = p.get('pk') || known?.pk || null
    // this browser keeps edit access if it had it before, even when opening a view link
    sk = p.get('sk') || (known?.pk === pk ? known?.sk : null) || null
    createdHere = !!p.get('new')
  } else if (recent[0]) {
    ;({ ws, key } = recent[0]); srv = recent[0].srv || null; pk = recent[0].pk || null; sk = recent[0].sk || null
  } else {
    ws = randToken(9); key = randToken(16); srv = null; pk = null; sk = null; createdHere = true
  }
  if (createdHere && !pk) ({ pk, sk } = await generateWriteKeys())

  let serverUrl = srv && srv !== 'none' ? srv : null
  let servedByServer = false
  if (location.protocol.startsWith('http')) {
    try {
      const r = await fetch(new URL('peerpad-health', location.href), { cache: 'no-store' })
      if (r.ok && (await r.json()).peerpad) {
        servedByServer = true
        if (!serverUrl && srv !== 'none') serverUrl = new URL('.', location.href).href.replace(/\/+$/, '')
      }
    } catch {}
  }

  const doc = new Y.Doc()
  await loadLocal(doc, ws)
  const signer = await loadSigner(pk, sk).catch(() => null)
  if (pk && !signer?.canWrite) sk = null
  const net = connect(doc, ws, key, serverUrl, signer)
  const s: Session = {
    ws, key, srv, serverUrl, servedByServer, pk, sk, createdHere,
    readOnly: !!pk && !sk,
    doc, pages: pagesOf(doc), meta: doc.getMap('meta'), net,
  }
  return s
}

/** Address bar link for this session (edit access), optionally to a page. */
export function sessionHash(s: Session, page?: string | null): string {
  return hashFor({ ws: s.ws, key: s.key, srv: s.serverUrl && !s.servedByServer ? s.serverUrl : null, pk: s.pk, sk: s.readOnly ? null : s.sk }, page)
}
/** Invite link: edit=true can edit, false is view-only. */
export function inviteLink(s: Session, edit: boolean): string {
  const base = s.servedByServer && s.serverUrl ? s.serverUrl.replace(/\/+$/, '') + '/' : location.href.split('#')[0]
  return base + '#' + hashFor({ ws: s.ws, key: s.key, srv: s.serverUrl && !s.servedByServer ? s.serverUrl : null, pk: s.pk, sk: edit && !s.readOnly ? s.sk : null })
}
export function rememberWorkspace(s: Session, name: string) {
  const list = store.get<Recent[]>('pp-recent', []).filter((w) => w.ws !== s.ws)
  list.unshift({ ws: s.ws, key: s.key, name, srv: s.srv === 'none' ? 'none' : s.serverUrl, pk: s.pk, sk: s.readOnly ? null : s.sk, ts: Date.now() })
  store.set('pp-recent', list.slice(0, 12))
}
export async function newWorkspaceHash(serverUrl: string | null): Promise<string> {
  const keys = await generateWriteKeys()
  return hashFor({ ws: randToken(9), key: randToken(16), srv: serverUrl, ...keys }, null, '&new=1')
}
export { generateWriteKeys }
