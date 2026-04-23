import { promises as fs } from "fs"
import { homedir } from "os"
import path from "path"

export interface GhosttyCorrelation {
  terminalId: string
  correlatedAt: number
}

export interface TrackedSession {
  id: string
  directory: string
  originalTitle: string
  generatedTitle: string | null
  description: string
  lastRenamedUserMessageID: string | null
  ghostty: GhosttyCorrelation | null
  times: {
    created: number
    updated: number
  }
}

export interface PendingBlocker {
  type: "permission" | "question"
  requestID: string
  askedAt: number
}

export interface StateFile {
  version: 2
  updatedAt: number
  sessions: Record<string, TrackedSession>
  pendingBlockers?: Record<string, PendingBlocker>
}

export const STATE_PATH = path.join(homedir(), ".local", "state", "opencode-raycast", "sessions.json")

const emptyState = (): StateFile => ({ version: 2, updatedAt: 0, sessions: {}, pendingBlockers: {} })

export async function readSessionState(): Promise<StateFile> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8")
    const parsed = JSON.parse(raw) as StateFile
    if (parsed.version !== 2 || typeof parsed.sessions !== "object" || parsed.sessions === null) return emptyState()
    return parsed
  } catch {
    return emptyState()
  }
}
