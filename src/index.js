#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn, execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEM_DIR = process.env.MEM_EVOLVED_DIR || path.join(process.env.HOME || '/tmp', '.mem-evolved');
const OFFLOADS_FILE = path.join(MEM_DIR, 'brain-decisions.json');
const STATS_FILE = path.join(MEM_DIR, 'brain-stats.json');

// ── State ──
let stats = {
  totalDelegations: 0,
  totalHiddenTurns: 0,
  totalOffloadedDecisions: 0,
  sessionDelegations: 0,
  sessionHiddenTurns: 0,
  sessionOffloadedDecisions: 0,
  agentsUsed: {},
};

async function loadStats() {
  try {
    const data = await fs.readFile(STATS_FILE, 'utf-8');
    stats = { ...stats, ...JSON.parse(data) };
  } catch {}
}

async function saveStats() {
  await fs.mkdir(path.dirname(STATS_FILE), { recursive: true });
  await fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2));
}

async function loadDecisions() {
  try {
    const data = await fs.readFile(OFFLOADS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch { return []; }
}

async function saveDecisions(decisions) {
  await fs.mkdir(path.dirname(OFFLOADS_FILE), { recursive: true });
  await fs.writeFile(OFFLOADS_FILE, JSON.stringify(decisions, null, 2));
}

// ── Subagent Spawning (Hermes-style) ──

const SUBAGENT_SYSTEM_PROMPT = `You are a LEAF subagent spawned by the Brain.

Your job is to complete the goal you're given. You have access to:
1. All Claude Code tools (Bash, Edit, Glob, LS, Read, Write, etc.)
2. mem-evolved MCP for permanent memory (memory_add, memory_search, memory_list, skill_save)

RULES:
- You are a LEAF — you CANNOT delegate or spawn subagents. Do ALL work yourself.
- Save important decisions to memory using memory_add as you make them.
- Use memory_search to recall past context if needed.

After completing your work, output a structured result in this exact format:

<result>
  <summary>What you accomplished — concise, action-oriented</summary>
  <files>comma-separated list of files created or modified</files>
  <decisions>
    <decision>Decision 1</decision>
    <decision>Decision 2</decision>
  </decisions>
</result>

Do NOT output anything after the </result> tag.`;

function spawnSubagentV2(goal, context, workDir, timeout = 300) {
  return new Promise((resolve, reject) => {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        "mem-evolved": {
          command: "npx",
          args: ["mem-evolved"],
        },
      },
    });

    const args = [
      '-p', '-',
      '--mcp-config', mcpConfig,
      '--append-system-prompt', SUBAGENT_SYSTEM_PROMPT,
    ];

    const proc = spawn('claude', args, {
      cwd: workDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeout * 1000,
      env: {
        ...process.env,
        CLAUDE_CODE_HEADLESS: '1',
        CLAUDE_CODE_QUIET: '1',
      },
    });

    let output = '';
    let errorOutput = '';
    let turnCount = 0;

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      turnCount += (text.match(/[✓>│]/g) || []).length;
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('error', (err) => reject(err));

    proc.on('close', (code) => {
      if (code !== 0 && !output) {
        reject(new Error(`Subagent exited with code ${code}: ${errorOutput.slice(0, 500) || 'no output'}`));
        return;
      }

      const parsed = parseResult(output);

      resolve({
        success: code === 0 || parsed.summary.length > 0,
        summary: parsed.summary || cleanOutput(output),
        hiddenTurns: Math.max(turnCount, 3),
        decisions: parsed.decisions || [],
        files: parsed.files || [],
        exitCode: code,
      });
    });

    const fullPrompt = context
      ? `Goal: ${goal}\n\nContext: ${context}\n\nRemember to output your <result> XML when done.`
      : `Goal: ${goal}\n\nRemember to output your <result> XML when done.`;

    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}

function parseResult(output) {
  const result = { summary: '', decisions: [], files: [] };

  const summaryMatch = output.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) result.summary = summaryMatch[1].trim();

  const filesMatch = output.match(/<files>([\s\S]*?)<\/files>/i);
  if (filesMatch) {
    result.files = filesMatch[1].split(',').map(f => f.trim()).filter(Boolean);
  }

  const decisionMatches = output.matchAll(/<decision>([\s\S]*?)<\/decision>/gi);
  for (const match of decisionMatches) {
    const d = match[1].trim();
    if (d.length > 3) result.decisions.push(d);
  }

  if (result.decisions.length === 0) {
    const blockMatch = output.match(/<decisions>([\s\S]*?)<\/decisions>/i);
    if (blockMatch) {
      const lines = blockMatch[1].split('\n').map(l => l.trim()).filter(l => l.length > 5 && !l.startsWith('<'));
      result.decisions = lines;
    }
  }

  return result;
}

