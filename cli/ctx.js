#!/usr/bin/env node
/**
 * ctx — Progressive session context tool for VS Code Copilot chat sessions
 *
 * Designed for agent use: token-light output, progressive discovery.
 * Every command returns ≤200 tokens. Use --detail or --range to go deeper.
 *
 * Commands:
 *   ctx status                              Session health, entry count, compaction events
 *   ctx turns [--from N] [--to N]          Turn summaries (default: last 5)
 *   ctx turn N [--full]                    Single turn detail
 *   ctx words [--turn N|--range N-M]       Word frequency (top 20)
 *   ctx tools [--turn N|--range N-M]       Tool call frequency
 *   ctx compactions                        List all compaction events (summary field presence)
 *   ctx models                             Model usage breakdown
 *
 * All output is JSON. Pipe to `python3 -m json.tool` or jq for formatting.
 *
 * @author claude-sonnet-4.6 (KADMON/0.0.1)
 * @version 0.1.0
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────

const APPDATA = (() => {
  const base = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const ins = path.join(base, 'Code - Insiders', 'User');
  return fs.existsSync(ins) ? ins : path.join(base, 'Code', 'User');
})();

const STORAGE_ROOT = path.join(APPDATA, 'workspaceStorage');

// ── Session loading ───────────────────────────────────────────────────────────

function findSession(sessionId) {
  for (const hash of fs.readdirSync(STORAGE_ROOT)) {
    const dir = path.join(STORAGE_ROOT, hash, 'chatSessions');
    for (const ext of ['.jsonl', '.json']) {
      const f = path.join(dir, `${sessionId}${ext}`);
      if (fs.existsSync(f)) return { path: f, hash, ext };
    }
  }
  return null;
}

function findLatestSession() {
  let latest = null, latestTime = 0;
  for (const hash of fs.readdirSync(STORAGE_ROOT)) {
    const dir = path.join(STORAGE_ROOT, hash, 'chatSessions');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
      const fp = path.join(dir, f);
      const mtime = fs.statSync(fp).mtimeMs;
      if (mtime > latestTime) {
        latestTime = mtime;
        latest = { path: fp, hash, ext: path.extname(f), sessionId: f.replace(/\.jsonl?$/, '') };
      }
    }
  }
  return latest;
}

function replayJsonl(content) {
  const entries = content.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
  const initial = entries.find(e => e.kind === 0);
  if (!initial) throw new Error('No kind:0 snapshot');
  const state = JSON.parse(JSON.stringify(initial.v));
  for (const e of entries) {
    if (e.kind === 0) continue;
    applyMutation(state, e);
  }
  return { state, entryCount: entries.length };
}

function applyMutation(state, entry) {
  const { kind, k, v, i } = entry;
  if (!k || !k.length) return;
  let obj = state;
  for (let idx = 0; idx < k.length - 1; idx++) {
    if (obj[k[idx]] == null) obj[k[idx]] = {};
    obj = obj[k[idx]];
  }
  const last = k[k.length - 1];
  if (kind === 1) obj[last] = v;
  else if (kind === 2) {
    if (!Array.isArray(obj[last])) obj[last] = [];
    if (i !== undefined) obj[last].splice(i);
    if (v) obj[last].push(...v);
  } else if (kind === 3) delete obj[last];
}

function loadSession(sessionId) {
  const found = sessionId ? findSession(sessionId) : findLatestSession();
  if (!found) throw new Error(`Session not found: ${sessionId || '(latest)'}`);
  const content = fs.readFileSync(found.path, 'utf8');
  if (found.ext === '.jsonl' || found.path.endsWith('.jsonl')) {
    const { state, entryCount } = replayJsonl(content);
    return { ...found, data: state, entryCount, sessionId: found.sessionId || sessionId };
  }
  const data = JSON.parse(content);
  return { ...found, data, entryCount: null };
}

// ── Text utilities ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','was','are','were','be','been','have','has','had','do','does',
  'did','will','would','could','should','may','might','that','this','it','i',
  'you','we','they','he','she','not','no','if','then','so','than','more','also',
  'just','like','about','up','out','into','over','after','before','its','their',
  'there','here','what','how','when','where','which','who','all','any','each'
]);

function wordFreq(text, topN = 20) {
  const words = text.toLowerCase().match(/\b[a-z][a-z0-9_]{2,}\b/g) || [];
  const freq = {};
  for (const w of words) {
    if (!STOP_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, topN)
    .reduce((acc, [w, n]) => { acc[w] = n; return acc; }, {});
}

function extractToolNames(response) {
  const names = [];
  for (const part of (response || [])) {
    if (part.kind === 'toolInvocationSerialized' && part.invocationMessage?.value) {
      // e.g. "Reading file..." — extract first word as a proxy
      // Better: look for tool name in confirmation label or the value string
      const m = part.invocationMessage.value.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (m) names.push(m[1]);
    }
  }
  return names;
}

// ── Summary helpers ───────────────────────────────────────────────────────────

function turnSummary(req, idx) {
  const msg = (req.message?.text || req.message || '').slice(0, 100);
  const result = req.result || {};
  const hasSummary = !!(result.metadata?.summary?.text);
  const toolCount = (req.response || []).filter(p => p.kind === 'toolInvocationSerialized').length;
  const elapsed = result.timings?.totalElapsed;
  return {
    turn: idx,
    ts: req.timestamp ? new Date(req.timestamp).toISOString() : null,
    msg: msg + (msg.length >= 100 ? '…' : ''),
    tools: toolCount,
    elapsed_ms: elapsed || null,
    compaction: hasSummary,
    error: !!(result.errorDetails),
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────

const COMMANDS = {

  status(session, _args) {
    const reqs = session.data.requests || [];
    const compactions = reqs.filter(r => r.result?.metadata?.summary?.text).length;
    const errors = reqs.filter(r => r.result?.errorDetails).length;
    const lastTs = reqs.at(-1)?.timestamp;
    return {
      sessionId: session.sessionId,
      hash: session.hash,
      format: session.ext,
      entryCount: session.entryCount,
      turns: reqs.length,
      compactions,
      errors,
      lastActivity: lastTs ? new Date(lastTs).toISOString() : null,
      hint: 'Use: ctx turns, ctx compactions, ctx words, ctx tools'
    };
  },

  turns(session, args) {
    const reqs = session.data.requests || [];
    const from = args.from != null ? parseInt(args.from) : Math.max(0, reqs.length - 5);
    const to = args.to != null ? parseInt(args.to) : reqs.length - 1;
    const slice = reqs.slice(from, to + 1).map((r, i) => turnSummary(r, from + i));
    return {
      range: `${from}–${to}`,
      total: reqs.length,
      turns: slice,
      hint: to < reqs.length - 1 ? `More: ctx turns --from ${to + 1}` : 'Use: ctx turn N --full for detail'
    };
  },

  turn(session, args) {
    const reqs = session.data.requests || [];
    let idx = parseInt(args._[0]);
    if (isNaN(idx)) idx = reqs.length - 1;
    const req = reqs[idx];
    if (!req) return { error: `Turn ${idx} not found. Total: ${reqs.length}` };
    const base = turnSummary(req, idx);
    if (!args.full) {
      return { ...base, hint: `Add --full for complete message text and tool details` };
    }
    const toolNames = extractToolNames(req.response);
    const summaryText = req.result?.metadata?.summary?.text?.slice(0, 300);
    return {
      ...base,
      fullMessage: req.message?.text || req.message || '',
      toolNames,
      compactionSummary: summaryText ? summaryText + '…' : null,
    };
  },

  words(session, args) {
    const reqs = session.data.requests || [];
    let pool = reqs;
    if (args.turn != null) {
      pool = [reqs[parseInt(args.turn)]].filter(Boolean);
    } else if (args.range) {
      const [a, b] = args.range.split('-').map(Number);
      pool = reqs.slice(a, b + 1);
    }
    const allText = pool.map(r => r.message?.text || r.message || '').join(' ');
    return {
      scope: args.turn != null ? `turn ${args.turn}` : args.range ? `turns ${args.range}` : 'all',
      sampleSize: pool.length,
      topWords: wordFreq(allText, parseInt(args.top) || 20),
      hint: 'Refine: ctx words --range 0-10 or ctx words --turn N'
    };
  },

  tools(session, args) {
    const reqs = session.data.requests || [];
    let pool = reqs;
    if (args.turn != null) {
      pool = [reqs[parseInt(args.turn)]].filter(Boolean);
    } else if (args.range) {
      const [a, b] = args.range.split('-').map(Number);
      pool = reqs.slice(a, b + 1);
    }
    const freq = {};
    for (const req of pool) {
      for (const name of extractToolNames(req.response)) {
        freq[name] = (freq[name] || 0) + 1;
      }
    }
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1])
      .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
    return {
      scope: args.turn != null ? `turn ${args.turn}` : args.range ? `turns ${args.range}` : 'all',
      sampleSize: pool.length,
      toolFrequency: sorted,
      hint: 'Refine: ctx tools --range 0-10 --turn N'
    };
  },

  compactions(session, _args) {
    const reqs = session.data.requests || [];
    const events = [];
    for (let i = 0; i < reqs.length; i++) {
      const s = reqs[i].result?.metadata?.summary?.text;
      if (s) events.push({
        turn: i,
        ts: reqs[i].timestamp ? new Date(reqs[i].timestamp).toISOString() : null,
        summaryPreview: s.slice(0, 150) + '…',
        toolCallRoundId: reqs[i].result?.metadata?.summary?.toolCallRoundId,
      });
    }
    return {
      total: events.length,
      events,
      hint: events.length ? 'Use: ctx turn N --full to read full compaction summary' : 'No compactions yet'
    };
  },

  models(session, _args) {
    const reqs = session.data.requests || [];
    const freq = {};
    for (const req of reqs) {
      const m = req.model || req.agent?.id || 'unknown';
      freq[m] = (freq[m] || 0) + 1;
    }
    return {
      turns: reqs.length,
      modelBreakdown: freq,
    };
  },
};

// ── CLI parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args[k] = v !== undefined ? v : true;
    } else if (!a.startsWith('-')) {
      args._.push(a);
    }
  }
  return args;
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (!cmd || cmd === 'help') {
    process.stdout.write(JSON.stringify({
      usage: 'ctx <command> [--session=ID] [options]',
      commands: Object.keys(COMMANDS),
      hint: 'ctx status — start here'
    }, null, 2) + '\n');
    return;
  }

  if (!COMMANDS[cmd]) {
    process.stdout.write(JSON.stringify({ error: `Unknown command: ${cmd}`, known: Object.keys(COMMANDS) }) + '\n');
    process.exit(1);
  }

  try {
    const session = loadSession(args.session);
    const result = COMMANDS[cmd](session, args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
    process.exit(1);
  }
}

main();
