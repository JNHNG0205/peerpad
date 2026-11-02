import type { NextConfig } from 'next'

// Static export: the app runs entirely in the browser (peer-to-peer + end-to-end encryption),
// and the sync server serves the files in out/.
const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: false,
  devIndicators: false,
}
export default config
