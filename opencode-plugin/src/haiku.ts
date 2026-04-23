import Anthropic from "@anthropic-ai/sdk"

const DEFAULT_MODEL = process.env.OPENCODE_RAYCAST_HAIKU_MODEL ?? "claude-haiku-4-5"

let clientCache: Anthropic | null = null

function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  if (!clientCache) clientCache = new Anthropic({ apiKey: key })
  return clientCache
}

export interface RenameResult {
  title: string
  description: string
}

export interface SummaryResult {
  description: string
}

type AnthropicTool = Anthropic.Messages.Tool

const RENAME_TOOL: AnthropicTool = {
  name: "write_session_rename",
  description: "Produce a concise title and short description for the current opencode session.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "A very short human-friendly title, max 6 words, no quotes, no trailing punctuation.",
      },
      description: {
        type: "string",
        description: "One sentence describing what the session is about. Max 140 characters.",
      },
    },
    required: ["title", "description"],
  },
}

const SUMMARY_TOOL: AnthropicTool = {
  name: "write_session_summary",
  description: "Produce a short summary of the current state of the opencode session.",
  input_schema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description:
          "2-3 sentences capturing the current state, what was done, and any next steps or blockers. Max 320 characters.",
      },
    },
    required: ["description"],
  },
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1).trimEnd() + "…"
}

async function toolCall<T>(prompt: string, system: string, tool: AnthropicTool): Promise<T | null> {
  const client = getClient()
  if (!client) return null

  const response = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 300,
    system,
    messages: [{ role: "user", content: prompt }],
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
  })

  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === tool.name) {
      return block.input as T
    }
  }
  return null
}

export async function renameSession(
  userPrompts: string,
  currentTitle?: string
): Promise<RenameResult | null> {
  const titleHint = currentTitle
    ? `\n\nThe current title is "${currentTitle}". Keep it unchanged if it still fits the session's overall intent; only change the title if the user's goals have meaningfully shifted.`
    : ""
  const result = await toolCall<RenameResult>(
    `Below is the ordered list of every user prompt in an opencode coding-assistant session, numbered in chronological order. The first prompts usually state the core intent; later prompts are follow-ups, clarifications, or pivots.

Pick a title that captures what the *overall session* is about, weighting the earliest prompts most heavily. Do NOT let the most recent prompt dominate — follow-up tweaks should not overwrite the core topic.${titleHint}

<user_prompts>
${userPrompts}
</user_prompts>`,
    "You name programming chat sessions. Titles must be short, specific and free of filler words like 'Help with' or 'How to'. Anchor on the session's overall intent, not the latest micro-task.",
    RENAME_TOOL
  )
  if (!result) return null
  return {
    title: truncate(result.title.trim().replace(/^["'`]+|["'`]+$/g, ""), 80),
    description: truncate(result.description.trim(), 180),
  }
}

export async function summariseSession(transcript: string): Promise<SummaryResult | null> {
  const result = await toolCall<SummaryResult>(
    `Below is the most recent activity of an opencode coding-assistant session. Summarise the current state.

<transcript>
${transcript}
</transcript>`,
    "You summarise programming chat sessions. Focus on what was just done and what remains. Avoid hedging and pleasantries.",
    SUMMARY_TOOL
  )
  if (!result) return null
  return { description: truncate(result.description.trim(), 400) }
}

export function isHaikuConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}
