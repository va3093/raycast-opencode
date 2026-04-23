import { spawn, exec } from "child_process"
import { promisify } from "util"
import { LocalStorage } from "@raycast/api"
import { existsSync } from "fs"
import { homedir } from "os"
import path from "path"

const execAsync = promisify(exec)

const STORAGE_KEY_PORT = "opencode-server-port"
const DEFAULT_PORT = 4096
const PORT_RANGE_START = 19000
const PORT_RANGE_END = 19999

export interface ServerInfo {
  url: string
  port: number
  version?: string
  authHeader?: string
}

export function buildAuthHeader(username?: string, password?: string): string | undefined {
  if (!username && !password) return undefined
  const token = Buffer.from(`${username ?? ""}:${password ?? ""}`, "utf8").toString("base64")
  return `Basic ${token}`
}

/**
 * Check if a server is healthy at the given URL.
 * Treats HTTP 401 as "healthy but needs auth" so we don't abandon a user-configured server.
 */
async function isServerHealthy(
  baseUrl: string,
  authHeader?: string,
): Promise<{ healthy: boolean; version?: string }> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)

    const response = await fetch(`${baseUrl}/global/health`, {
      signal: controller.signal,
      headers: authHeader ? { Authorization: authHeader } : undefined,
    })
    clearTimeout(timeout)

    if (response.ok) {
      const data = (await response.json()) as { healthy: boolean; version: string }
      return { healthy: true, version: data.version }
    }
    // Reachable but unauthorized still counts as a reachable server; the
    // caller can surface the auth error later.
    if (response.status === 401 || response.status === 403) {
      return { healthy: true }
    }
    return { healthy: false }
  } catch {
    return { healthy: false }
  }
}

/**
 * Find an available port in the specified range
 */
async function findAvailablePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    const inUse = await isServerHealthy(`http://localhost:${port}`, undefined)
    if (!inUse.healthy) {
      return port
    }
  }
  throw new Error(`No available ports in range ${start}-${end}`)
}

/**
 * Find the opencode binary on the system
 */
async function findOpencodeBinary(): Promise<string | null> {
  const home = homedir()
  const possiblePaths = [
    "/usr/local/bin/opencode",
    "/opt/homebrew/bin/opencode",
    path.join(home, ".local/bin/opencode"),
    path.join(home, ".bun/bin/opencode"),
    path.join(home, "bin/opencode"),
    path.join(home, ".opencode/bin/opencode"),
  ]

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p
    }
  }

  // Try PATH
  try {
    const { stdout } = await execAsync("which opencode")
    const binPath = stdout.trim()
    if (binPath && existsSync(binPath)) {
      return binPath
    }
  } catch {
    // Not in PATH
  }

  return null
}

/**
 * Start the OpenCode server on a given port
 */
async function startServer(opencodePath: string, port: number): Promise<void> {
  const serverProcess = spawn(opencodePath, ["serve", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  })
  serverProcess.unref()

  // Wait for server to be ready (up to 10 seconds)
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const { healthy } = await isServerHealthy(`http://localhost:${port}`)
    if (healthy) {
      return
    }
  }

  throw new Error("Server failed to start within 10 seconds")
}

export interface EnsureServerOptions {
  autoStart?: boolean
  explicitUrl?: string
  authHeader?: string
}

function portFromUrl(url: string): number {
  try {
    const u = new URL(url)
    if (u.port) return Number(u.port)
    return u.protocol === "https:" ? 443 : 80
  } catch {
    return 0
  }
}

/**
 * Ensure OpenCode server is running, starting it if necessary.
 * If explicitUrl is provided, we use it verbatim (with optional auth) and do not probe alternatives.
 */
export async function ensureServer(opts: EnsureServerOptions = {}): Promise<ServerInfo> {
  const { autoStart = true, explicitUrl, authHeader } = opts

  if (explicitUrl) {
    const trimmed = explicitUrl.replace(/\/+$/, "")
    const result = await isServerHealthy(trimmed, authHeader)
    if (!result.healthy) throw new ServerNotRunningError()
    return { url: trimmed, port: portFromUrl(trimmed), version: result.version, authHeader }
  }

  // 1. Check if we have a stored port from a previous session
  const storedPort = await LocalStorage.getItem<number>(STORAGE_KEY_PORT)
  if (storedPort) {
    const result = await isServerHealthy(`http://localhost:${storedPort}`, authHeader)
    if (result.healthy) {
      return {
        url: `http://localhost:${storedPort}`,
        port: storedPort,
        version: result.version,
        authHeader,
      }
    }
  }

  // 2. Check default port (in case user started server manually)
  const defaultResult = await isServerHealthy(`http://localhost:${DEFAULT_PORT}`, authHeader)
  if (defaultResult.healthy) {
    await LocalStorage.setItem(STORAGE_KEY_PORT, DEFAULT_PORT)
    return {
      url: `http://localhost:${DEFAULT_PORT}`,
      port: DEFAULT_PORT,
      version: defaultResult.version,
      authHeader,
    }
  }

  // 3. If auto-start is disabled, throw error
  if (!autoStart) {
    throw new ServerNotRunningError()
  }

  // 4. Find OpenCode binary
  const opencodePath = await findOpencodeBinary()
  if (!opencodePath) {
    throw new OpenCodeNotInstalledError()
  }

  // 5. Start our own server on a random port
  const port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END)
  await startServer(opencodePath, port)

  // 6. Store the port for future use
  await LocalStorage.setItem(STORAGE_KEY_PORT, port)

  const result = await isServerHealthy(`http://localhost:${port}`, authHeader)
  return {
    url: `http://localhost:${port}`,
    port,
    version: result.version,
    authHeader,
  }
}

/**
 * Get the current server URL without starting a new server
 */
export async function getServerUrl(): Promise<string | null> {
  const storedPort = await LocalStorage.getItem<number>(STORAGE_KEY_PORT)
  if (storedPort) {
    const result = await isServerHealthy(`http://localhost:${storedPort}`)
    if (result.healthy) {
      return `http://localhost:${storedPort}`
    }
  }

  const defaultResult = await isServerHealthy(`http://localhost:${DEFAULT_PORT}`)
  if (defaultResult.healthy) {
    return `http://localhost:${DEFAULT_PORT}`
  }

  return null
}

// Custom error classes
export class ServerNotRunningError extends Error {
  constructor() {
    super("OpenCode server is not running")
    this.name = "ServerNotRunningError"
  }
}

export class OpenCodeNotInstalledError extends Error {
  constructor() {
    super("OpenCode is not installed. Install with: curl -fsSL https://opencode.ai/install | bash")
    this.name = "OpenCodeNotInstalledError"
  }
}
