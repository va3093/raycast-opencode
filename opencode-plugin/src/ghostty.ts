import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

export interface GhosttyTerminal {
  terminalId: string
  name: string
  workingDirectory: string
}

const DELIM = "§"
const ROW_DELIM = "¤"
const TITLE_PREFIX = "OC | "

const LIST_SCRIPT = `tell application "Ghostty"
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
    set out to out & tid & "${DELIM}" & tname & "${DELIM}" & tdir & "${ROW_DELIM}"
  end repeat
  return out
end tell`

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

function parseTerminals(raw: string): GhosttyTerminal[] {
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
}

export async function listGhosttyTerminals(): Promise<GhosttyTerminal[]> {
  try {
    return parseTerminals(await runOsascript(LIST_SCRIPT))
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

export async function correlateGhostty(opts: CorrelationOptions): Promise<GhosttyTerminal | null> {
  const terms = await listGhosttyTerminals()
  if (terms.length === 0) return null

  const prefixed = terms.filter((t) => t.name.startsWith(TITLE_PREFIX))

  const byTitleAndDir = prefixed.filter(
    (t) => titleMatches(t.name, opts.title) && t.workingDirectory === opts.directory
  )
  if (byTitleAndDir.length >= 1) return byTitleAndDir[0]

  const byTitle = prefixed.filter((t) => titleMatches(t.name, opts.title))
  if (byTitle.length === 1) return byTitle[0]

  const byDir = prefixed.filter((t) => t.workingDirectory === opts.directory)
  if (byDir.length === 1) return byDir[0]

  return null
}