function cleanOutput(output) {
  let cleaned = output
    .replace(/<result>[\s\S]*<\/result>/gi, '')
    .replace(/^[>│]\s*/gm, '')
    .replace(/^─{3,}.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (cleaned.length > 3000) {
    const summaryMarkers = cleaned.match(/(?:Summary|Result|Done|Completed|Output):?[\s\S]{1,2000}$/i);
    if (summaryMarkers) cleaned = summaryMarkers[0];
    else cleaned = cleaned.slice(-2000);
  }

  return cleaned;
}

// ── MCP Server ──

const server = new Server(
  { name: 'mem-context', version: '0.3.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'context_delegate',
      description: `Delegate a task to a Claude Code subagent with full memory (mem-evolved). The subagent does all the work — 50+ tool calls — but NONE accumulates in your context. Subagent saves decisions to permanent memory autonomously.`,
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the subagent should accomplish. Be specific.' },
          context: { type: 'string', description: 'Background: file paths, project structure, decisions already made. Subagent has NO access to your conversation.' },
          workdir: { type: 'string', description: 'Working directory (defaults to cwd)' },
          timeout: { type: 'number', default: 300, description: 'Max seconds (default: 300)' },
        },
        required: ['goal'],
      },
    },
    {
      name: 'context_offload',
      description: `Save decisions/facts to permanent memory. Survives context compaction, restarts, everything.`,
      inputSchema: {
        type: 'object',
        properties: {
          decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions to save.' },
          target: { type: 'string', default: 'memory', enum: ['user', 'memory'] },
        },
        required: ['decisions'],
      },
    },
    {
      name: 'context_status',
      description: `Check context health. Shows utilization, hidden turns (subagent work you never saw), and whether you're in the safe zone (<15 direct turns).`,
      inputSchema: {
        type: 'object',
        properties: {
          direct_turns: { type: 'number', description: 'Your current turn count.' },
        },
      },
    },
    {
      name: 'context_auto',
      description: `Full maintenance: offloads decisions, trims old results, checks status. Run every ~20 delegations.`,
      inputSchema: {
        type: 'object',
        properties: {
          recent_decisions: { type: 'array', items: { type: 'string' } },
          direct_turns: { type: 'number' },
        },
      },
    },
    {
      name: 'context_snapshot',
      description: `Save a brain checkpoint. Recover later with mem-evolved session search.`,
      inputSchema: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Label (e.g., "before-migration")' },
          notes: { type: 'string' },
        },
        required: ['tag'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'context_delegate': {
      const { goal, context = '', workdir, timeout = 300 } = args;

      try {
        const result = await spawnSubagentV2(goal, context, workdir || process.cwd(), timeout);

        stats.totalDelegations++;
        stats.sessionDelegations++;
        stats.totalHiddenTurns += result.hiddenTurns;
        stats.sessionHiddenTurns += result.hiddenTurns;
        stats.agentsUsed['claude'] = (stats.agentsUsed['claude'] || 0) + 1;
        await saveStats();

        if (result.decisions.length > 0) {
          const existing = await loadDecisions();
          existing.push(...result.decisions.map(d => ({
            content: d, target: 'memory',
            timestamp: new Date().toISOString(),
            source: 'subagent-autonomous',
          })));
          await saveDecisions(existing);
          stats.totalOffloadedDecisions += result.decisions.length;
          stats.sessionOffloadedDecisions += result.decisions.length;
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              summary: result.summary,
              hidden_turns: result.hiddenTurns,
              decisions_saved: result.decisions,
              files_changed: result.files,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Delegation failed: ${err.message}` }],
        };
      }
    }

    case 'context_offload': {
      const { decisions, target = 'memory' } = args;
      const existing = await loadDecisions();
      existing.push(...decisions.map(d => ({ content: d, target, timestamp: new Date().toISOString() })));
      await saveDecisions(existing);
      stats.totalOffloadedDecisions += decisions.length;
      stats.sessionOffloadedDecisions += decisions.length;
      await saveStats();
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, saved: decisions.length, total_stored: existing.length }, null, 2) }],
      };
    }

    case 'context_status': {
      const { direct_turns } = args || {};
      const decisions = await loadDecisions();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            context_utilization: direct_turns ? Math.min(Math.round((direct_turns / 100) * 100), 100) : 'unknown',
            direct_turns,
            session: { delegations: stats.sessionDelegations, hidden_turns: stats.sessionHiddenTurns, offloaded_decisions: stats.sessionOffloadedDecisions },
            all_time: { total_delegations: stats.totalDelegations, total_hidden_turns: stats.totalHiddenTurns, total_offloaded_decisions: stats.totalOffloadedDecisions },
            stored_decisions: decisions.length,
            safe: direct_turns ? direct_turns < 15 : 'unknown',
            recommendation: direct_turns && direct_turns > 15 ? '>15 turns — delegate the next task or run context_auto' : 'Safe. Keep delegating.',
          }, null, 2),
        }],
      };
    }

    case 'context_auto': {
      const { recent_decisions = [], direct_turns } = args;
      if (recent_decisions.length > 0) {
        const existing = await loadDecisions();
        existing.push(...recent_decisions.map(d => ({ content: d, target: 'memory', timestamp: new Date().toISOString() })));
        await saveDecisions(existing);
        stats.totalOffloadedDecisions += recent_decisions.length;
        stats.sessionOffloadedDecisions += recent_decisions.length;
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            offloaded: recent_decisions.length,
            total_stored_decisions: (await loadDecisions()).length,
            context_utilization: direct_turns ? Math.min(Math.round((direct_turns / 100) * 100), 100) : 'unknown',
            session: { delegations: stats.sessionDelegations, hidden_turns: stats.sessionHiddenTurns },
            status: 'Brain healthy.',
          }, null, 2),
        }],
      };
    }

    case 'context_snapshot': {
      const { tag, notes = '' } = args;
      const snapshotDir = path.join(MEM_DIR, 'snapshots');
      const filename = `${tag.replace(/[^a-z0-9-]/gi, '_')}-${Date.now()}.json`;
      await fs.mkdir(snapshotDir, { recursive: true });
      await fs.writeFile(path.join(snapshotDir, filename), JSON.stringify({ tag, notes, timestamp: new Date().toISOString(), decisions: await loadDecisions() }, null, 2));
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, tag, message: `Snapshot saved. Recover: session_search(query="${tag}")` }, null, 2) }],
      };
    }

    default:
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
});

// ── Start ──

async function main() {
  await loadStats();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('mem-context fatal error:', err);
  process.exit(1);
});