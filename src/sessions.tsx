import {
  List,
  ActionPanel,
  Action,
  Icon,
  showToast,
  Toast,
  getPreferenceValues,
  confirmAlert,
  Keyboard,
  Alert,
  Color,
  showHUD,
} from "@raycast/api"
import { useState, useEffect, useMemo, useRef } from "react"
import { getClient, resetClient, Session, type SessionRunStatus } from "./lib/opencode"
import { clearCachedServer } from "./lib/server-manager"
import { handoffToOpenCode, copySessionCommand } from "./lib/handoff"
import { useSessionSearch } from "./hooks/useSessionSearch"
import { homedir } from "os"
import { readSessionState, type TrackedSession } from "./lib/session-state"
import { focusGhosttyWindow, listGhosttyTerminals, correlateSessions, type GhosttyTerminal } from "./lib/ghostty"

import { TerminalApp } from "./lib/handoff"

interface Preferences {
  handoffMethod: "terminal" | "desktop"
  terminalApp: TerminalApp
  finishedAfterHours?: string
  serverUrl?: string
  serverUsername?: string
  serverPassword?: string
}

type DerivedStatus = "in_progress" | "blocked" | "waiting_for_turn" | "finished"

const POLL_MS = 1_500
const LIST_RELOAD_MS = 10_000
const DEFAULT_FINISHED_AFTER_HOURS = 6

const STATUS_META: Record<DerivedStatus, { icon: { source: Icon; tintColor: Color }; label: string }> = {
  in_progress: {
    icon: { source: Icon.CircleFilled, tintColor: Color.Green },
    label: "In progress",
  },
  blocked: {
    icon: { source: Icon.CircleFilled, tintColor: Color.Orange },
    label: "Needs response",
  },
  waiting_for_turn: {
    icon: { source: Icon.CircleFilled, tintColor: Color.Yellow },
    label: "Your turn",
  },
  finished: {
    icon: { source: Icon.CircleFilled, tintColor: Color.SecondaryText },
    label: "Finished",
  },
}

function parseHours(value: string | undefined): number {
  if (value === undefined || value === null || value.trim() === "") return DEFAULT_FINISHED_AFTER_HOURS
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_FINISHED_AFTER_HOURS
  return n
}

interface LiveState {
  sessionStatus: Record<string, SessionRunStatus>
  blockedSessionIDs: Set<string>
  /** Session IDs whose most recent assistant message has no time.completed,
   * which we treat as "actively streaming" regardless of which opencode
   * process is driving the session. */
  streamingSessionIDs: Set<string>
  openGhosttyTerminals: GhosttyTerminal[]
}

const EMPTY_LIVE: LiveState = {
  sessionStatus: {},
  blockedSessionIDs: new Set(),
  streamingSessionIDs: new Set(),
  openGhosttyTerminals: [],
}

