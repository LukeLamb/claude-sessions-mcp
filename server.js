#!/usr/bin/env node
// tmux Sessions MCP server for Claude Desktop (Linux).
// Pure Node, no npm deps. Shells out to `tmux`.
// https://github.com/LukeLamb/claude-sessions-mcp — MIT License.

'use strict';

const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

// ─── System-dep discovery ────────────────────────────────────────────────
function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const BIN = {
  tmux: which('tmux'),
};

// ─── Logging (stderr) ─────────────────────────────────────────────────────
function log(...args) {
  try {
    process.stderr.write('[sessions-mcp] ' + args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ') + '\n');
  } catch (_) {}
}

// ─── JSON-RPC plumbing ────────────────────────────────────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function error(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } });
}
function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireTmux() {
  if (!BIN.tmux) {
    return 'tmux is not installed. Install with: sudo apt install tmux';
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    child.stderr.on('data', (d) => { err = Buffer.concat([err, d]); });
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    child.stdin.end();
    child.on('close', (code) => resolve({
      code,
      stdout: out.toString('utf8'),
      stderr: err.toString('utf8'),
    }));
  });
}

// tmux uses `|` as a common field delimiter in -F format strings. Session
// names can contain virtually any character except `.`, `:`, and whitespace,
// which makes `|` a safe choice — we reject `|` in user-supplied names.
function validSessionName(name) {
  if (typeof name !== 'string' || !name.length) return 'name is required (non-empty string)';
  if (name.length > 100) return 'name too long (max 100)';
  if (/[.:\s|]/.test(name)) return "name cannot contain '.', ':', '|', or whitespace";
  return null;
}

// ─── Tool: list_sessions ──────────────────────────────────────────────────
async function listSessions() {
  const missing = requireTmux();
  if (missing) return errorResult(missing);

  const fmt = '#{session_name}|#{session_windows}|#{session_created}|#{session_attached}|#{session_activity}';
  const r = await run(BIN.tmux, ['list-sessions', '-F', fmt]);
  // "no server running" is the normal empty-state response, not an error.
  if (r.code !== 0) {
    if (/no server running/i.test(r.stderr)) return textResult({ sessions: [] });
    return errorResult(`tmux list-sessions failed: ${r.stderr || r.stdout}`);
  }
  const sessions = r.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, windows, created, attached, activity] = line.split('|');
    return {
      name,
      windows: parseInt(windows, 10),
      created_at: Number(created) ? new Date(Number(created) * 1000).toISOString() : null,
      last_activity_at: Number(activity) ? new Date(Number(activity) * 1000).toISOString() : null,
      attached: attached === '1',
    };
  });
  return textResult({ count: sessions.length, sessions });
}

// ─── Tool: has_session ────────────────────────────────────────────────────
async function hasSession(args) {
  const missing = requireTmux();
  if (missing) return errorResult(missing);
  const bad = validSessionName(args.name);
  if (bad) return errorResult(bad);
  const r = await run(BIN.tmux, ['has-session', '-t', `=${args.name}`]);
  // `=name` asks tmux for an exact match. Exit 0 = exists, 1 = no such session.
  return textResult({ name: args.name, exists: r.code === 0 });
}

// ─── Tool: list_windows ───────────────────────────────────────────────────
async function listWindows(args) {
  const missing = requireTmux();
  if (missing) return errorResult(missing);
  const bad = validSessionName(args.name);
  if (bad) return errorResult(bad);
  const fmt = '#{window_index}|#{window_name}|#{window_active}|#{window_panes}';
  const r = await run(BIN.tmux, ['list-windows', '-t', `=${args.name}`, '-F', fmt]);
  if (r.code !== 0) return errorResult(`tmux list-windows failed: ${r.stderr || r.stdout}`);
  const windows = r.stdout.split('\n').filter(Boolean).map((line) => {
    const [index, name, active, panes] = line.split('|');
    return {
      index: parseInt(index, 10),
      name,
      active: active === '1',
      panes: parseInt(panes, 10),
    };
  });
  return textResult({ session: args.name, count: windows.length, windows });
}

