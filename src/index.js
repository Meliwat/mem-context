#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

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

// ── Persistence ──
async function loadStats() {
  try {
    const data = await fs.readFile(STATS_FILE, 'utf-8');
    stats = { ...stats, ...JSON.parse(data) };
  } catch { /* first run */ }
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

// ── Subagent Spawning ──

function detectAgents() {
  const available = [];
  try {
    const result = execSync('which claude 2>/dev/null');
    if (result.toString().trim()) available.push('claude');
  } catch {}
  return available;
}

function spawnSubagent(goal, context, agentType = 'claude', timeout = 120) {
  return new Promise((resolve, reject) => {
    const fullPrompt = context
      ? `Context: ${context}\n\nGoal: ${goal}`
      : `Goal: ${goal}`;

    const proc = spawn(agentType, ['-p', '-'], {
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
      // Rough heuristic: count lines that look like tool calls or assistant turns
      turnCount += (text.match(/[>│]/g) || []).length;
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('error', (err) => reject(err));

    proc.on('close', (code) => {
      if (code !== 0 && !output) {
        reject(new Error(`Subagent exited with code ${code}: ${errorOutput || 'no output'}`));
        return;
      }

      // Extract decisions from subagent output
      const decisions = extractDecisions(output);

      // Clean up the output — remove CLI framing, tool call noise
      const summary = cleanSubagentOutput(output);

      resolve({
        success: code === 0,
        summary,
        exitCode: code,
        hiddenTurns: Math.max(turnCount, 3), // at least 3 turns
        decisions,
        duration: timeout,
      });
    });

    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}

function extractDecisions(output) {
  const decisions = [];
  const patterns = [
    /(?:decided?|cho[o]se|opted? for|settled? on|went with|using|prefer|convention):?\s*(.+)$/gim,
    /(?:we'll|we will|let's|i'll|i will)\s+(?:use|implement|go with|build|add|create)\s+(.+)$/gim,
    /(?:the\s+(?:approach|pattern|standard|convention|architecture))\s+(?:is|will be|uses?)\s+(.+)$/gim,
  ];

  const lines = output.split('\n');
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match && match[1].trim().length > 5) {
        decisions.push(match[1].trim());
      }
    }
  }

  return [...new Set(decisions)].slice(0, 10); // dedup, max 10
}

function cleanSubagentOutput(output) {
  // Remove CLI framing lines
  let cleaned = output
    .replace(/^[>│]\s*/gm, '')
    .replace(/^─{3,}.*$/gm, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // If output is very long, truncate to last meaningful part
  if (cleaned.length > 3000) {
    // Try to find the final summary
    const summaryMarkers = cleaned.match(/(?:Summary|Result|Done|Completed|Output):?[\s\S]{1,2000}$/i);
    if (summaryMarkers) {
      cleaned = summaryMarkers[0];
    } else {
      cleaned = cleaned.slice(-2000);
    }
  }

  return cleaned;
}

// ── MCP Server ──

const server = new Server(
  {
    name: 'mem-context',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'context_delegate',
      description: `Delegate a task to a subagent (Claude Code). The subagent does all the work — 50+ tool calls, terminal commands, file edits — but NONE of that accumulates in your context. You only receive a compact summary back. This is THE tool that prevents context compaction.`,
      inputSchema: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description: 'What the subagent should accomplish. Be specific and self-contained.',
          },
          context: {
            type: 'string',
            description: 'Background info: file paths, project structure, decisions already made, constraints.',
          },
          agent: {
            type: 'string',
            description: 'Subagent to use (default: claude)',
            default: 'claude',
            enum: ['claude'],
          },
          return_type: {
            type: 'string',
            description: 'How to return the result. "summary" (default): human-readable. "raw": full output.',
            default: 'summary',
            enum: ['summary', 'raw'],
          },
          timeout: {
            type: 'number',
            description: 'Max seconds to wait (default: 120)',
            default: 120,
          },
        },
        required: ['goal'],
      },
    },
    {
      name: 'context_offload',
      description: `Save decisions and facts from completed subagent tasks to permanent memory. These survive context compaction, session restarts, and agent switches. Reads automatically on next start.`,
      inputSchema: {
        type: 'object',
        properties: {
          decisions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Decisions, preferences, or conventions to save. Keep concise and declarative.',
          },
          target: {
            type: 'string',
            description: 'mem-evolved target: "user" (personal preferences) or "memory" (project facts).',
            default: 'memory',
            enum: ['user', 'memory'],
          },
        },
        required: ['decisions'],
      },
    },
    {
      name: 'context_status',
      description: `Check your context utilization and see how much work was hidden via subagents. If your direct-turn count is <15 and hidden turns >0, you're in the safe zone. No compaction risk.`,
      inputSchema: {
        type: 'object',
        properties: {
          direct_turns: {
            type: 'number',
            description: 'Number of turns in your current conversation (optional — pass for accurate utilization estimate)',
          },
        },
      },
    },
    {
      name: 'context_auto',
      description: `Full auto-pilot: offload decisions from recent subagent results, then report status. Run this periodically to keep decisions saved and context stable.`,
      inputSchema: {
        type: 'object',
        properties: {
          recent_decisions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Decisions from recent subagent work to offload (optional).',
          },
          direct_turns: {
            type: 'number',
            description: 'Your current conversation turn count (optional).',
          },
        },
      },
    },
    {
      name: 'context_snapshot',
      description: `Save a checkpoint of your current brain state to mem-evolved session search. If you need to roll back or recover context later, you can find it with session_search().`,
      inputSchema: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description: 'Label for this snapshot (e.g., "before-db-migration", "pre-refactor")',
          },
          notes: {
            type: 'string',
            description: 'What was happening at this point (optional)',
          },
        },
        required: ['tag'],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'context_delegate': {
      const { goal, context, agent = 'claude', return_type = 'summary', timeout = 120 } = args;

      try {
        const result = await spawnSubagent(goal, context, agent, timeout);

        stats.totalDelegations++;
        stats.sessionDelegations++;
        stats.totalHiddenTurns += result.hiddenTurns;
        stats.sessionHiddenTurns += result.hiddenTurns;
        stats.agentsUsed[agent] = (stats.agentsUsed[agent] || 0) + 1;
        await saveStats();

        // If there are decisions, auto-offload them
        if (result.decisions.length > 0) {
          const existing = await loadDecisions();
          existing.push(...result.decisions.map(d => ({
            content: d,
            target: 'memory',
            timestamp: new Date().toISOString(),
            source_agent: agent,
          })));
          await saveDecisions(existing);
          stats.totalOffloadedDecisions += result.decisions.length;
          stats.sessionOffloadedDecisions += result.decisions.length;
        }

        const output = return_type === 'raw' ? result.summary : result.summary;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: result.success,
              summary: result.summary,
              hidden_turns: result.hiddenTurns,
              decisions_extracted: result.decisions,
              ...(result.success ? {} : { exit_code: result.exitCode }),
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
      existing.push(...decisions.map(d => ({
        content: d,
        target,
        timestamp: new Date().toISOString(),
      })));
      await saveDecisions(existing);

      stats.totalOffloadedDecisions += decisions.length;
      stats.sessionOffloadedDecisions += decisions.length;
      await saveStats();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            saved: decisions.length,
            total_stored: existing.length,
            target,
          }, null, 2),
        }],
      };
    }

    case 'context_status': {
      const { direct_turns } = args || {};

      const estimatedUtilization = direct_turns
        ? Math.min(Math.round((direct_turns / 100) * 100), 100)  // rough: each turn ~1% with delegation
        : 'unknown (pass direct_turns for estimate)';

      const decisions = await loadDecisions();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            context_utilization: estimatedUtilization,
            direct_turns,
            session: {
              delegations: stats.sessionDelegations,
              hidden_turns: stats.sessionHiddenTurns,
              offloaded_decisions: stats.sessionOffloadedDecisions,
            },
            all_time: {
              total_delegations: stats.totalDelegations,
              total_hidden_turns: stats.totalHiddenTurns,
              total_offloaded_decisions: stats.totalOffloadedDecisions,
              agents_used: stats.agentsUsed,
            },
            stored_decisions: decisions.length,
            safe: direct_turns ? direct_turns < 15 : 'unknown',
            recommendation: direct_turns && direct_turns > 15
              ? 'You have >15 direct turns. Consider running context_auto or context_delegate for the next task instead of doing it yourself.'
              : 'Continue delegating. Your context is healthy.',
          }, null, 2),
        }],
      };
    }

    case 'context_auto': {
      const { recent_decisions = [], direct_turns } = args;

      // Offload any provided decisions
      if (recent_decisions.length > 0) {
        const existing = await loadDecisions();
        existing.push(...recent_decisions.map(d => ({
          content: d,
          target: 'memory',
          timestamp: new Date().toISOString(),
        })));
        await saveDecisions(existing);
        stats.totalOffloadedDecisions += recent_decisions.length;
        stats.sessionOffloadedDecisions += recent_decisions.length;
      }

      const decisions = await loadDecisions();
      const estimatedUtilization = direct_turns
        ? Math.min(Math.round((direct_turns / 100) * 100), 100)
        : 'unknown';

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            offloaded: recent_decisions.length,
            total_stored_decisions: decisions.length,
            context_utilization: estimatedUtilization,
            direct_turns,
            session: {
              delegations: stats.sessionDelegations,
              hidden_turns: stats.sessionHiddenTurns,
            },
            all_time: {
              total_hidden_turns: stats.totalHiddenTurns,
            },
            status: 'Brain healthy. Keep delegating heavy work.',
          }, null, 2),
        }],
      };
    }

    case 'context_snapshot': {
      const { tag, notes = '' } = args;

      const snapshot = {
        tag,
        notes,
        timestamp: new Date().toISOString(),
        stats_at_snapshot: { ...stats },
        decisions: await loadDecisions(),
      };

      const snapshotDir = path.join(MEM_DIR, 'snapshots');
      const filename = `${tag.replace(/[^a-z0-9-]/gi, '_')}-${Date.now()}.json`;
      await fs.mkdir(snapshotDir, { recursive: true });
      await fs.writeFile(
        path.join(snapshotDir, filename),
        JSON.stringify(snapshot, null, 2)
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            snapshot_file: path.join(snapshotDir, filename),
            tag,
            message: 'Snapshot saved. Recover with: session_search(query="' + tag + '")',
          }, null, 2),
        }],
      };
    }

    default:
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
  }
});

// ── Start ──

async function main() {
  await loadStats();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Context Manager fatal error:', err);
  process.exit(1);
});
