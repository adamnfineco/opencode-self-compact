# opencode-self-compact

An [OpenCode](https://opencode.ai) plugin that gives agents context window awareness and enriches compaction with agent-provided state — so they pick up where they left off.

## The problem

OpenCode auto-compacts when context gets full. By then the agent has no warning, the summary is generic, and whatever wasn't explicitly saved is gone. If it was mid-task, it loses track.

## What this does

- **Always visible**: injects a live `<context-usage>` tag into every system prompt so the agent knows where it stands
- **At threshold**: when tokens approach the usable limit, injects a directive telling the agent to call `compact_checkpoint`
- **Escalation**: if the agent ignores the directive, the plugin aborts the current generation and sends a forced checkpoint prompt — giving the agent one last turn to save state
- **`compact_checkpoint` tool**: the agent saves structured state — goal, what's done, what's in progress, next steps, key decisions, relevant files
- **Enriched compaction**: the agent's state dump is injected into the compaction prompt so the summary preserves exactly what matters
- **Post-compaction awareness**: one-shot note after resuming so the agent can orient itself
- **Backstop**: if all else fails, OpenCode's auto-compaction still catches it — no worse than default

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["github:adamnfineco/opencode-self-compact"]
}
```

Requires OpenCode 1.2.0+.

## Config

Create `~/.config/opencode/self-compact.json` (all fields optional):

```json
{
  "usableLimitBuffer": 4000,
  "showUsage": true,
  "enabled": true
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `usableLimitBuffer` | `4000` | Tokens before the usable limit at which to trigger the checkpoint. The plugin fires when estimated tokens reach `usableLimit - usableLimitBuffer`. Same unit as OpenCode's `compaction.reserved`. |
| `showUsage` | `true` | Always show the usage line in every system prompt |
| `enabled` | `true` | Set to `false` to disable entirely |

The usable limit is derived from your [OpenCode compaction config](https://opencode.ai/docs/config/#compaction) (currently defaults to `reserved: 20000`). This plugin reads that automatically — no need to configure anything here unless you want to tune the checkpoint buffer itself.

The default of 4000 covers the checkpoint response (~500-1k tokens), heuristic counting margin (~1-2k), and headroom for the current turn (~1-2k). Increase it if compaction fires before the checkpoint lands; decrease it to squeeze more usable context (below 2000 is risky).

## How it works

```
Agent works normally
  └─ sees <context-usage> tag in every system prompt (awareness)

Tokens approach the limit (usableLimit - usableLimitBuffer)
  └─ Directive injected: "call compact_checkpoint, nothing else"
  └─ Model calls compact_checkpoint with structured state
  └─ Plugin triggers compaction with that state enriching the summary
  └─ Agent resumes from a clean, structured summary

If the model ignores the directive:
  └─ Next turn: plugin aborts generation
  └─ Sends forced checkpoint prompt
  └─ Model gets one last turn to save state

If everything fails:
  └─ OpenCode auto-compaction catches it (default behavior, no enrichment)
```

## The `compact_checkpoint` tool

| Arg | Required | Description |
|-----|----------|-------------|
| `goal` | yes | What the user is trying to accomplish |
| `accomplished` | yes | What's been completed this session |
| `in_progress` | yes | What was actively being worked on |
| `next_steps` | yes | What needs to happen next, in order |
| `key_decisions` | — | Important decisions or discoveries |
| `relevant_files` | — | Files modified or important to the task |

## Notes

- Works with any model and any agent
- Skips OpenCode's internal sub-agents (title generator, compaction summarizer)
- No external tokenizer — uses a char-count heuristic (4 chars ≈ 1 token), precise enough for threshold decisions
- No persistence — state is per-session, no side effects
- Threshold is token-based (same unit as OpenCode's `compaction.reserved`), not percentage-based

## For LLM Agents

<details>
<summary>Instructions for AI assistants helping set this up</summary>

### Installing

Add to the user's `opencode.json` (global: `~/.config/opencode/opencode.json`, or project: `.opencode/opencode.json`):

```json
{
  "plugin": ["github:adamnfineco/opencode-self-compact"]
}
```

### How it works for you

Once installed, you'll see a `<context-usage>` tag in every system prompt showing your current token usage. When context approaches the limit, a `<context-awareness>` directive will appear telling you to call `compact_checkpoint`.

When you see the directive, respond ONLY with the `compact_checkpoint` call — no other text or tool calls:

```
compact_checkpoint(
  goal: "What the user is trying to accomplish overall",
  accomplished: "What's been completed this session",
  in_progress: "The specific thing being worked on right now",
  next_steps: "Ordered list of what comes next",
  key_decisions: "Important decisions or discoveries made",  // optional
  relevant_files: "Files modified or important to the task"  // optional
)
```

Be specific — the content of this call becomes the compaction summary. Vague inputs produce vague handoffs.

If you ignore the directive, your generation will be aborted and you'll get one forced turn to checkpoint. Don't ignore it.

### Verifying it's working

Ask the agent: *"What is your current context window usage?"* — it should report a percentage and token count from the `<context-usage>` tag in its system prompt.

</details>

## Development

```sh
git clone https://github.com/adamnfineco/opencode-self-compact
cd opencode-self-compact
bun install
bun run build
```
