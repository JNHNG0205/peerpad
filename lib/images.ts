// Images: shrink large photos in the browser, then store them encrypted on the sync server.
const MAX_INLINE = 1.5 * 1024 * 1024

export async function processImage(file: File): Promise<{ bytes: Uint8Array; mime: string }> {
  const orig = new Uint8Array(await file.arrayBuffer())
  if (!/^image\/(png|jpe?g|webp|bmp)$/.test(file.type)) return { bytes: orig, mime: file.type || 'application/octet-stream' }
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * scale)
    c.height = Math.round(bmp.height * scale)
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.9))
    if (blob && blob.size < orig.length) return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/webp' }
  } catch {}
  return { bytes: orig, mime: file.type }
}

type Assets = { upload: (b: Uint8Array) => Promise<string>; fetch: (id: string) => Promise<Uint8Array> } | null
const toDataUrl = (bytes: Uint8Array, mime: string) => new Promise<string>((res) => {
  const r = new FileReader()
  r.onload = () => res(r.result as string)
  r.readAsDataURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }))
})

/** BlockNote uploadFile: returns the URL stored in the block. */
export async function uploadFile(file: File, assets: Assets): Promise<string> {
  const { bytes, mime } = await processImage(file)
  if (assets) return `peerpad-asset:${await assets.upload(bytes)}?type=${encodeURIComponent(mime)}`
  if (bytes.length > MAX_INLINE) throw new Error('Files over 1.5 MB need a server (workspace menu → Server).')
  return toDataUrl(bytes, mime)
}

const cache = new Map<string, Promise<string>>()
/** BlockNote resolveFileUrl: turns a stored URL into one the browser can show. */
export function resolveFileUrl(url: string, assets: Assets): Promise<string> {
  if (!url.startsWith('peerpad-asset:')) return Promise.resolve(url)
  if (!cache.has(url)) {
    const p = (async () => {
      if (!assets) throw new Error('Connect a sync server to see this file.')
      const [id, q] = url.slice('peerpad-asset:'.length).split('?')
      const mime = new URLSearchParams(q || '').get('type') || 'application/octet-stream'
      const bytes = await assets.fetch(id)
      return URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }))
    })()
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return cache.get(url)!
}
