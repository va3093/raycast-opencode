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
