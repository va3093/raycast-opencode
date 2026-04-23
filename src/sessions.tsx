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
import { getClient, Session, type SessionRunStatus } from "./lib/opencode"
import { handoffToOpenCode, copySessionCommand } from "./lib/handoff"
import { useSessionSearch } from "./hooks/useSessionSearch"
import { homedir } from "os"
import { readSessionState, type TrackedSession } from "./lib/session-state"
import { focusGhosttyWindow } from "./lib/ghostty"

import { TerminalApp } from "./lib/handoff"

interface Preferences {
  handoffMethod: "terminal" | "desktop"
  terminalApp: TerminalApp
}

type DerivedStatus = "in_progress" | "waiting_for_input" | "finished"

const POLL_MS = 1_500

const STATUS_META: Record<DerivedStatus, { prefix: string; icon: { source: Icon; tintColor: Color }; label: string }> = {
  in_progress: {
    prefix: "🟢 ",
    icon: { source: Icon.CircleFilled, tintColor: Color.Green },
    label: "In progress",
  },
  waiting_for_input: {
    prefix: "🟡 ",
    icon: { source: Icon.CircleFilled, tintColor: Color.Yellow },
    label: "Waiting for input",
  },
  finished: {
    prefix: "⚪ ",
    icon: { source: Icon.CircleFilled, tintColor: Color.SecondaryText },
    label: "Finished",
  },
}

interface LiveState {
  sessionStatus: Record<string, SessionRunStatus>
  blockedSessionIDs: Set<string>
  lastAssistantMsgIDBySession: Map<string, string | null>
  lastRealRoleBySession: Map<string, "user" | "assistant" | null>
}

const EMPTY_LIVE: LiveState = {
  sessionStatus: {},
  blockedSessionIDs: new Set(),
  lastAssistantMsgIDBySession: new Map(),
  lastRealRoleBySession: new Map(),
}

function deriveStatus(sessionID: string, live: LiveState): DerivedStatus {
  const runStatus = live.sessionStatus[sessionID]
  if (runStatus && runStatus.type !== "idle") return "in_progress"
  if (live.blockedSessionIDs.has(sessionID)) return "waiting_for_input"
  if (live.lastRealRoleBySession.get(sessionID) === "assistant") return "waiting_for_input"
  return "finished"
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>()
  const [sessions, setSessions] = useState<Session[]>([])
  const [trackedById, setTrackedById] = useState<Record<string, TrackedSession>>({})
  const [live, setLive] = useState<LiveState>(EMPTY_LIVE)
  const [isLoading, setIsLoading] = useState(true)
  const lastStateUpdatedAt = useRef<number>(0)

  const { searchText, setSearchText, filteredSessions, isIndexing } = useSessionSearch(sessions)

  async function loadSessions() {
    setIsLoading(true)
    try {
      const client = await getClient()
      const sessionList = await client.listSessions()
      setSessions(sessionList.sort((a, b) => b.time.updated - a.time.updated))
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to load sessions",
        message: error instanceof Error ? error.message : "Unknown error",
      })
    } finally {
      setIsLoading(false)
    }
  }

  async function refreshTracked() {
    const state = await readSessionState()
    if (state.updatedAt === lastStateUpdatedAt.current) return
    lastStateUpdatedAt.current = state.updatedAt
    setTrackedById(state.sessions)
  }

  async function refreshLive(candidateSessions: Session[]) {
    try {
      const client = await getClient()
      const [sessionStatus, permissions, questions] = await Promise.all([
        client.getSessionStatusMap().catch(() => ({}) as Record<string, SessionRunStatus>),
        client.listPermissions(),
        client.listQuestions(),
      ])

      const blockedSessionIDs = new Set<string>()
      for (const p of permissions) blockedSessionIDs.add(p.sessionID)
      for (const q of questions) blockedSessionIDs.add(q.sessionID)

      // Only look up recent messages for sessions that aren't busy — we only
      // need the last-role signal to distinguish waiting_for_input vs finished.
      const lastRealRoleBySession = new Map<string, "user" | "assistant" | null>()
      const lastAssistantMsgIDBySession = new Map<string, string | null>()
      const needLastRole = candidateSessions
        .filter((s) => {
          const st = sessionStatus[s.id]
          return (!st || st.type === "idle") && !blockedSessionIDs.has(s.id)
        })
        .slice(0, 20) // cap work per poll; the rest will be refreshed on later polls

      await Promise.all(
        needLastRole.map(async (s) => {
          try {
            const msgs = await client.getSessionMessages(s.id, 10)
            let lastRole: "user" | "assistant" | null = null
            let lastAssistantId: string | null = null
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i]
              const hasText = (m.parts ?? []).some((p) => p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0)
              if (hasText && lastRole === null) lastRole = m.info.role
              if (m.info.role === "assistant" && lastAssistantId === null) lastAssistantId = m.info.id
              if (lastRole && lastAssistantId) break
            }
            lastRealRoleBySession.set(s.id, lastRole)
            lastAssistantMsgIDBySession.set(s.id, lastAssistantId)
          } catch {
            lastRealRoleBySession.set(s.id, null)
          }
        })
      )

      setLive({ sessionStatus, blockedSessionIDs, lastAssistantMsgIDBySession, lastRealRoleBySession })
    } catch {
      /* best effort */
    }
  }

  useEffect(() => {
    loadSessions()
    void refreshTracked()
  }, [])

  useEffect(() => {
    if (sessions.length === 0) return
    void refreshLive(sessions)
    const id = setInterval(() => {
      void refreshTracked()
      void refreshLive(sessions)
    }, POLL_MS)
    return () => clearInterval(id)
  }, [sessions])

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

  async function handleFocusGhostty(session: Session, tracked: TrackedSession | undefined) {
    const title = tracked?.generatedTitle ?? session.title
    const ok = await focusGhosttyWindow(tracked?.ghostty ?? null, title)
    if (ok) {
      await showHUD("Focused Ghostty window")
      return
    }
    await showToast({
      style: Toast.Style.Animated,
      title: "Ghostty window not found",
      message: "Falling back to opening a new session",
    })
    await handoffToOpenCode(session.id, preferences.handoffMethod, session.directory, preferences.terminalApp)
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

  const rows = useMemo(() => {
    return filteredSessions.map((session) => ({
      session,
      tracked: trackedById[session.id],
      status: deriveStatus(session.id, live),
    }))
  }, [filteredSessions, trackedById, live])

  return (
    <List
      isLoading={isLoading || isIndexing}
      searchBarPlaceholder="Search sessions..."
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
          const title = meta.prefix + (session.title || tracked?.originalTitle || "Untitled Session")
          const subtitle = tracked?.description?.trim() || session.directory?.replace(homedir(), "~") || ""
          const icon = meta.icon
          const accessories: List.Item.Accessory[] = [
            { tag: { value: meta.label, color: meta.icon.tintColor }, tooltip: "Session status" },
            { text: formatDate(session.time.updated), tooltip: "Last updated" },
          ]
          if (tracked?.ghostty?.terminalId) {
            accessories.push({ icon: Icon.Window, tooltip: `Ghostty terminal ${tracked.ghostty.terminalId.slice(0, 8)}` })
          }
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
                      onAction={() => handleFocusGhostty(session, tracked)}
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
                        void refreshLive(sessions)
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
