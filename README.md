# opencode-self-compact

An OpenCode plugin that gives agents context window awareness and enriches compaction with agent-provided state — so they pick up where they left off.

## The problem

OpenCode auto-compacts when your context hits ~90% of the model's limit. By then the agent has no warning, the summary is generic, and whatever wasn't explicitly saved is gone. If the agent was mid-task, it loses track.

## What this does

1. **Injects a usage line into every system prompt** so the agent always knows where it stands (`<context-usage percent="45" .../>`)
2. **At threshold (default 85% of usable limit)**, adds a directive telling the agent to finish its current step and call `compact_checkpoint`
3. **`compact_checkpoint` tool** — the agent provides structured state (goal, what's done, what's in progress, next steps, key decisions, relevant files). The plugin stores it and triggers compaction.
4. **Enriches the compaction summary** by injecting the agent's state dump into the compaction prompt — the summary preserves exactly what the agent chose to save
5. **Detects post-compaction** via `session.compacted` event and injects a one-shot "you just resumed from compaction" note

The checkpoint is best-effort. If the agent ignores the nudge, compaction fires naturally — no worse than default behavior. When it does checkpoint, the summary is dramatically better.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-self-compact"]
}
```

## Config (optional)

Create `~/.config/opencode/self-compact.json`:

```json
{
  "threshold": 85,
  "showUsage": true,
  "enabled": true
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `threshold` | `85` | % of usable limit to trigger the nudge |
| `showUsage` | `true` | Always show the usage line in system prompt |
| `enabled` | `true` | Disable the plugin entirely |

The threshold is computed against the **usable** context limit — `model.limit.context - max(compaction.reserved, maxOutputTokens)` — mirroring OpenCode's own compaction math. If you change `compaction.reserved` in your OpenCode config, this plugin's thresholds adjust automatically.

## How it fits together

```
Agent works → sees "Context: 45%" in system prompt → keeps working
            → crosses 85% of usable limit
            → "Finish your step, call compact_checkpoint"
            → Agent calls compact_checkpoint with structured state
            → Plugin stores state + triggers session.summarize()
            → experimental.session.compacting fires
            → Agent's state injected into compaction prompt
            → Compact summary preserves what agent chose to save
            → session.compacted event fires, plugin resets
            → Next turn: "Session was just compacted" note
            → Agent picks up where it left off ✨
```

## Notes

- Works with any agent, not just Solin
- Skips internal OpenCode sub-agents (title generator, compaction summarizer)
- No external tokenizer dependency — uses 4 chars ≈ 1 token heuristic
- No persistence needed — state is per-session
