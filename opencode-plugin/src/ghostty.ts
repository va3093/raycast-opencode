import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

export interface GhosttyTerminal {
  terminalId: string
  windowId: string | null
  name: string
  workingDirectory: string
}

const DELIM = "§"
const ROW_DELIM = "¤"
const TITLE_PREFIX = "OC | "

const LIST_SCRIPT = `tell application "Ghostty"
  set out to ""
  set winIds to {}
  set termList to every terminal
  repeat with t in termList
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
    try
      set wid to id of window of tab 1 whose focused terminal is t
    on error
      set wid to ""
    end try
    set out to out & tid & "${DELIM}" & tname & "${DELIM}" & tdir & "${DELIM}" & wid & "${ROW_DELIM}"
  end repeat
  return out
end tell`

const SIMPLE_LIST_SCRIPT = `tell application "Ghostty"
  set out to ""
  set termList to every terminal
  repeat with t in termList
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
    set out to out & tid & "${DELIM}" & tname & "${DELIM}" & tdir & "${DELIM}${ROW_DELIM}"
  end repeat
  return out
end tell`

const WINDOW_MAP_SCRIPT = `tell application "Ghostty"
  set out to ""
  repeat with w in windows
    try
      set wid to id of w
      set wname to name of w
      set out to out & wid & "${DELIM}" & wname & "${ROW_DELIM}"
    end try
  end repeat
  return out
end tell`

async function runOsascript(script: string): Promise<string> {
  const { stdout } = await execAsync(`osascript -e ${shellEscape(script)}`, {
    timeout: 5_000,
    maxBuffer: 1_000_000,
  })
  return stdout
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function parseSimpleTerminals(raw: string): GhosttyTerminal[] {
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
        windowId: null,
      }
    })
    .filter((t) => t.terminalId.length > 0)
}

function parseWindowMap(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  raw
    .split(ROW_DELIM)
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
    .forEach((row) => {
      const [wid, name] = row.split(DELIM)
      if (wid && name !== undefined) map.set(name.trim(), wid.trim())
    })
  return map
}

export async function listGhosttyTerminals(): Promise<GhosttyTerminal[]> {
  try {
    const raw = await runOsascript(SIMPLE_LIST_SCRIPT)
    const terms = parseSimpleTerminals(raw)
    if (terms.length === 0) return []

    try {
      const winRaw = await runOsascript(WINDOW_MAP_SCRIPT)
      const byName = parseWindowMap(winRaw)
      for (const t of terms) {
        const wid = byName.get(t.name)
        if (wid) t.windowId = wid
      }
    } catch {
      /* best-effort */
    }

    return terms
  } catch {
    return []
  }
}

export interface CorrelationOptions {
  sessionId: string
  title: string
  directory: string
}

function stripPrefix(name: string): string {
  return name.startsWith(TITLE_PREFIX) ? name.slice(TITLE_PREFIX.length) : name
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/…$/u, "").replace(/\.{3}$/u, "").replace(/[^a-z0-9]+/g, " ").trim()
}

function titleMatches(terminalName: string, sessionTitle: string): boolean {
  const tn = normalise(stripPrefix(terminalName))
  const st = normalise(sessionTitle)
  if (!tn || !st) return false
  if (tn === st) return true
  // Ghostty truncates long titles with "..." — allow prefix match in either direction
  const short = tn.length < st.length ? tn : st
  const long = tn.length < st.length ? st : tn
  return short.length >= 8 && long.startsWith(short)
}

export async function correlateGhostty(opts: CorrelationOptions): Promise<GhosttyTerminal | null> {
  const terms = await listGhosttyTerminals()
  if (terms.length === 0) return null

  const prefixed = terms.filter((t) => t.name.startsWith(TITLE_PREFIX))

  const byTitleAndDir = prefixed.filter(
    (t) => titleMatches(t.name, opts.title) && t.workingDirectory === opts.directory
  )
  if (byTitleAndDir.length === 1) return byTitleAndDir[0]
  if (byTitleAndDir.length > 1) return byTitleAndDir[0]

  const byTitle = prefixed.filter((t) => titleMatches(t.name, opts.title))
  if (byTitle.length === 1) return byTitle[0]

  const byDir = prefixed.filter((t) => t.workingDirectory === opts.directory)
  if (byDir.length === 1) return byDir[0]

  return null
}
