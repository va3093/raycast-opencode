import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Message, Part, Session } from "@opencode-ai/sdk"
import { correlateGhostty } from "./ghostty.js"
import { isHaikuConfigured, renameSession, summariseSession } from "./haiku.js"
import { getStatePath, mutateState, readState, removeSession, upsertSession } from "./state.js"

const RENAME_DEBOUNCE_MS = 1_500
const CORRELATE_RETRY_MS = 2_000
const MAX_CORRELATE_RETRIES = 5

const DEBUG_LOG_PATH = path.join(homedir(), ".local", "state", "opencode-raycast", "plugin-debug.log")
try {
  mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true })
} catch {
  /* ignore */
}
function debugLog(msg: string, extra?: unknown): void {
  try {
    const line = `[${new Date().toISOString()}] ${msg}${extra !== undefined ? " " + JSON.stringify(extra) : ""}\n`
    appendFileSync(DEBUG_LOG_PATH, line)
  } catch {
    /* ignore */
  }
}

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

function partsToText(parts: Part[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim()
}

async function fetchMessages(
  client: PluginInput["client"],
  sessionID: string,
  limit: number
): Promise<Array<{ info: Message; parts: Part[] }>> {
  try {
    const res = await client.session.messages({ path: { id: sessionID }, query: { limit } })
    return (res.data ?? []) as Array<{ info: Message; parts: Part[] }>
  } catch {
    return []
  }
}

async function buildTranscript(client: PluginInput["client"], sessionID: string, limit: number): Promise<string> {
  const messages = await fetchMessages(client, sessionID, limit)
  return messages
    .map(({ info, parts }) => {
      const role = info.role === "user" ? "User" : "Assistant"
      const text = partsToText(parts)
      return text ? `${role}: ${text}` : ""
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12_000)
}

/**
 * Build a rename prompt from all user messages in chronological order.
 * If the combined text is longer than MAX chars, keep the first ~8k (the
 * original intent) and the last ~4k (recent pivots) joined by a gap
 * marker. This avoids over-weighting the latest turn.
 */
async function buildUserPromptTranscript(
  client: PluginInput["client"],
  sessionID: string
): Promise<string> {
  // No sensible cap: fetch the whole history. opencode's /message endpoint
  // returns in chronological order; passing a huge limit is fine because
  // the server streams rows from the DB.
  const messages = await fetchMessages(client, sessionID, 10_000)
  const blocks = messages
    .filter(({ info }) => info.role === "user")
    .map(({ parts }, i) => {
      const text = partsToText(parts)
      return text ? `[${i + 1}] ${text}` : ""
    })
    .filter(Boolean)

  if (blocks.length === 0) return ""

  const combined = blocks.join("\n\n")
  const MAX = 12_000
  if (combined.length <= MAX) return combined

  const HEAD = 8_000
  const TAIL = 4_000
  return combined.slice(0, HEAD) + "\n\n…[older turns omitted]…\n\n" + combined.slice(combined.length - TAIL)
}

async function attemptCorrelation(session: Session, attempt = 0): Promise<void> {
  const match = await correlateGhostty({
    sessionId: session.id,
    title: session.title,
    directory: session.directory,
  })

  if (match) {
    await upsertSession(session.id, {
      ghostty: { terminalId: match.terminalId, correlatedAt: Date.now() },
    })
    return
  }

  if (attempt < MAX_CORRELATE_RETRIES) {
    setTimeout(() => {
      void attemptCorrelation(session, attempt + 1)
    }, CORRELATE_RETRY_MS * (attempt + 1))
  }
}

function scheduleRename(client: PluginInput["client"], sessionID: string, userMessageID: string): void {
  const entry = inflight.get(sessionID) ?? {}
  if (entry.renameTimer) clearTimeout(entry.renameTimer)
  entry.renameTimer = setTimeout(() => {
    entry.renameTimer = undefined
    void runRename(client, sessionID, userMessageID)
  }, RENAME_DEBOUNCE_MS)
  inflight.set(sessionID, entry)
}

async function runRename(
  client: PluginInput["client"],
  sessionID: string,
  userMessageID: string
): Promise<void> {
  if (!isHaikuConfigured()) return
  try {
    const transcript = await buildUserPromptTranscript(client, sessionID)
    if (!transcript) return
    const state = await readState()
    const currentTitle = state.sessions[sessionID]?.generatedTitle ?? undefined
    const result = await renameSession(transcript, currentTitle)
    if (!result) return

    await upsertSession(sessionID, {
      generatedTitle: result.title,
      description: result.description,
      lastRenamedUserMessageID: userMessageID,
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

export const OpencodeRaycastStatePlugin: Plugin = async (input) => {
  const { client } = input

  debugLog("plugin loaded", { statePath: getStatePath(), haiku: isHaikuConfigured() })
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
              times: { created: session.time.created ?? now, updated: now },
            })
            void attemptCorrelation(session)
            break
          }

          case "session.updated": {
            const session = event.properties.info
            await upsertSession(session.id, { directory: session.directory })
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
            if (info.role !== "user") break
            // Dedupe trailing re-emits: only schedule a rename the first time
            // we see a given user message id for this session.
            const state = await readState()
            const tracked = state.sessions[info.sessionID]
            if (tracked?.lastRenamedUserMessageID === info.id) break
            scheduleRename(client, info.sessionID, info.id)
            break
          }

          case "session.idle": {
            const sessionID = event.properties.sessionID
            // Summarise only when the most recent real message is from the
            // assistant (a turn genuinely completed).
            const messages = await fetchMessages(client, sessionID, 20)
            let lastRealRole: "user" | "assistant" | null = null
            for (let i = messages.length - 1; i >= 0; i--) {
              if (partsToText(messages[i].parts).length > 0) {
                lastRealRole = messages[i].info.role === "user" ? "user" : "assistant"
                break
              }
            }
            if (lastRealRole === "assistant") void runSummary(client, sessionID)
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
