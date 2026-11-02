'use client'
import dynamic from 'next/dynamic'
import { Splash } from '@/components/Splash'

// The app runs in the browser (encryption keys never leave it), so it is never rendered on a server.
const App = dynamic(() => import('@/components/App'), { ssr: false, loading: () => <Splash /> })

export default function Page() {
  return <App />
}
