export type SessionStatus = "in_progress" | "waiting_for_input" | "finished"

export type MessageRole = "user" | "assistant"

export interface GhosttyCorrelation {
  windowId: string | null
  terminalId: string
  correlatedAt: number
}

export interface TrackedSession {
  id: string
  directory: string
  originalTitle: string
  title: string
  description: string
  status: SessionStatus
  lastRole: MessageRole | null
  ghostty: GhosttyCorrelation | null
  times: {
    created: number
    lastMessage: number
    lastStatusChange: number
  }
}

export interface StateFile {
  version: 1
  updatedAt: number
  sessions: Record<string, TrackedSession>
}

export const STATE_VERSION = 1 as const
