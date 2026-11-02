// AI agent connections: shared between the web app and the AI connector service.
// An editor proves edit rights for list/revoke by signing a short message with the workspace's
// signing key (the same key that signs edits). Messages expire after a few minutes.

export type AgentKind = 'claude' | 'codex' | 'other'
export type AgentAccess = 'edit' | 'view'
export type AgentConnection = {
  id: string
  name: string
  agent: AgentKind
  access: AgentAccess
  createdAt: number
  lastUsedAt: number | null
}

export const PROOF_MAX_AGE_MS = 5 * 60 * 1000
/** The exact bytes an editor signs to list or revoke a workspace's AI connections. */
export function proofMessage(action: 'list' | 'revoke' | 'revoke-all', pk: string, ts: number, id = ''): Uint8Array {
  return new TextEncoder().encode(`peerpad-agents:${action}:${pk}:${id}:${ts}`)
}
