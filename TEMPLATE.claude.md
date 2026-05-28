# Brain Mode — Never Compacting Context

You are in BRAIN MODE. You NEVER do heavy work directly.

## Setup (one-time)

Both MCP servers must be in your config. Add to `~/.claude/claude.json`:

```json
{
  "mcpServers": {
    "mem-context": {
      "command": "npx",
      "args": ["mem-context"]
    },
    "mem-evolved": {
      "command": "npx",
      "args": ["mem-evolved"]
    }
  }
}
```

If you haven't yet:
```bash
npm install -g mem-context mem-evolved
```

---

## The Rules

1. For any task needing 3+ tool calls, call `context_delegate` instead
2. ALWAYS include `context` — the subagent has NO access to your conversation
3. After delegating, call `context_offload` with decisions made
4. Call `context_status` every ~5 turns to monitor utilization
5. Keep your direct-turn count under 15 at all times
6. Call `context_snapshot` before dangerous operations
7. Trust the subagent — it has full Claude Code + mem-evolved

## Decision Tree

```
Task appears
  │
  ├── Takes 1-2 tool calls? → Do it yourself (fast path)
  │
  └── Takes 3+ tool calls? → context_delegate(goal, context)
       │
       ├── Receives: { summary, decisions_saved, files_changed, hidden_turns }
       │
       └── context_offload(decisions)
            │
            └── context_status(direct_turns=...)
                 │
                 ├── safe? → continue
                 │
                 └── unsafe? → context_auto() → continue
```

## Examples

### Building a feature
```
context_delegate(
  goal="Add password reset flow: forgot, email token, reset endpoint",
  context="Express + Prisma + JWT. Uses nodemailer.",
  timeout=300
)
```

### Debugging
```
context_delegate(
  goal="Debug login 500 error. Check route, JWT, DB connection.",
  context="Auth route at POST /api/auth/login. Express + Prisma.",
  timeout=180
)
```

### Refactoring
```
context_delegate(
  goal="Refactor raw SQL queries to use Prisma Client",
  context="Current raw SQL in /db/queries/. Express app.",
  timeout=300
)
```

## Why This Works

Subagents are invisible to your context. Each `context_delegate` call spawns an isolated Claude Code process with its OWN mem-evolved memory. All tool calls, terminal output, and internal reasoning stay hidden.

You see: 1 message per task
Actual work: 50-200 turns per task

Your conversation stays at 5-15 messages. Forever. Never compacts.

## Troubleshooting

- **Subagent not starting** → check `claude --version`, increase timeout
- **Decisions missing** → always call `context_offload` after delegation
- **Context growing** → run `context_auto()` to offload and trim
- **Subagent has no context** → your `context` parameter was empty or vague