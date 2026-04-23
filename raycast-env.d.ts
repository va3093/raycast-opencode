/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Default Project - Default working directory for OpenCode */
  "defaultProject"?: string,
  /** Handoff Method - How to open full sessions */
  "handoffMethod": "terminal" | "desktop",
  /** Server URL - Explicit OpenCode server base URL, e.g. http://localhost:8765. Leave blank to auto-discover. */
  "serverUrl": string,
  /** Server Username - HTTP Basic auth username for the OpenCode server (optional). */
  "serverUsername": string,
  /** Server Password - HTTP Basic auth password for the OpenCode server (optional). */
  "serverPassword": string,
  /** Auto-start Server - Automatically start OpenCode server if no configured server and no default port server is reachable. */
  "autoStartServer": boolean,
  /** Mark Finished After (hours) - Idle sessions older than this many hours are shown as Finished instead of Waiting for input. Set to 0 to disable. */
  "finishedAfterHours": string,
  /** Terminal Application - Which terminal to use when opening sessions */
  "terminalApp": "default" | "ghostty" | "iterm" | "warp" | "alacritty" | "kitty" | "terminal" | "hyper"
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `ask` command */
  export type Ask = ExtensionPreferences & {}
  /** Preferences accessible in the `sessions` command */
  export type Sessions = ExtensionPreferences & {}
  /** Preferences accessible in the `projects` command */
  export type Projects = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `ask` command */
  export type Ask = {
  /** What do you want to know? */
  "question": string
}
  /** Arguments passed to the `sessions` command */
  export type Sessions = {}
  /** Arguments passed to the `projects` command */
  export type Projects = {}
}

