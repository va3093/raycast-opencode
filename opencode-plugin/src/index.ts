import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Message, Part, Session } from "@opencode-ai/sdk"
import { correlateGhostty } from "./ghostty.js"
import { isHaikuConfigured, renameSession, summariseSession } from "./haiku.js"
import { getStatePath, mutateState, readState, removeSession, upsertSession } from "./state.js"
import type { MessageRole, TrackedSession } from "./types.js"

const RENAME_DEBOUNCE_MS = 1_500
const CORRELATE_RETRY_MS = 2_000
const MAX_CORRELATE_RETRIES = 5

const inflight = new Map<string, { renameTimer?: NodeJS.Timeout; summarising?: boolean }>()

function log(
  client: PluginInput["client"],
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
): void {
  void client.app
    .log({
      body: { service: "opencode-raycast-state", level, message, extra: extra as any },
    })
    .catch(() => {})
}

function lastRoleFromMessage(info: Message): MessageRole {
  return info.role === "user" ? "user" : "assistant"
}

function partsToText(parts: Part[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim()
}

async function buildTranscript(client: PluginInput["client"], sessionID: string, limit: number): Promise<string> {
  try {
    const res = await client.session.messages({ path: { id: sessionID }, query: { limit } })
    const messages = (res.data ?? []) as Array<{ info: Message; parts: Part[] }>
    return messages
      .map(({ info, parts }) => {
        const role = info.role === "user" ? "User" : "Assistant"
        const text = partsToText(parts)
        return text ? `${role}: ${text}` : ""
      })
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 12_000)
  } catch {
    return ""
  }
}

async function attemptCorrelation(session: Session, attempt = 0): Promise<void> {
  const match = await correlateGhostty({
    sessionId: session.id,
    title: session.title,
    directory: session.directory,
  })

  if (match) {
    await upsertSession(session.id, {
      ghostty: {
        terminalId: match.terminalId,
        windowId: match.windowId,
        correlatedAt: Date.now(),
      },
    })
    return
  }

  if (attempt < MAX_CORRELATE_RETRIES) {
    setTimeout(() => {
      void attemptCorrelation(session, attempt + 1)
    }, CORRELATE_RETRY_MS * (attempt + 1))
  }
}

function scheduleRename(client: PluginInput["client"], sessionID: string): void {
  const entry = inflight.get(sessionID) ?? {}
  if (entry.renameTimer) clearTimeout(entry.renameTimer)
  entry.renameTimer = setTimeout(() => {
    entry.renameTimer = undefined
    void runRename(client, sessionID)
  }, RENAME_DEBOUNCE_MS)
  inflight.set(sessionID, entry)
}

async function runRename(client: PluginInput["client"], sessionID: string): Promise<void> {
  if (!isHaikuConfigured()) return
  try {
    const transcript = await buildTranscript(client, sessionID, 6)
    if (!transcript) return
    const result = await renameSession(transcript)
    if (!result) return

    await upsertSession(sessionID, {
      title: result.title,
      description: result.description,
    })

    try {
      await client.session.update({ path: { id: sessionID }, body: { title: result.title } })
    } catch (err) {
      log(client, "warn", "session.update failed", { sessionID, error: String(err) })
    }
  } catch (err) {
    log(client, "error", "rename failed", { sessionID, error: String(err) })
  }
}

async function runSummary(client: PluginInput["client"], sessionID: string): Promise<void> {
  if (!isHaikuConfigured()) return
  const entry = inflight.get(sessionID) ?? {}
  if (entry.summarising) return
  entry.summarising = true
  inflight.set(sessionID, entry)
  try {
    const transcript = await buildTranscript(client, sessionID, 20)
    if (!transcript) return
    const result = await summariseSession(transcript)
    if (!result) return
    await upsertSession(sessionID, { description: result.description })
  } catch (err) {
    log(client, "error", "summary failed", { sessionID, error: String(err) })
  } finally {
    const current = inflight.get(sessionID)
    if (current) {
      current.summarising = false
      inflight.set(sessionID, current)
    }
  }
}

function currentStateOnIdle(lastRole: MessageRole | null): TrackedSession["status"] {
  if (lastRole === "user") return "waiting_for_input"
  if (lastRole === "assistant") return "finished"
  return "finished"
}

export const OpencodeRaycastStatePlugin: Plugin = async (input) => {
  const { client } = input

  log(client, "info", "plugin loaded", {
    statePath: getStatePath(),
    haiku: isHaikuConfigured(),
  })

  return {
    event: async ({ event }) => {
      try {
        switch (event.type) {
          case "session.created": {
            const session = event.properties.info
            const now = Date.now()
            await upsertSession(session.id, {
              directory: session.directory,
              originalTitle: session.title,
              title: session.title,
              description: "",
              status: "in_progress",
              lastRole: null,
              times: { created: session.time.created ?? now, lastMessage: now, lastStatusChange: now },
            })
            void attemptCorrelation(session)
            break
          }

          case "session.updated": {
            const session = event.properties.info
            await upsertSession(session.id, {
              directory: session.directory,
              title: session.title,
            })
            const state = await readState()
            const tracked = state.sessions[session.id]
            if (!tracked?.ghostty) void attemptCorrelation(session)
            break
          }

          case "session.deleted": {
            await removeSession(event.properties.info.id)
            inflight.delete(event.properties.info.id)
            break
          }

          case "message.updated": {
            const info = event.properties.info
            const role = lastRoleFromMessage(info)
            const now = Date.now()
            await mutateState((state) => {
              const tracked = state.sessions[info.sessionID]
              if (!tracked) return
              tracked.lastRole = role
              tracked.status = "in_progress"
              tracked.times.lastMessage = now
              tracked.times.lastStatusChange = now
            })
            if (role === "user") scheduleRename(client, info.sessionID)
            break
          }

          case "session.idle": {
            const sessionID = event.properties.sessionID
            const now = Date.now()
            let didTransition = false
            await mutateState((state) => {
              const tracked = state.sessions[sessionID]
              if (!tracked) return
              const next = currentStateOnIdle(tracked.lastRole)
              if (tracked.status !== next) {
                tracked.status = next
                tracked.times.lastStatusChange = now
                didTransition = true
              }
            })
            if (didTransition) void runSummary(client, sessionID)
            break
          }

          default:
            break
        }
      } catch (err) {
        log(client, "error", "event handler failed", {
          type: (event as { type?: string }).type,
          error: String(err),
        })
      }
    },
  }
}

export default OpencodeRaycastStatePlugin
