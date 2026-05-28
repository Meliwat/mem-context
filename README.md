# 🧠 mem-context — Brain Mode

> **Never fill your context window again.**
>
> Your agent delegates heavy work to Claude Code subagents with permanent memory.
> Your conversation stays at 5-15 messages. Forever.

```bash
npx mem-context-setup
```

---

## The Problem

Every agent user knows this pain:

```
You: "build a blog with auth"
Agent: *does 50 tool calls, writes files, runs terminals*
       *200 messages later*
       "Context compaction — some context has been summarized"
       *Agent forgets your preferences, loses thread, gets confused*
```

**Context compaction is the #1 friction point in agent computing.** It resets progress, loses decisions, and forces you to re-explain things. It's the enemy.

## The Solution

**Brain Mode** changes how you use agents. Instead of one agent doing everything (and filling its context), the agent becomes a **Brain** that orchestrates **subagents**.

```
You: "build a blog with auth"
Brain → context_delegate("plan architecture", context="React + Express")
       → context_delegate("build backend API", context=plan)
       → context_delegate("build frontend", context=plan)
       → context_auto()
       → "Done. 87 hidden turns. Your context: 5 messages."

Your conversation: 5 messages. Never compacts.
Actual work done: 87 turns across 3 subagents.
You saw: 0 tool calls, 0 terminal output, 0 internal reasoning.
```

**Subagents are invisible to your context.** Each one spawns an isolated Claude Code process with its own mem-evolved for permanent memory. All tool calls, terminal dumps, and internal reasoning stay hidden. You only see the compact result.

---

## One Command Setup

```bash
npx mem-context-setup
```

This does everything:

| Step | What | Status |
|------|------|--------|
| 1 | Checks Claude Code is installed | ✅ |
| 2 | Installs mem-evolved (memory layer) | ✅ |
| 3 | Writes MCP config to `~/.claude/claude.json` | ✅ |
| 4 | Writes Brain Prompt to `.claude.md` | ✅ |

Then start Claude Code:

```bash
claude
> build a todo app
```

Your agent will automatically delegate heavy work. You see results, not tool calls.

---

## How It Works

### Architecture

```
You (user conversation — 5-15 messages forever)
    │
    ▼
Brain (your Claude Code agent)
    │
    ├── context_delegate("build auth")
    │       │
    │       ▼
    │   Claude Code subagent (47 turns, ALL hidden)
    │   ├── owns mem-evolved MCP (memory tools)
    │   ├── saves decisions autonomously
    │   ├── writes files, runs terminals
    │   └── returns: { summary, files, decisions }
    │
    ├── context_delegate("build frontend")
    │       │
    │       ▼
    │   Claude Code subagent (35 turns, ALL hidden)
    │   └── returns: { summary, files, decisions }
    │
    ├── context_offload(["use bcrypt", "JWT in .env"])
    └── context_status() → "5 turns, 25%, safe"
```

### The 5 Tools

| Tool | Purpose | When |
|------|---------|------|
| `context_delegate` | Spawn subagent with mem-evolved, get result | Every 3+ tool-call task |
| `context_offload` | Save decisions to permanent memory | After delegating |
| `context_status` | Check context health and hidden turns | Every ~5 turns |
| `context_auto` | Full maintenance sweep | Every ~20 delegations |
| `context_snapshot` | Save brain checkpoint | Before risky ops |

### `context_delegate` in depth

```json
// Brain calls:
{
  "goal": "Implement JWT auth middleware for Express",
  "context": "Express, Prisma, PostgreSQL. Routes in /api/auth/.",
  "timeout": 300
}

// Brain receives:
{
  "success": true,
  "summary": "Created middleware/jwt.js. 3 tests passing.",
  "hidden_turns": 47,
  "decisions_saved": [
    "Using jsonwebtoken library",
    "Token expires in 24h"
  ],
  "files_changed": [
    "middleware/jwt.js",
    "tests/auth.test.js"
  ]
}
```

The subagent did **47 turns** — terminal commands, file edits, debugging, testing.
You saw **1 message**. Your context grew by 1, not 47.

