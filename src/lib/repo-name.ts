import { exec } from "child_process"
import { promisify } from "util"
import { homedir } from "os"
import path from "path"

const execAsync = promisify(exec)

const cache = new Map<string, string>()

/**
 * Resolve a session directory to a short human-friendly repo label.
 * Runs `git -C <dir> rev-parse --show-toplevel`; returns the basename
 * of the toplevel on success. Falls back to the homedir-tilde-reduced
 * path if git fails (non-repo, missing dir, etc). Results are memoised
 * per directory for the session.
 */
export async function getRepoName(directory: string): Promise<string> {
  if (!directory) return ""
  const cached = cache.get(directory)
  if (cached !== undefined) return cached

  const fallback = directory.replace(homedir(), "~")
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", {
      cwd: directory,
      timeout: 1500,
    })
    const toplevel = stdout.trim()
    if (!toplevel) {
      cache.set(directory, fallback)
      return fallback
    }
    const name = path.basename(toplevel)
    cache.set(directory, name)
    return name
  } catch {
    cache.set(directory, fallback)
    return fallback
  }
}

/** Synchronously read a cached value. Returns the fallback path until
 * the async resolver finishes and populates the cache. */
export function getCachedRepoName(directory: string): string {
  if (!directory) return ""
  const cached = cache.get(directory)
  if (cached !== undefined) return cached
  return directory.replace(homedir(), "~")
}