function deriveStatus(
  session: Session,
  live: LiveState,
  finishedAfterMs: number,
  now: number,
): DerivedStatus {
  const runStatus = live.sessionStatus[session.id]
  if (runStatus && runStatus.type !== "idle") return "in_progress"
  if (live.streamingSessionIDs.has(session.id)) return "in_progress"
  if (live.blockedSessionIDs.has(session.id)) return "blocked"
  if (finishedAfterMs > 0 && now - session.time.updated >= finishedAfterMs) return "finished"
  return "waiting_for_turn"
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>()
  const [sessions, setSessions] = useState<Session[]>([])
  const [trackedById, setTrackedById] = useState<Record<string, TrackedSession>>({})
  const [live, setLive] = useState<LiveState>(EMPTY_LIVE)
  const [isLoading, setIsLoading] = useState(true)
  const lastStateUpdatedAt = useRef<number>(0)

  const { searchText, setSearchText, filteredSessions, isIndexing } = useSessionSearch(sessions)

  async function loadSessions(opts: { silent?: boolean } = {}) {
    if (!opts.silent) setIsLoading(true)
    try {
      const client = await getClient()
      const sessionList = await client.listAllSessions()
      setSessions(sessionList.sort((a, b) => b.time.updated - a.time.updated))
    } catch (error) {
      if (!opts.silent) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to load sessions",
          message: error instanceof Error ? error.message : "Unknown error",
        })
      }
    } finally {
      if (!opts.silent) setIsLoading(false)
    }
  }

  async function refreshTracked() {
    const state = await readSessionState()
    if (state.updatedAt === lastStateUpdatedAt.current) return
    lastStateUpdatedAt.current = state.updatedAt
    setTrackedById(state.sessions)
  }

  const lastLoadedSessionsRef = useRef<Session[]>([])
  useEffect(() => {
    lastLoadedSessionsRef.current = sessions
  }, [sessions])

  async function refreshLive() {
    try {
      const client = await getClient()
      const [sessionStatus, permissions, questions, openGhosttyTerminals] = await Promise.all([
        client.getSessionStatusMap().catch(() => ({}) as Record<string, SessionRunStatus>),
        client.listPermissions(),
        client.listQuestions(),
        listGhosttyTerminals(),
      ])

      const blockedSessionIDs = new Set<string>()
      for (const p of permissions) blockedSessionIDs.add(p.sessionID)
      for (const q of questions) blockedSessionIDs.add(q.sessionID)

      // The serving opencode process only knows about its own in-memory busy
      // state. Sessions driven by a different opencode instance (e.g. an
      // `opencode --continue` CLI in a terminal) look idle via /session/status.
      // Probe recently-active sessions for a trailing assistant message
      // whose time.completed is null — that's an active stream.
      const now = Date.now()
      const recencyThresholdMs = 5 * 60 * 1000
      const toProbe = lastLoadedSessionsRef.current
        .filter((s) => now - s.time.updated < recencyThresholdMs)
        .slice(0, 20)

      const streamingSessionIDs = new Set<string>()
      await Promise.all(
        toProbe.map(async (s) => {
          try {
            const msgs = await client.getSessionMessages(s.id, 3, null)
            const last = msgs[msgs.length - 1]
            if (!last) return
            const role = last.info.role
            const completed = (last.info as { time?: { completed?: number | null } }).time?.completed
            if (role === "assistant" && (completed === null || completed === undefined)) {
              streamingSessionIDs.add(s.id)
            }
          } catch {
            /* best effort */
          }
        }),
      )

      setLive({ sessionStatus, blockedSessionIDs, streamingSessionIDs, openGhosttyTerminals })
    } catch {
      /* best effort */
    }
  }

  useEffect(() => {
    loadSessions()
    void refreshTracked()
  }, [])

  useEffect(() => {
    void refreshLive()
    const liveId = setInterval(() => {
      void refreshTracked()
      void refreshLive()
    }, POLL_MS)
    // Reload the session list in the background on a slower cadence so
    // newly-created sessions (including ones in sandboxes that were
    // registered after the command opened) appear without requiring a
    // manual Cmd+R refresh.
    const listId = setInterval(() => {
      void loadSessions({ silent: true })
    }, LIST_RELOAD_MS)
    return () => {
      clearInterval(liveId)
      clearInterval(listId)
    }
  }, [])

  async function handleDelete(session: Session) {
    const confirmed = await confirmAlert({
      title: "Delete Session?",
      message: `This will permanently delete "${session.title}"`,
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    })
    if (!confirmed) return
    try {
      const client = await getClient()
      await client.deleteSession(session.id)
      setSessions((prev) => prev.filter((s) => s.id !== session.id))
      await showToast({ style: Toast.Style.Success, title: "Session deleted" })
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to delete session",
        message: error instanceof Error ? error.message : "Unknown error",
      })
    }
  }

  async function handleFocusGhostty(session: Session, tracked: TrackedSession | undefined, liveTerminalId?: string) {
    const title = tracked?.generatedTitle ?? session.title
    const correlation = liveTerminalId
      ? { terminalId: liveTerminalId, correlatedAt: Date.now() }
      : (tracked?.ghostty ?? null)
    const ok = await focusGhosttyWindow(correlation, title)
    if (ok) {
      await showHUD("Focused Ghostty window")
      return
    }
    await showToast({
      style: Toast.Style.Animated,
      title: "Ghostty window not found",
      message: "Opening a new Ghostty window for this session",
    })
    await handoffToOpenCode(session.id, "terminal", session.directory, "ghostty")
  }

  async function handleHandoff(session: Session) {
    await handoffToOpenCode(session.id, preferences.handoffMethod, session.directory, preferences.terminalApp)
  }

  async function handleCopyCommand(session: Session) {
    await copySessionCommand(session.id, session.directory)
  }

  function formatDate(timestamp: number): string {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)
    if (diffMins < 1) return "Just now"
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  const finishedAfterMs = useMemo(() => parseHours(preferences.finishedAfterHours) * 3_600_000, [preferences.finishedAfterHours])

  const liveCorrelation = useMemo(
    () =>
      correlateSessions(
        sessions.map((s) => ({ id: s.id, title: s.title, directory: s.directory })),
        live.openGhosttyTerminals,
      ),
    [sessions, live.openGhosttyTerminals],
  )

  const openTerminalIds = useMemo(
    () => new Set(live.openGhosttyTerminals.map((t) => t.terminalId)),
    [live.openGhosttyTerminals],
  )

  const rows = useMemo(() => {
    const now = Date.now()
    return filteredSessions.map((session) => ({
      session,
      tracked: trackedById[session.id],
      status: deriveStatus(session, live, finishedAfterMs, now),
    }))
  }, [filteredSessions, trackedById, live, finishedAfterMs])

  const navTitle = searchText
    ? `${rows.length} of ${sessions.length}`
    : `${sessions.length} sessions`

  return (
    <List
      isLoading={isLoading || isIndexing}
      searchBarPlaceholder="Search sessions..."
      navigationTitle={navTitle}
      filtering={false}
      onSearchTextChange={setSearchText}
      searchText={searchText}
    >
      {rows.length === 0 && !isLoading ? (
        <List.EmptyView
          title={searchText ? "No matching sessions" : "No sessions yet"}
          description={searchText ? "Try a different search term" : "Start a conversation with Ask OpenCode"}
          icon={Icon.Message}
        />
      ) : (
        rows.map(({ session, tracked, status }) => {
          const meta = STATUS_META[status]
          const title = session.title || tracked?.originalTitle || "Untitled Session"
          const description = tracked?.description?.trim() ?? ""
          const directory = session.directory?.replace(homedir(), "~") ?? ""
          const subtitle = description || directory
          const icon = meta.icon
          const liveTerminalId = liveCorrelation.get(session.id)
          const sidecarTerminalId = tracked?.ghostty?.terminalId
          const openTerminalId = liveTerminalId ?? (sidecarTerminalId && openTerminalIds.has(sidecarTerminalId) ? sidecarTerminalId : undefined)
          const hasOpenTerminal = Boolean(openTerminalId)
          const accessories: List.Item.Accessory[] = []
          // When we have a description, surface the directory as an accessory
          // so both are visible simultaneously.
          if (description && directory) {
            accessories.push({ text: directory, tooltip: "Working directory" })
          }
          if (hasOpenTerminal) {
            accessories.push({
              icon: { source: Icon.Terminal, tintColor: Color.Blue },
              tooltip: "Open in a Ghostty window",
            })
          }
          accessories.push({ tag: { value: meta.label, color: meta.icon.tintColor }, tooltip: "Session status" })
          accessories.push({ text: formatDate(session.time.updated), tooltip: "Last updated" })
          if (session.share) accessories.push({ icon: Icon.Link, tooltip: "Shared" })

          return (
            <List.Item
              key={session.id}
              title={title}
              subtitle={subtitle}
              icon={icon}
              accessories={accessories}
              actions={
                <ActionPanel>
                  <ActionPanel.Section title="Open">
                    <Action
                      title="Focus Ghostty Window"
                      icon={Icon.Window}
                      onAction={() => handleFocusGhostty(session, tracked, openTerminalId)}
                    />
                    <Action
                      title="Continue in Terminal"
                      icon={Icon.Terminal}
                      shortcut={Keyboard.Shortcut.Common.Open}
                      onAction={() => handleHandoff(session)}
                    />
                    <Action
                      title="Copy Session Command"
                      icon={Icon.Clipboard}
                      shortcut={Keyboard.Shortcut.Common.Copy}
                      onAction={() => handleCopyCommand(session)}
                    />
                  </ActionPanel.Section>
                  <ActionPanel.Section title="Manage">
                    <Action
                      title="Refresh"
                      icon={Icon.ArrowClockwise}
                      shortcut={Keyboard.Shortcut.Common.Refresh}
                      onAction={() => {
                        void loadSessions()
                        void refreshTracked()
                        void refreshLive()
                      }}
                    />
                    <Action
                      title="Reset Server Cache"
                      icon={Icon.Plug}
                      onAction={async () => {
                        await clearCachedServer()
                        resetClient()
                        await showToast({ style: Toast.Style.Success, title: "Server cache cleared" })
                        void loadSessions()
                      }}
                    />
                    <Action
                      title="Delete Session"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={Keyboard.Shortcut.Common.Remove}
                      onAction={() => handleDelete(session)}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          )
        })
      )}
    </List>
  )
}
