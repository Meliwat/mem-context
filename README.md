# mem-evolved Context Manager 🧹

> **Your agent never fills up its context window. Every heavy task goes to a subagent. You only see the result.**

```bash
npx mem-context
```

---

## The Problem

Every agent hits the wall. After 50-100 turns, the context window fills up with tool outputs, terminal dumps, and resolved sub-tasks. The client says "context compaction" — and your agent forgets preferences, decisions, and where it was.

**Without Context Manager:**

```
User → Agent does 50 tool calls → 200 messages → COMPACT → lose context → restart
```

## The Solution: Brain + Subagent Architecture

**Subagents don't accumulate context in the parent.** The Context Manager spawns a Claude Code subagent for every heavy task. The subagent does all the work — terminal commands, file edits, debugging — but **none of that shows up in your conversation**. You only get back a compact result.

**With Context Manager:**

```
User → Brain → context_delegate("build auth API")  ──→  Claude Code (50 tool calls, hidden)
               │                                           returns: "POST /register done"
               │
               → context_delegate("build frontend")  ──→  Claude Code (30 tool calls, hidden)
               │                                           returns: "LoginForm component done"
               │
               → context_offload(decisions)           ──→  saved to permanent memory

Your conversation: 8 turns, 30% utilization, never compacting
```

**200 tool calls happen. You see 2 conversations turns. Your context never fills.**

---

## How It Works

The Context Manager is an MCP server with 5 tools:

| Tool | What it does | When to call |
|------|-------------|-------------|
| `context_delegate` | Spawns Claude Code subagent, returns compact result | Every time you'd do 3+ tool calls |
| `context_offload` | Saves decisions to permanent memory | After delegating tasks |
| `context_status` | Reports context utilization + hidden work count | Every few turns |
| `context_snapshot` | Saves brain checkpoint for later recovery | Before risky operations |
| `context_auto` | Offloads recent decisions + reports status | Periodic maintenance |

### The core tool: `context_delegate`

```json
// Your brain calls:
{
  "goal": "Implement JWT auth middleware for Express",
  "context": "Project uses Express, Prisma, PostgreSQL. Routes in /api/auth/",
  "agent": "claude",
  "timeout": 120
}

// You get back:
{
  "success": true,
  "summary": "Created middleware/jwt.js with verifyToken middleware. Tests passing.",
  "hidden_turns": 47,
  "decisions_extracted": ["Using jsonwebtoken library", "Token expires in 24h"]
}
```

The subagent did **47 turns** of work. You saw **1 turn**. Your context grew by 1, not 47.

---

## Quick Start

### 1. Install

```bash
# Run directly — no install required. Requires mem-evolved (optional but recommended).
npx mem-evolved-context
```

Data stored at `~/.mem-evolved/` — shared with mem-evolved.

### 2. Configure

**Claude Code** — add to `~/.claude/claude.json`:

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

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mem-context": {
      "command": "npx",
      "args": ["mem-context"]
    }
  }
}
```

Any MCP-compatible agent works the same way.

### 3. Add the Brain Prompt

Add this to your agent's instructions (`.claude.md`, `.cursorrules`, or system prompt):

```
You are in Brain mode. You NEVER do heavy work directly — you delegate it.

