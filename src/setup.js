#!/usr/bin/env node
// mem-context setup — one command to enter brain mode

import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || '/tmp';
const CLAUDE_CONFIG_DIR = path.join(HOME, '.claude');
const CLAUDE_CONFIG = path.join(CLAUDE_CONFIG_DIR, 'claude.json');

async function main() {
  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║         mem-context  —  Brain Mode        ║');
  console.log('  ║  Never fill your context window again.    ║');
  console.log('  ╚══════════════════════════════════════════╝\n');

  // Step 1: Check Claude Code
  console.log('  [1/4] Checking Claude Code...');
  try {
    const version = execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim();
    console.log(`        ✓ Claude Code ${version} detected`);
  } catch {
    console.log('        ✗ claude CLI not found. Install it first:');
    console.log('          https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }

  // Step 2: Install mem-evolved
  console.log('  [2/4] Installing mem-evolved (memory layer)...');
  try {
    execSync('npm install -g mem-evolved 2>&1', { stdio: 'pipe', timeout: 30000 });
    console.log('        ✓ mem-evolved installed');
  } catch (e) {
    console.log('        ⚠ Could not install globally, npx will handle it');
  }

  // Step 3: Write MCP config
  console.log('  [3/4] Configuring MCP servers...');
  await fs.mkdir(CLAUDE_CONFIG_DIR, { recursive: true });

  let existingConfig = {};
  try {
    existingConfig = JSON.parse(await fs.readFile(CLAUDE_CONFIG, 'utf-8'));
  } catch {}

  existingConfig.mcpServers = {
    ...(existingConfig.mcpServers || {}),
    'mem-context': {
      command: 'npx',
      args: ['mem-context'],
    },
    'mem-evolved': {
      command: 'npx',
      args: ['mem-evolved'],
    },
  };

  await fs.writeFile(CLAUDE_CONFIG, JSON.stringify(existingConfig, null, 2) + '\n');
  console.log('        ✓ MCP servers added to ~/.claude/claude.json');

  // Step 4: Create .claude.md brain prompt
  console.log('  [4/4] Creating brain mode prompt file...');
  const brainPrompt = `# Brain Mode — Never Compacting Context

You are in BRAIN MODE. You NEVER do heavy work directly.

## Setup (one-time)
Both MCP servers are already configured. Verify with: \`claude --version\`

## The Rules
1. For any task needing 3+ tool calls, call \`context_delegate\` instead
2. ALWAYS pass \`context\` — the subagent has NO access to your conversation
3. After delegating, call \`context_offload\` with decisions made
4. Call \`context_status\` every ~5 turns
5. Keep your direct-turn count under 15
6. Call \`context_snapshot\` before dangerous ops
7. Trust the subagent — it has full Claude Code + mem-evolved

## Quick Reference
- \`context_delegate(goal, context)\` — delegate heavy work to subagent
- \`context_offload(decisions)\` — save decisions to permanent memory
- \`context_status(direct_turns)\` — check context health
- \`context_auto()\` — full maintenance
- \`context_snapshot(tag)\` — save checkpoint

## Example
\`\`\`
You: "build a todo app with auth"
Brain → context_delegate(goal="plan architecture", context="React + Express")
→ context_delegate(goal="build backend", context=plan)
→ context_delegate(goal="build frontend", context=plan)
→ context_auto()
→ "Done. 87 hidden turns. Context: 6 messages. Never compacting."
\`\`\`

## Why This Works
Subagents are invisible to your context. Each delegate spawns an isolated Claude Code
process with its own mem-evolved memory. All 50+ tool calls stay hidden.

You see: 1 message. Actual work: 50+ turns.
Your conversation stays at 5-15 messages. Forever.
`;

  const cwd = process.cwd();
  const claudeMdPath = path.join(cwd, '.claude.md');
  try {
    await fs.access(claudeMdPath);
    console.log(`        ⚠ .claude.md already exists at ${claudeMdPath} (skipped)`);
    console.log(`          Template available at: ${path.join(__dirname, 'TEMPLATE.claude.md')}`);
  } catch {
    await fs.writeFile(claudeMdPath, brainPrompt);
    console.log(`        ✓ Brain prompt written to ${claudeMdPath}`);
  }

  // Done
  console.log('\n  ────────────────────────────────────────────');
  console.log('  ✓ Brain Mode is active!');
  console.log('');
  console.log('  Next time you start Claude Code, it will:');
  console.log('  • Delegate heavy tasks to subagents');
  console.log('  • Save decisions to permanent memory');
  console.log('  • Stay at 5-15 messages forever');
  console.log('  • Never show "context compaction" again');
  console.log('');
  console.log('  Try it:');
  console.log('    claude');
  console.log('    You: "build a blog app"');
  console.log('    (Brain delegates, subagents work, you see results)');
  console.log('');
  console.log('  Repo: https://github.com/Meliwat/mem-context');
  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});