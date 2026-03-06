/**
 * opencode-self-compact
 *
 * Gives agents context window awareness and enriches compaction with
 * agent-provided state so they pick up where they left off.
 *
 * How it works:
 * 1. Every LLM call: count tokens in the message array, inject a small
 *    usage line into the system prompt so the agent always knows where it stands.
 * 2. At threshold (default 85% of usable limit): escalate the system prompt
 *    to tell the agent to finish its current step and call compact_checkpoint.
 * 3. compact_checkpoint tool: agent provides structured state (goal, progress,
 *    next steps, decisions). Plugin stores it and triggers compaction.
 * 4. experimental.session.compacting hook: injects the agent's state dump into
 *    the compaction prompt so the summary preserves what actually matters.
 * 5. session.compacted event: plugin resets and injects a one-shot "you just
 *    resumed from compaction" note so the agent can orient itself.
 *
 * The checkpoint is best-effort — if the agent ignores the nudge, compaction
 * still fires naturally (no worse than default behavior).
 *
 * Install:
 *   Add "opencode-self-compact" to the "plugin" array in opencode.json
 *
 * Config (optional, ~/.config/opencode/self-compact.json):
 *   {
 *     "threshold": 75,          // % of usable limit to trigger the soft nudge (default: 75)
 *     "hardStopThreshold": 98,  // % at which to hard-stop — just under OpenCode's overflow (default: 98)
 *     "showUsage": true,        // always show usage line in system prompt (default: true)
 *     "enabled": true           // disable entirely (default: true)
 *   }
 */

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import type { Event, Model } from "@opencode-ai/sdk"

// ─── Types ────────────────────────────────────────────────────────────────────

interface SelfCompactConfig {
  /** % of usable limit at which to nudge the agent (default: 75) */
  threshold: number
  /**
   * % at which to issue a hard-stop directive (default: 98).
   * Intentionally close to 100% — this is "just under OpenCode's overflow trigger".
   * OpenCode auto-compacts when count >= usable (i.e. ~100%). We fire at 98%
   * so the agent gets one last chance to checkpoint before overflow takes over.
   * Override lower if your sessions have large responses that cross 2% in one turn.
   */
  hardStopThreshold: number
  /** Always show the usage line in the system prompt (default: true) */
  showUsage: boolean
  /** Disable the plugin entirely (default: true = enabled) */
  enabled: boolean
}

interface CheckpointState {
  goal: string
  accomplished: string
  in_progress: string
  next_steps: string
  key_decisions?: string
  relevant_files?: string
}

// ─── Internal agent signatures (skip injecting into these) ───────────────────
// These are OpenCode's own sub-agents that shouldn't get context awareness noise.

const INTERNAL_AGENT_SIGNATURES = [
  "You are a title generator",
  "You are a helpful AI assistant tasked with summarizing conversations",
  "Generate a concise title",
  "summarize the conversation",
]

// ─── Config loading ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SelfCompactConfig = {
  threshold: 75,
  hardStopThreshold: 98,
  showUsage: true,
  enabled: true,
}

async function loadConfig(): Promise<SelfCompactConfig> {
  const configPath = path.join(os.homedir(), ".config", "opencode", "self-compact.json")
  try {
    const content = await fs.readFile(configPath, "utf8")
    return { ...DEFAULT_CONFIG, ...JSON.parse(content) }
  } catch {
    return DEFAULT_CONFIG
  }
}

