import { promises as fs } from "fs"
import { homedir } from "os"
import path from "path"

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

export const STATE_PATH = path.join(homedir(), ".local", "state", "opencode-raycast", "sessions.json")

const emptyState = (): StateFile => ({
  version: 1,
  updatedAt: 0,
  sessions: {},
})

export async function readSessionState(): Promise<StateFile> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8")
    const parsed = JSON.parse(raw) as StateFile
    if (parsed.version !== 1 || typeof parsed.sessions !== "object" || parsed.sessions === null) return emptyState()
    return parsed
  } catch {
    return emptyState()
  }
}

export async function statStateFile(): Promise<number> {
  try {
    const s = await fs.stat(STATE_PATH)
    return s.mtimeMs
  } catch {
    return 0
  }
}
