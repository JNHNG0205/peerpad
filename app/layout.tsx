import type { Metadata, Viewport } from 'next'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'PeerPad',
  description: 'A collaborative workspace that syncs directly between browsers, end-to-end encrypted.',
}
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fcfcfb' },
    { media: '(prefers-color-scheme: dark)', color: '#161817' },
  ],
}

// Applies the saved theme before first paint, so there is no light flash in dark mode.
const themeScript = `try{var t=localStorage.getItem('pp-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark')}catch(e){}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