Rules:
1. For any task that would require 3+ tool calls, call context_delegate instead
2. After delegating, call context_offload with any decisions made
3. Call context_status periodically to monitor your context utilization
4. Keep your direct-turn count under 15 at all times
5. Trust the subagent — it has full Claude Code capabilities
```

That's it. Your agent will automatically delegate heavy work and never fill its context.

---

## Tools Reference

### `context_delegate`

Delegates a task to a Claude Code subagent. The subagent runs in an isolated process — all its tool calls, terminal output, and internal reasoning stay hidden from your conversation.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `goal` | string | required | What the subagent should accomplish. Be specific. |
| `context` | string | "" | Background info: file paths, decisions, constraints |
| `agent` | string | "claude" | Subagent type (currently claude only) |
| `return_type` | string | "summary" | "summary" or "raw" |
| `timeout` | number | 120 | Max seconds to wait |

Returns: `{ success, summary, hidden_turns, decisions_extracted }`

### `context_offload`

Saves decisions and facts to permanent memory (stored in `~/.mem-evolved/`). These survive context compaction and session restarts.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `decisions` | array[string] | required | Decisions, preferences, conventions to save |
| `target` | string | "memory" | "user" (personal) or "memory" (project facts) |

### `context_status`

Shows your current context health. Pass your direct-turn count for an accurate utilization estimate.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `direct_turns` | number | optional | Your current conversation turn count |

Returns: `{ context_utilization, session: { delegations, hidden_turns, offloaded_decisions }, safe, recommendation }`

### `context_auto`

Full auto-pilot: offload recent decisions and check status.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `recent_decisions` | array[string] | [] | Decisions to offload |
| `direct_turns` | number | optional | Turn count for utilization estimate |

### `context_snapshot`

Saves a checkpoint of your current brain state to disk. Recoverable later.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tag` | string | required | Label (e.g., "before-db-migration") |
| `notes` | string | "" | What's happening at this point |

---

## Why This Works

**The fundamental insight:**

Subagents don't accumulate context in the parent process. Each `context_delegate` call spawns an isolated Claude Code process. The subagent can do 100+ tool calls, write files, run debuggers — **none of that shows up in your conversation.** You get one compact summary back.

Your conversation stays at 5-15 messages. Indefinitely. Every heavy task goes to a subagent.

| Approach | Prevents compact? | Why |
|----------|-----------------|-----|
| Trim old messages | ❌ | Client controls the window, not your tools |
| Summarize turns | ❌ | Summary still lives in your context |
| **Subagent delegation (this)** | **✅ YES** | **Subagent context is invisible to parent** |
| API proxy interceptor | ⚠️ | Works but 2 weeks to build vs 2 days |

---

## Example Workflow

```
You: "Create a full-stack todo app with auth"

Brain (direct turn 1):
  → context_delegate("plan architecture", 
       context="React + Express + SQLite")
  → Gets: "3 endpoints, JWT auth, React with Tailwind"

Brain (direct turn 2):
  → context_delegate("build backend API", 
       context="per plan: Express, JWT, SQLite, /api/auth, /api/todos")
  → Gets: "All 3 endpoints done, tests passing, 12 files"

Brain (direct turn 3):
  → context_delegate("build React frontend", 
       context="backend at localhost:3001, JWT auth, todo CRUD")
  → Gets: "Login, register, todo list. Connected to backend."

Brain (direct turn 4):
  → context_offload(decisions from all 3 delegations)
  → context_status(direct_turns=4)
  → "4 turns. 12 hidden (subagent) turns. 15 decisions stored. Safe."

You: "Add dark mode"
Brain (direct turn 5):
  → context_delegate("add dark mode to React app",
       context="React with Tailwind, existing auth flow")
  → Gets: "Dark mode with localStorage. Tailwind dark: prefix."
```

**Your conversation: 6 turns. Total. Forever.**
**Actual work done: 100+ turns of Claude Code.**
**You never see context compaction.**

---

## With mem-evolved (recommended)

Run both MCP servers together for the full stack:

```bash
npx mem-evolved             # Memory + session search + skills
npx mem-context     # Context manager with subagent delegation
```

```
mem-evolved provides:
  🧠 Permanent memory — survives everything
  📚 Session search — never lose past work
  🛠️ Skills — reusable procedures

mem-context provides:
  🧹 Subagent delegation — context never fills
  💾 Decision offload — save value before compact
  📊 Context pulse — know your utilization
```

Together they solve: **"Your agent remembers everything and never fills up."**

---

## License

MIT

---

*"Brain delegates. Context stays small. No compacting ever."*
