import { exec } from "child_process"
import { promisify } from "util"
import type { GhosttyCorrelation } from "./session-state"

const execAsync = promisify(exec)

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

async function runOsascript(script: string): Promise<string> {
  const { stdout } = await execAsync(`osascript -e ${shellEscape(script)}`, {
    timeout: 5_000,
    maxBuffer: 1_000_000,
  })
  return stdout
}

function escapeAppleString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export async function focusGhosttyByTerminalId(terminalId: string): Promise<boolean> {
  const script = `tell application "Ghostty"
  activate
  try
    set target to (first terminal whose id is "${escapeAppleString(terminalId)}")
    focus target
    return "ok"
  on error
    return "missing"
  end try
end tell`
  try {
    const out = (await runOsascript(script)).trim()
    return out === "ok"
  } catch {
    return false
  }
}

export async function focusGhosttyByTitleFragment(fragment: string): Promise<boolean> {
  const escaped = escapeAppleString(fragment)
  const script = `tell application "Ghostty"
  activate
  try
    set matches to (every terminal whose name contains "${escaped}")
    if (count of matches) > 0 then
      focus (item 1 of matches)
      return "ok"
    end if
    return "missing"
  on error
    return "missing"
  end try
end tell`
  try {
    const out = (await runOsascript(script)).trim()
    return out === "ok"
  } catch {
    return false
  }
}

const DELIM = "§"
const ROW_DELIM = "¤"
const TITLE_PREFIX = "OC | "

const LIST_TERMINALS_SCRIPT = `tell application "Ghostty"
  set out to ""
  repeat with t in terminals
    try
      set tid to id of t
    on error
      set tid to ""
    end try
    try
      set tname to name of t
    on error
      set tname to ""
    end try
    try
      set tdir to working directory of t
    on error
      set tdir to ""
    end try
    set out to out & tid & "${DELIM}" & tname & "${DELIM}" & tdir & "${ROW_DELIM}"
  end repeat
  return out
end tell`

export interface GhosttyTerminal {
  terminalId: string
  name: string
  workingDirectory: string
}

export async function listGhosttyTerminals(): Promise<GhosttyTerminal[]> {
  try {
    const raw = await runOsascript(LIST_TERMINALS_SCRIPT)
    return raw
      .split(ROW_DELIM)
      .map((row) => row.trim())
      .filter((row) => row.length > 0)
      .map((row) => {
        const cols = row.split(DELIM)
        return {
          terminalId: (cols[0] ?? "").trim(),
          name: (cols[1] ?? "").trim(),
          workingDirectory: (cols[2] ?? "").trim(),
        }
      })
      .filter((t) => t.terminalId.length > 0)
  } catch {
    return []
  }
}

function stripPrefix(name: string): string {
  return name.startsWith(TITLE_PREFIX) ? name.slice(TITLE_PREFIX.length) : name
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/…$/u, "")
    .replace(/\.{3}$/u, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function titleMatches(terminalName: string, sessionTitle: string): boolean {
  const tn = normalise(stripPrefix(terminalName))
  const st = normalise(sessionTitle)
  if (!tn || !st) return false
  if (tn === st) return true
  const short = tn.length < st.length ? tn : st
  const long = tn.length < st.length ? st : tn
  return short.length >= 8 && long.startsWith(short)
}

/**
 * Map sessionID -> terminalId for every open Ghostty terminal that appears
 * to belong to an opencode session. Matches the "OC | <title>" naming
 * convention against each session title and optionally its working directory.
 */
export function correlateSessions(
  sessions: Array<{ id: string; title: string; directory: string }>,
  terminals: GhosttyTerminal[],
): Map<string, string> {
  const out = new Map<string, string>()
  if (terminals.length === 0 || sessions.length === 0) return out

  const prefixed = terminals.filter((t) => t.name.startsWith(TITLE_PREFIX))
  for (const s of sessions) {
    const title = s.title ?? ""
    if (!title) continue

    const byTitleAndDir = prefixed.find(
      (t) => titleMatches(t.name, title) && t.workingDirectory === s.directory,
    )
    if (byTitleAndDir) {
      out.set(s.id, byTitleAndDir.terminalId)
      continue
    }
    const byTitle = prefixed.find((t) => titleMatches(t.name, title))
    if (byTitle) out.set(s.id, byTitle.terminalId)
  }
  return out
}

export async function focusGhosttyWindow(
  correlation: GhosttyCorrelation | null,
  sessionTitle: string,
): Promise<boolean> {
  if (correlation?.terminalId) {
    const ok = await focusGhosttyByTerminalId(correlation.terminalId)
    if (ok) return true
  }
  if (sessionTitle && sessionTitle.length >= 6) {
    const ok = await focusGhosttyByTitleFragment(sessionTitle.slice(0, 30))
    if (ok) return true
  }
  return false
}
