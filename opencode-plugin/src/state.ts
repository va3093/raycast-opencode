import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { type PendingBlocker, type StateFile, type TrackedSession, STATE_VERSION } from "./types.js"

const STATE_DIR = path.join(homedir(), ".local", "state", "opencode-raycast")
const STATE_PATH = path.join(STATE_DIR, "sessions.json")

let writeChain: Promise<void> = Promise.resolve()

export function getStatePath(): string {
  return STATE_PATH
}

function emptyState(): StateFile {
  return { version: STATE_VERSION, updatedAt: Date.now(), sessions: {}, pendingBlockers: {} }
}

export async function readState(): Promise<StateFile> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8")
    const parsed = JSON.parse(raw) as StateFile
    if (parsed.version !== STATE_VERSION || typeof parsed.sessions !== "object" || parsed.sessions === null) {
      return emptyState()
    }
    return parsed
  } catch {
    return emptyState()
  }
}

async function writeStateAtomic(state: StateFile): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true })
  const tmp = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`
  const payload = JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2)
  await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 })
  await fs.rename(tmp, STATE_PATH)
}

export function mutateState(mutator: (state: StateFile) => void | Promise<void>): Promise<void> {
  const run = async () => {
    const state = await readState()
    await mutator(state)
    await writeStateAtomic(state)
  }
  writeChain = writeChain.then(run, run)
  return writeChain
}

export function upsertSession(id: string, patch: Partial<TrackedSession>): Promise<void> {
  return mutateState((state) => {
    const existing = state.sessions[id]
    const now = Date.now()
    if (existing) {
      state.sessions[id] = {
        ...existing,
        ...patch,
        id,
        ghostty: patch.ghostty !== undefined ? patch.ghostty : existing.ghostty,
        times: { ...existing.times, ...(patch.times ?? {}), updated: now },
      }
    } else {
      state.sessions[id] = {
        id,
        directory: patch.directory ?? "",
        originalTitle: patch.originalTitle ?? "",
        generatedTitle: patch.generatedTitle ?? null,
        description: patch.description ?? "",
        lastRenamedUserMessageID: patch.lastRenamedUserMessageID ?? null,
        ghostty: patch.ghostty ?? null,
        times: {
          created: patch.times?.created ?? now,
          updated: now,
        },
      }
    }
  })
}

export function removeSession(id: string): Promise<void> {
  return mutateState((state) => {
    delete state.sessions[id]
    if (state.pendingBlockers) delete state.pendingBlockers[id]
  })
}

export function setPendingBlocker(sessionID: string, blocker: PendingBlocker): Promise<void> {
  return mutateState((state) => {
    if (!state.pendingBlockers) state.pendingBlockers = {}
    state.pendingBlockers[sessionID] = blocker
  })
}

export function clearPendingBlocker(sessionID: string, requestID: string): Promise<void> {
  return mutateState((state) => {
    if (!state.pendingBlockers) return
    const current = state.pendingBlockers[sessionID]
    // Only clear if the request id matches, so a late replied event
    // for a stale request can't wipe a fresh asked event.
    if (current && current.requestID === requestID) {
      delete state.pendingBlockers[sessionID]
    }
  })
}

export async function getSession(id: string): Promise<TrackedSession | undefined> {
  const state = await readState()
  return state.sessions[id]
}