// ─── Token counting (heuristic) ──────────────────────────────────────────────
// 4 chars ≈ 1 token. Good enough for threshold decisions — we're not billing.

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export const SelfCompact: Plugin = async ({ client }) => {
  const userConfig = await loadConfig()

  // Plugin-level state (per process lifetime — resets on OpenCode restart)
  let compactionReserved = 20_000       // from OpenCode's compaction.reserved config
  let contextLimit = 200_000            // raw model context window
  let usableLimit = 180_000             // contextLimit - max(reserved, maxOutputTokens)
  let currentTokens = 0                 // estimated tokens in current message array
  let currentPercent = 0                // % of usableLimit
  let pendingCheckpoint: CheckpointState | null = null  // set by compact_checkpoint tool
  let sessionID: string | null = null   // captured from system.transform
  let modelID: string | null = null     // for session.summarize()
  let providerID: string | null = null  // for session.summarize()
  let justCompacted = false             // set by session.compacted event
  let compactTriggered = false          // prevent double-triggering

  // Last known message snapshot — used by system.transform when messages.transform
  // fires after it (hook ordering is not guaranteed). Stored as total char count.
  let lastMessageChars = 0

  // ─── Compute usable limit from model info ──────────────────────────────────
  // Mirrors OpenCode's isOverflow logic exactly:
  //   reserved = config.compaction.reserved ?? min(20_000, maxOutputTokens)
  //   usable   = model.limit.input ? limit.input - reserved
  //                                : limit.context - maxOutputTokens
  // model.limit.input is the provider-reported input-only limit (some models
  // have separate input/output windows). Falls back to context - maxOutput.

  const OUTPUT_TOKEN_MAX = 32_000  // matches OpenCode's ProviderTransform

  function computeUsableLimit(model: Model): number {
    const maxOutputTokens = Math.min(model.limit.output ?? OUTPUT_TOKEN_MAX, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
    const reserved = compactionReserved !== 20_000
      ? compactionReserved  // user explicitly set it
      : Math.min(20_000, maxOutputTokens)
    const inputLimit = (model as any).limit?.input
    return inputLimit
      ? inputLimit - reserved
      : model.limit.context - maxOutputTokens
  }

  // ─── Hooks ────────────────────────────────────────────────────────────────

  return {
    // ── 1. Config hook — read OpenCode's compaction settings ────────────────
    config: async (opencodeConfig) => {
      if (!userConfig.enabled) return

      // Read OpenCode's reserved buffer so our thresholds track theirs
      compactionReserved = (opencodeConfig as any).compaction?.reserved ?? 20_000

      // Auto-allow compact_checkpoint — no permission prompt needed
      ;(opencodeConfig.permission as Record<string, string>) = {
        ...(opencodeConfig.permission as Record<string, string>),
        compact_checkpoint: "allow",
      }

      // Add to primary_tools so the LLM uses it proactively when nudged
      const existing = (opencodeConfig as any).experimental?.primary_tools ?? []
      ;(opencodeConfig as any).experimental = {
        ...(opencodeConfig as any).experimental,
        primary_tools: [...existing, "compact_checkpoint"],
      }
    },

    // ── 2. messages.transform — count tokens ────────────────────────────────
    // Runs before every LLM call. We walk the full message array and estimate
    // token count. No external tokenizer — heuristic is precise enough.
    // NOTE: hook ordering vs system.transform is not guaranteed. We store
    // the count in shared state and also in lastMessageChars so system.transform
    // can recompute if it fires first.
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!userConfig.enabled) return

      let totalChars = 0
      for (const msg of output.messages) {
        for (const part of msg.parts) {
          if ("text" in part && typeof part.text === "string") {
            totalChars += part.text.length
          } else {
            // tool calls, results, etc — stringify to estimate
            totalChars += JSON.stringify(part).length
          }
        }
      }

      lastMessageChars = totalChars
      currentTokens = estimateTokens(totalChars)
      currentPercent = usableLimit > 0
        ? Math.round((currentTokens / usableLimit) * 100)
        : 0

      // If we previously triggered a compact but it hasn't fired yet,
      // check if token count dropped significantly (compaction happened
      // without us catching the event — e.g., overflow path)
      if (compactTriggered && currentPercent < 50) {
        compactTriggered = false
        justCompacted = true
        pendingCheckpoint = null
      }
    },

    // ── 3. system.transform — inject awareness ──────────────────────────────
    // Runs before every LLM call. We:
    //   a) Capture sessionID and model info for later use
    //   b) Recompute token count from lastMessageChars (handles case where
    //      messages.transform fires after this hook due to ordering)
    //   c) Skip internal agents (title generator, compaction summarizer)
    //   d) Inject a usage line (always, if showUsage)
    //   e) Inject a nudge if at or above threshold
    //   f) Inject a post-compaction note (one-shot)
    "experimental.chat.system.transform": async (input, output) => {
      if (!userConfig.enabled) return

      // Capture model info for the summarize call
      if (input.sessionID) sessionID = input.sessionID
      if (input.model) {
        modelID = input.model.id
        providerID = input.model.providerID
        usableLimit = computeUsableLimit(input.model)
        contextLimit = input.model.limit.context
      }

      // Compute token estimate from last known message chars + current system text.
      // If messages.transform hasn't fired yet (first call or fires after this hook),
      // we still count the system prompt so the estimate is never zero.
      const systemChars = output.system.join("").length
      const totalChars = lastMessageChars + systemChars
      if (totalChars > 0 && usableLimit > 0) {
        currentTokens = estimateTokens(totalChars)
        currentPercent = Math.round((currentTokens / usableLimit) * 100)
      }

      // Skip internal agents
      const systemText = output.system.join(" ")
      if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) return

      // Post-compaction note (one-shot, injected once after compaction)
      if (justCompacted) {
        justCompacted = false
        compactTriggered = false
        output.system.push(
          `<context-note>Session was just compacted. You're continuing from a summary — review it above to orient yourself before proceeding.</context-note>`
        )
        return  // no need for usage line — fresh context
      }

      // Usage line (always shown if showUsage)
      if (userConfig.showUsage && usableLimit > 0) {
        output.system.push(
          `<context-usage percent="${currentPercent}" tokens="${currentTokens}" usable="${usableLimit}" context="${contextLimit}" />`
        )
      }

      // Threshold nudge — two levels
      if (!compactTriggered && currentPercent >= userConfig.threshold) {
        const hardStop = currentPercent >= (userConfig.hardStopThreshold ?? 88)

        if (hardStop) {
          // Hard stop — agent is dangerously close to overflow. Be unambiguous.
          output.system.push(
            `<context-awareness level="critical">` +
            `CRITICAL: Context is at ${currentPercent}% (${currentTokens.toLocaleString()} / ${usableLimit.toLocaleString()} usable tokens). ` +
            `You MUST call compact_checkpoint RIGHT NOW as your very next action — do NOT finish any current step first, do NOT make any other tool calls. ` +
            `If you do not call it immediately, compaction will fire without your state and you will lose context. ` +
            `Include: goal, accomplished, in_progress, next_steps, key_decisions, relevant_files.` +
            `</context-awareness>`
          )
        } else {
          // Soft nudge — agent has some runway, but should wrap up and checkpoint
          output.system.push(
            `<context-awareness level="warning">` +
            `Context is at ${currentPercent}% capacity (${currentTokens.toLocaleString()} / ${usableLimit.toLocaleString()} usable tokens). ` +
            `Call compact_checkpoint as your next action after completing the current response. ` +
            `Do not start new tasks or tool calls — save your state now. ` +
            `Include: what the user is trying to accomplish, what's done, what's in progress, what's next, and any key decisions made.` +
            `</context-awareness>`
          )
        }
      }
    },

    // ── 4. compact_checkpoint tool ──────────────────────────────────────────
    tool: {
      compact_checkpoint: tool({
        description:
          "Save your current progress and trigger a context compaction. " +
          "Call this when context usage is high (you'll see a context-awareness note) " +
          "to ensure a clean handoff to your future self. " +
          "The session will compact and you'll continue from this checkpoint.",
        args: {
          goal: tool.schema.string("What the user is trying to accomplish overall"),
          accomplished: tool.schema.string("What has been completed so far in this session"),
          in_progress: tool.schema.string("What was actively being worked on when you called this checkpoint"),
          next_steps: tool.schema.string("What needs to happen next, in order of priority"),
          key_decisions: tool.schema.string("Important decisions or discoveries made during this session").optional(),
          relevant_files: tool.schema.string("Files that were modified or are important to the current task").optional(),
        },
        async execute(args) {
          // Store the checkpoint
          pendingCheckpoint = {
            goal: args.goal,
            accomplished: args.accomplished,
            in_progress: args.in_progress,
            next_steps: args.next_steps,
            key_decisions: args.key_decisions,
            relevant_files: args.relevant_files,
          }
          compactTriggered = true

          // Trigger compaction via SDK — fire and forget (don't await).
          // The tool response is returned synchronously below; the summarize
          // call happens asynchronously in the background.
          if (sessionID && modelID && providerID) {
            void client.session.summarize({
              path: { id: sessionID },
              body: { providerID, modelID },
            }).catch(async (e) => {
              // Silent fail — auto-compaction will fire naturally anyway
              try {
                await client.app.log({
                  body: {
                    service: "self-compact",
                    level: "warn",
                    message: `Failed to trigger compaction: ${e}`,
                  },
                })
              } catch {}
            })
          }

          return (
            "Checkpoint saved. Compaction will begin shortly — " +
            "your state has been preserved and you'll pick up right here."
          )
        },
      }),
    },

    // ── 5. session.compacting hook — inject state dump ──────────────────────
    // Fires right before the compaction LLM call. If the agent called
    // compact_checkpoint, we inject their structured state so the compaction
    // summary preserves exactly what they chose to save.
    "experimental.session.compacting": async (_input, output) => {
      if (!pendingCheckpoint) return

      const cp = pendingCheckpoint
      const lines: string[] = [
        "## Agent Checkpoint",
        "The agent explicitly saved this checkpoint before compaction.",
        "Preserve this information exactly — it is the agent's own account of its progress.\n",
        `**Goal:** ${cp.goal}`,
        `\n**Accomplished:**\n${cp.accomplished}`,
        `\n**In Progress:**\n${cp.in_progress}`,
        `\n**Next Steps:**\n${cp.next_steps}`,
      ]

      if (cp.key_decisions) {
        lines.push(`\n**Key Decisions:**\n${cp.key_decisions}`)
      }
      if (cp.relevant_files) {
        lines.push(`\n**Relevant Files:**\n${cp.relevant_files}`)
      }

      output.context.push(lines.join("\n"))
      pendingCheckpoint = null  // consumed
    },

    // ── 6. event hook — detect post-compaction ──────────────────────────────
    event: async ({ event }: { event: Event }) => {
      if (event.type === "session.compacted") {
        justCompacted = true
        pendingCheckpoint = null  // clear any stale checkpoint
        compactTriggered = false
      }
    },
  }
}

export default SelfCompact
