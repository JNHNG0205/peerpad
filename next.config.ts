import type { NextConfig } from 'next'

// Static export: the app runs in the browser (end-to-end encryption happens there),
// and the PeerPad server serves the files in out/.
const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: false,
  devIndicators: false,
}
export default config