// ─── Tool: capture_pane ───────────────────────────────────────────────────
async function capturePane(args) {
  const missing = requireTmux();
  if (missing) return errorResult(missing);
  const bad = validSessionName(args.name);
  if (bad) return errorResult(bad);
  const lines = Math.max(1, Math.min(10000, Math.floor(args.lines ?? 100)));
  // `-p` prints to stdout, `-S -<N>` starts N lines before the bottom of the
  // scrollback, `-J` joins wrapped lines, `-t =<name>` targets the session's
  // active pane.
  // `=NAME:` targets the session's active window + active pane with exact name match.
  // `=NAME` (no colon) is a session target and fails on capture-pane which needs a pane.
  const r = await run(BIN.tmux, ['capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', `=${args.name}:`]);
  if (r.code !== 0) return errorResult(`tmux capture-pane failed: ${r.stderr || r.stdout}`);
  // Trim trailing blank lines from the visible-pane snapshot; they're just
  // empty rows below the cursor and add noise.
  const text = r.stdout.replace(/\n+$/, '');
  return textResult({ session: args.name, lines, text });
}

// ─── Tool: new_session ────────────────────────────────────────────────────
async function newSession(args) {
  const missing = requireTmux();
  if (missing) return errorResult(missing);
  const bad = validSessionName(args.name);
  if (bad) return errorResult(bad);

  // Check for an existing session first — tmux would error with "duplicate
  // session" but the error text varies across versions; our own check is
  // clearer for the caller.
  const existing = await run(BIN.tmux, ['has-session', '-t', `=${args.name}`]);
  if (existing.code === 0) {
    return errorResult(`session "${args.name}" already exists. Use kill_session first or pick a different name.`);
  }

  // Always start a shell (no explicit command arg) so the session survives
  // after the initial command finishes. If `command` is provided, send it as
  // keystrokes so it runs inside the shell — respecting aliases, venvs,
  // functions, etc.
  const createArgs = ['new-session', '-d', '-s', args.name];
  if (args.cwd && typeof args.cwd === 'string') {
    createArgs.push('-c', args.cwd);
  }
  const created = await run(BIN.tmux, createArgs);
  if (created.code !== 0) {
    return errorResult(`tmux new-session failed: ${created.stderr || created.stdout}`);
  }

  if (args.command && typeof args.command === 'string' && args.command.trim()) {
    const r = await run(BIN.tmux, ['send-keys', '-t', `=${args.name}:`, args.command, 'Enter']);
    if (r.code !== 0) {
      return errorResult(`session created, but send-keys failed: ${r.stderr || r.stdout}`);
    }
  }

  return textResult({
    name: args.name,
    cwd: args.cwd || null,
    command: args.command || null,
    status: 'running',
    hint: `Use capture_pane name="${args.name}" to check output; tmux attach -t "${args.name}" from a real terminal to watch live.`,
  });
}

// ─── Tool: send_keys ──────────────────────────────────────────────────────
async function sendKeys(args) {
  const missing = requireTmux();
  if (missing) return errorResult(missing);
  const bad = validSessionName(args.name);
  if (bad) return errorResult(bad);
  if (typeof args.keys !== 'string' || !args.keys.length) {
    return errorResult('keys is required (non-empty string)');
  }
  // When `enter` is true (default for text input), append an Enter keypress.
  // For raw key combos like 'C-c' you usually want enter=false.
  const appendEnter = args.enter !== false;
  // `=NAME:` targets the session's active pane with exact name match.
  const cmd = ['send-keys', '-t', `=${args.name}:`, args.keys];
  if (appendEnter) cmd.push('Enter');
  const r = await run(BIN.tmux, cmd);
  if (r.code !== 0) return errorResult(`tmux send-keys failed: ${r.stderr || r.stdout}`);
  return textResult({ session: args.name, keys: args.keys, enter: appendEnter });
}

// ─── Tool: kill_session ───────────────────────────────────────────────────
async function killSession(args) {
  const missing = requireTmux();
  if (missing) return errorResult(missing);
  const bad = validSessionName(args.name);
  if (bad) return errorResult(bad);
  const r = await run(BIN.tmux, ['kill-session', '-t', `=${args.name}`]);
  if (r.code !== 0) {
    if (/can't find session|session not found/i.test(r.stderr)) {
      return errorResult(`session "${args.name}" does not exist`);
    }
    return errorResult(`tmux kill-session failed: ${r.stderr || r.stdout}`);
  }
  return textResult({ session: args.name, killed: true });
}

