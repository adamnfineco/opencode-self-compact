# @adamnfineco/opencode-self-compact

An [OpenCode](https://opencode.ai) plugin that gives agents context window awareness and enriches compaction with agent-provided state — so they pick up where they left off.

## The problem

OpenCode auto-compacts when context gets full. By then the agent has no warning, the summary is generic, and whatever wasn't explicitly saved is gone. If it was mid-task, it loses track.

## What this does

- **Always visible**: injects a live usage line into every system prompt so the agent knows where it stands
- **At threshold** (default 85% of usable context): tells the agent to finish its current step and call `compact_checkpoint`
- **`compact_checkpoint` tool**: the agent saves structured state — goal, what's done, what's in progress, next steps, key decisions, relevant files
- **Enriched compaction**: the agent's state dump is injected into the compaction prompt so the summary preserves exactly what matters
- **Post-compaction awareness**: one-shot note after resuming so the agent can orient itself

The checkpoint is best-effort. If the agent ignores the nudge, compaction fires naturally — no worse than default. When it does checkpoint, the summary is dramatically better.

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
  "threshold": 85,
  "showUsage": true,
  "enabled": true
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `threshold` | `85` | % of usable context at which to nudge the agent |
| `showUsage` | `true` | Always show the usage line in every system prompt |
| `enabled` | `true` | Set to `false` to disable entirely |

The threshold is computed against the **usable** context limit — `model.limit.context - max(compaction.reserved, maxOutputTokens)` — mirroring OpenCode's own compaction math. If you tune `compaction.reserved` in your OpenCode config, this plugin's threshold adjusts automatically.

## How it works

```
Agent works → sees usage in system prompt → keeps working
           → crosses threshold (default 85%)
           → "Finish your step, call compact_checkpoint"
           → Agent calls compact_checkpoint with structured state
           → State injected into compaction summary
           → Agent picks up where it left off ✨
```

The `compact_checkpoint` tool accepts:

| Arg | Required | Description |
|-----|----------|-------------|
| `goal` | ✓ | What the user is trying to accomplish |
| `accomplished` | ✓ | What's been completed this session |
| `in_progress` | ✓ | What was actively being worked on |
| `next_steps` | ✓ | What needs to happen next, in order |
| `key_decisions` | — | Important decisions or discoveries |
| `relevant_files` | — | Files modified or important to the task |

## Notes

- Works with any agent
- Skips OpenCode's internal sub-agents (title generator, compaction summarizer)
- No external tokenizer — uses a char-count heuristic (4 chars ≈ 1 token), precise enough for threshold decisions
- No persistence — state is per-session, no side effects

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

### How to use compact_checkpoint

Once installed, you'll see a `<context-usage>` tag in every system prompt showing current token usage. When context approaches the threshold, a `<context-awareness>` directive will appear. At that point, finish your current atomic step and call `compact_checkpoint`:

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
