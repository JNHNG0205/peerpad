'use client'
import dynamic from 'next/dynamic'
import { Splash } from '@/components/Splash'

// Approval page for AI apps connecting to PeerPad (OAuth). Runs in the browser, where the workspace keys are.
const Authorize = dynamic(() => import('@/components/Authorize'), { ssr: false, loading: () => <Splash message="Loading…" /> })

export default function Page() {
  return <Authorize />
}
