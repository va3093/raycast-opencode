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
import { getClient, Session } from "./lib/opencode"
import { handoffToOpenCode, copySessionCommand } from "./lib/handoff"
import { useSessionSearch } from "./hooks/useSessionSearch"
import { homedir } from "os"
import { readSessionState, type TrackedSession, type SessionStatus } from "./lib/session-state"
import { focusGhosttyWindow } from "./lib/ghostty"

import { TerminalApp } from "./lib/handoff"

interface Preferences {
  handoffMethod: "terminal" | "desktop"
  terminalApp: TerminalApp
}

const STATE_POLL_INTERVAL_MS = 1_500

const STATUS_META: Record<SessionStatus, { prefix: string; icon: { source: Icon; tintColor: Color }; label: string }> =
  {
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

export default function Command() {
  const preferences = getPreferenceValues<Preferences>()
  const [sessions, setSessions] = useState<Session[]>([])
  const [trackedById, setTrackedById] = useState<Record<string, TrackedSession>>({})
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

  useEffect(() => {
    loadSessions()
    void refreshTracked()
  }, [])

  useEffect(() => {
    const id = setInterval(() => void refreshTracked(), STATE_POLL_INTERVAL_MS)
    return () => clearInterval(id)
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

  async function handleFocusGhostty(session: Session, tracked: TrackedSession | undefined) {
    const title = tracked?.title ?? session.title
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
    }))
  }, [filteredSessions, trackedById])

  return (
    <List
      isLoading={isLoading || isIndexing}
      searchBarPlaceholder="Search sessions..."
      filtering={false}
      onSearchTextChange={setSearchText}
      searchText={searchText}
      isShowingDetail={false}
    >
      {rows.length === 0 && !isLoading ? (
        <List.EmptyView
          title={searchText ? "No matching sessions" : "No sessions yet"}
          description={searchText ? "Try a different search term" : "Start a conversation with Ask OpenCode"}
          icon={Icon.Message}
        />
      ) : (
        rows.map(({ session, tracked }) => {
          const status = tracked?.status
          const meta = status ? STATUS_META[status] : null
          const title = (meta?.prefix ?? "") + (tracked?.title || session.title || "Untitled Session")
          const subtitle = tracked?.description?.trim() || session.directory?.replace(homedir(), "~") || ""
          const icon = meta?.icon ?? Icon.Message
          const accessories: List.Item.Accessory[] = []
          if (meta) {
            accessories.push({
              tag: { value: meta.label, color: meta.icon.tintColor },
              tooltip: "Session status",
            })
          }
          accessories.push({
            text: formatDate(session.time.updated),
            tooltip: "Last updated",
          })
          if (tracked?.ghostty?.terminalId) {
            accessories.push({
              icon: Icon.Window,
              tooltip: `Ghostty terminal ${tracked.ghostty.terminalId.slice(0, 8)}`,
            })
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