// ─── Tool registry ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'list_sessions',
    description: 'List all tmux sessions on the current user\'s tmux server. Returns name, window count, created/activity timestamps (ISO 8601), and attached status. Returns an empty list when no tmux server is running.',
    annotations: { title: 'List tmux sessions', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'has_session',
    description: 'Check whether a named tmux session exists. Cheap precondition for capture_pane, send_keys, or kill_session.',
    annotations: { title: 'Check session exists', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name. Cannot contain ".", ":", "|", or whitespace.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_windows',
    description: 'List windows within a named session (index, name, active flag, pane count).',
    annotations: { title: 'List session windows', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'capture_pane',
    description: 'Capture the last N lines visible in the session\'s active pane (default 100, max 10000). Returns the joined text. The primary primitive for "is my training still running? show me the latest output".',
    annotations: { title: 'Capture pane output', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name.' },
        lines: { type: 'integer', minimum: 1, maximum: 10000, description: 'Number of lines to capture (default 100).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'new_session',
    description: 'Start a new detached tmux session. Always starts a shell (so the session survives after the initial command finishes). If `command` is given, it is sent to the shell as keystrokes + Enter, so aliases, venvs, and functions work as expected. Errors if the session name already exists.',
    annotations: { title: 'Start tmux session', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name (unique). Cannot contain ".", ":", "|", or whitespace.' },
        command: { type: 'string', description: 'Optional initial command to run inside the shell (e.g. "cd /path && python train.py").' },
        cwd: { type: 'string', description: 'Optional starting working directory for the session.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_keys',
    description: 'Send key combos or text to the session\'s active pane. Use for interrupts (C-c), end-of-input (C-d), or typing a command. Text is sent literally. Enter is appended by default; set enter=false for raw key combos.',
    annotations: { title: 'Send keys to session', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name.' },
        keys: { type: 'string', description: 'Key combo (e.g. "C-c", "C-d", "Escape") or literal text to type.' },
        enter: { type: 'boolean', description: 'Append an Enter keypress after the keys. Default true.' },
      },
      required: ['name', 'keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'kill_session',
    description: 'Terminate a named tmux session. Any processes running inside are sent SIGHUP by tmux. Errors if the session does not exist.',
    annotations: { title: 'Kill tmux session', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  list_sessions: listSessions,
  has_session: hasSession,
  list_windows: listWindows,
  capture_pane: capturePane,
  new_session: newSession,
  send_keys: sendKeys,
  kill_session: killSession,
};

// ─── JSON-RPC dispatch ────────────────────────────────────────────────────
// Newest first. Echo the client's requested version when we support it,
// otherwise offer our latest and let the client decide.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(msg.params && msg.params.protocolVersion)
        ? msg.params.protocolVersion
        : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'sessions-mcp', version: '0.1.1' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') { respond(id, {}); return; }
  if (method === 'tools/list') { respond(id, { tools: TOOLS }); return; }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    const handler = HANDLERS[name];
    if (!handler) { error(id, -32601, `unknown tool: ${name}`); return; }
    try {
      const result = await Promise.resolve(handler(args));
      respond(id, result);
    } catch (e) {
      log('tool error:', name, e.message, e.stack);
      respond(id, errorResult(`tool ${name} threw: ${e.message}`));
    }
    return;
  }

  if (id !== undefined && id !== null) error(id, -32601, `method not found: ${method}`);
}

// ─── Main loop ────────────────────────────────────────────────────────────
let inflight = 0;
let stdinClosed = false;
function maybeExit() { if (stdinClosed && inflight === 0) process.exit(0); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (e) { log('bad JSON on stdin:', e.message); return; }
  inflight++;
  handle(msg)
    .catch((e) => {
      log('handler crash:', e.message, e.stack);
      if (msg && msg.id !== undefined) error(msg.id, -32603, e.message);
    })
    .finally(() => { inflight--; maybeExit(); });
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log('server started, pid', process.pid, 'tmux=' + (BIN.tmux || 'MISSING'));