The subagent also called `memory_add("Using jsonwebtoken library")` autonomously during its work. That decision is permanently stored in mem-evolved before the brain even sees the result.

---

## The Math

| Pattern | Turns per task | Context used | Compacts? |
|---------|---------------|-------------|-----------|
| Direct work | 50-200 | **50-200 messages** | ✅ Yes |
| **Brain Mode** | **1** | **1 message** | **❌ Never** |

200K context window × 1 message per task = effectively infinite tasks. Run `context_auto` every ~20 delegations and your brain never needs compacting.

**200 tool calls happen. You see 2 messages. Your context stays healthy forever.**

---

## Who This Is For

- **Claude Code users** who constantly hit context limits
- **Cursor users** doing large refactors without losing context
- **Anyone who builds with AI agents** and hates explaining things twice

Symbiotic stack:
- **mem-context** = brain mode (this)
- **mem-evolved** = permanent memory for subagents
- Together they solve: *"Your agent remembers everything and never fills up."*

---

## Demo

```
You: create a full-stack todo app with auth and dark mode

Brain (turn 1):
  → context_delegate("plan architecture", context="React + Express + SQLite")
  → "3 tables, 5 endpoints, React with Tailwind"

Brain (turn 2):
  → context_delegate("build backend", context="Express, JWT, /api/auth, /api/todos")
  → "All routes done. 12 files. Tests passing."

Brain (turn 3):
  → context_delegate("build frontend", context="React, Tailwind, auth, todo CRUD")
  → "Login, register, todo list. Connected to backend."

Brain (turn 4):
  → context_delegate("add dark mode", context="React with Tailwind")
  → "Dark mode with localStorage. Tailwind dark: prefix."

Brain (turn 5):
  → context_offload(decisions from all delegations)
  → context_status(direct_turns=5)
  → "5 turns. 127 hidden subagent turns. 12 decisions stored. Safe."

Your conversation: 6 messages. Total.
Actual work: 127+ turns across 4 subagents.
You never saw a single tool call. You never hit context limit.
```

---

## Comparison

| | Without mem-context | With mem-context |
|--|-------------------|-----------------|
| Context grows by | **50-200 messages/task** | **1 message/task** |
| Tool calls in your window | **All of them** | **None** (subagent hides them) |
| Decisions saved? | **Lost on compact** | **Auto-saved to mem-evolved** |
| Subagent memory? | N/A | **Own mem-evolved instance** |
| Setup | Nothing | `npx mem-context-setup` |
| Works with | Any agent | **Any MCP-compatible agent** |

---

## FAQ

### Does this work with Cursor?

Yes. Add both MCP servers to `.cursor/mcp.json` and add the Brain Prompt to `.cursorrules`.

### Can I use this without mem-evolved?

You can, but memory won't persist. mem-evolved is the storage layer — mem-context is the strategy layer. Together they're unstoppable.

### Will subagents leak my conversation?

No. Each subagent spawns as an isolated Claude Code process. It has NO access to your conversation history — only the `context` parameter you pass. The subagent can see files in its working directory, same as your main agent.

### What if a subagent fails?

The brain sees the error and can retry with more context, increase timeout, or do the work directly. Subagent failures don't crash the brain.

### Can I run subagents in parallel?

Not yet. v0.3 is serial delegation. Parallel is on the roadmap.

---

## Quick Start (manual)

If you prefer to configure manually:

**1. Install**
```bash
npm install -g mem-context mem-evolved
```

**2. Configure ~/.claude/claude.json**
```json
{
  "mcpServers": {
    "mem-context": { "command": "npx", "args": ["mem-context"] },
    "mem-evolved": { "command": "npx", "args": ["mem-evolved"] }
  }
}
```

**3. Create .claude.md**
```
You are in BRAIN MODE. Delegate heavy work.
```

**4. Start Claude Code**
```bash
claude
```

---

## Requirements

- Node.js 18+
- Claude Code CLI (`claude` in PATH)
- Internet (for npx to fetch mem-evolved)

---

## License

MIT

---

*"Brain delegates. Context stays small. No compacting ever."*