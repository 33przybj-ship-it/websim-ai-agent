#!/usr/bin/env node
/**
 * websim AI agent v2.1 — Queue-based daemon
 * 
 * Processes edits ONE AT A TIME in FIFO order (Endoxidev always front).
 * Announces queue positions every minute so users don't spam-repeat requests.
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const fs = require('fs');
const nodePath = require('path');
require('dotenv').config();

// ── Config ─────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:   (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  apiKey:    process.env.OPENAI_API_KEY || '',
  model:     'claude-opus-4-8-20260501', // force Opus 4.8
  maxTurns:  parseInt(process.env.AGENT_MAX_TURNS || '15', 10),
  debug:     process.env.AGENT_DEBUG === 'true',
  watchIntervalMs: parseInt(process.env.AGENT_WATCH_INTERVAL_SECONDS || '10', 10) * 1000,
  queueAnnounceMs: 60000, // announce positions every 60s
  botUsername: process.env.WEBSIM_BOT_USERNAME || 'Opus_4_8',
};

const RANDOM_QUOTES = [
  "Good things come to those who wait! 🌟",
  "Cooking up something special... 🍳",
  "The AI is thinking really hard right now! 🧠",
  "Quality takes time! ⏳",
  "Your patience is legendary! 👑",
  "Building with love and circuits... ❤️",
  "Rome wasn't built in a day! 🏛️",
  "Every masterpiece needs its time... 🎨",
  "Good code is worth the wait! 💻",
  "Hang tight, magic incoming! ✨",
];

function log(...args) { if (CONFIG.debug) console.error('[agent]', ...args); }

const PROJECTS_CONFIG_PATH = nodePath.join(__dirname, 'projects.config.json');
function loadProjectsConfig() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_CONFIG_PATH, 'utf8')); }
  catch { return { projects: {}, defaultProject: null }; }
}

// ── MCP Connection ─────────────────────────────────────────────────
let mcpClient = null;
let mcpTransport = null;
let mcpTools = [];

async function startMCP() {
  mcpTransport = new StdioClientTransport({
    command: 'node', args: [nodePath.join(__dirname, 'mcp-server.js')],
    env: { ...process.env }, stderr: 'pipe',
  });
  mcpTransport.stderr?.on('data', d => { const m = d.toString().trim(); if (m) console.error('[mcp]', m); });
  mcpClient = new Client({ name: 'websim-agent', version: '2.1.0' }, { capabilities: {} });
  await mcpClient.connect(mcpTransport);
  const r = await mcpClient.listTools();
  mcpTools = r.tools || [];
  log(`Connected. ${mcpTools.length} tools.`);
}

async function stopMCP() {
  try { if (mcpClient) await mcpClient.close(); } catch {}
  mcpClient = null; mcpTransport = null; mcpTools = [];
}

// ── Tool conversion ────────────────────────────────────────────────
function mcpToolToOpenAI(tool) {
  const props = {}, required = [];
  if (tool.inputSchema?.properties) {
    for (const [k, s] of Object.entries(tool.inputSchema.properties)) {
      props[k] = { type: s.type || 'string', description: s.description || '' };
      if (s.enum) props[k].enum = s.enum;
    }
    required.push(...(tool.inputSchema.required || []));
  }
  return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: { type: 'object', properties: props, required } } };
}

// ── API call ───────────────────────────────────────────────────────
async function callModel(messages, tools) {
  const body = { model: CONFIG.model, messages, max_tokens: 4096 };
  if (tools && tools.length > 0) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch(CONFIG.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ── Agent loop ─────────────────────────────────────────────────────
async function runAgent(prompt, projectAlias) {
  const tools = mcpTools.map(mcpToolToOpenAI);
  const guide = loadClaudeGuide();
  const guideSection = guide ? `\n\nGUIDE (from CLAUDE.md):\n${guide.slice(0, 3000)}\n` : '';
  const messages = [
    { role: 'system', content: `You edit a websim.com project. Use TOOLS — never just describe changes in prose. Only upload_file + finish_revision + set_current_revision actually change the live project.

WORKFLOW:
1. list_revisions → find latest version
2. create_revision(parent_version=latest) → new draft
3. download_file → read current contents (returned inline)
4. write_file → stage your edits locally
5. upload_file → push to websim
6. finish_revision → publish (MANDATORY after uploading!)
7. set_current_revision → make it live
Then stop and give a 1-2 sentence summary.

Default project alias: "${projectAlias || 'default'}". Always start with list_revisions.${guideSection}` },
    { role: 'user', content: prompt },
  ];

  console.log(`\n🤖 Building: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  const MUTATING = new Set(['upload_file', 'finish_revision', 'set_current_revision', 'delete_file', 'create_revision']);
  let edited = false;
  let published = false;

  for (let turn = 0; turn < CONFIG.maxTurns; turn++) {
    const response = await callModel(messages, tools);
    const msg = response.choices?.[0]?.message;
    if (!msg) { console.log('⚠️ Empty response.'); break; }
    const toolCalls = msg.tool_calls || [];

    if (toolCalls.length === 0) {
      if (edited && !published) {
        console.log('   ⚠️ Files uploaded but NOT published — prompting to finish.');
        messages.push({ role: 'user', content: 'You uploaded files but did NOT call finish_revision or set_current_revision. The changes are NOT live! Call finish_revision and set_current_revision NOW.' });
        continue;
      }
      const summary = (msg.content || '').trim();
      if (summary) console.log(summary.slice(0, 400));
      messages.push({ role: 'assistant', content: summary });
      console.log(edited ? '✅ Published live.' : '⚠️ No changes made.');
      return { ok: edited, summary, edited };
    }

    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      if (!args.project && projectAlias) args.project = projectAlias;
      if (MUTATING.has(name)) edited = true;
      if (name === 'finish_revision') published = true;

      console.log(`   🔧 ${name}(${JSON.stringify(args).slice(0, 100)})`);
      let result;
      try {
        const res = await mcpClient.callTool({ name, arguments: args });
        result = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        console.log(`   ↳ ${result.slice(0, 200)}`);
      } catch (err) {
        result = `Error: ${err.message}`;
        console.error(`   ❌ ${err.message}`);
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  console.log(`⚠️ Max turns (${CONFIG.maxTurns}) reached.`);
  return { ok: edited, summary: '', edited };
}

// ── CLAUDE.md loader ───────────────────────────────────────────────
let _claudeGuide = '';
function loadClaudeGuide() {
  if (_claudeGuide) return _claudeGuide;
  try { _claudeGuide = fs.readFileSync(nodePath.join(__dirname, 'CLAUDE.md'), 'utf8'); log('Loaded CLAUDE.md'); }
  catch { _claudeGuide = ''; }
  return _claudeGuide;
}

// ── Comment helpers ────────────────────────────────────────────────
function extractCommentText(comment) {
  const raw = comment.raw_content || '';
  if (raw.trim()) return raw.trim();
  if (typeof comment.content === 'object' && comment.content?.children) {
    const parts = [];
    (function walk(nodes) { for (const n of nodes) { if (n.text) parts.push(n.text); if (n.children) walk(n.children); } })(comment.content.children);
    return parts.join(' ').trim();
  }
  return '';
}

// ── Triage ─────────────────────────────────────────────────────────
const TRIAGE_SYSTEM_PROMPT = `You triage comments for a websim project. Decide if a comment is worth building.

Respond JSON ONLY:
{
  "category": "feature_request|bug_fix|ui_change|content_change|question|praise|spam|abuse|greeting|unclear",
  "actionable": true,
  "reasoning": "why",
  "decisionReply": "public reply — friendly, 1-3 sentences",
  "editPrompt": "precise implementation instructions if actionable"
}

RULES:
- Default to actionable unless clearly spam/abuse
- Vague requests: interpret generously
- Questions: answer helpfully, redirect to builds
- Greetings: welcome, ask what to build
- Link-only/no-content: spam`;

async function triageComment(comment) {
  const content = extractCommentText(comment);
  const author = comment.author?.username || comment.profiles?.username || 'someone';

  const guide = loadClaudeGuide();
  const ctx = guide ? `\nPROJECT CONTEXT:\n${guide.slice(0, 3000)}` : '';

  const res = await callModel([
    { role: 'system', content: TRIAGE_SYSTEM_PROMPT + ctx },
    { role: 'user', content: `Comment from @${author}: ${content}` },
  ], []);

  try {
    const d = JSON.parse((res.choices?.[0]?.message?.content||'').replace(/```json|```/g, '').trim());
    return { category: d.category||'unclear', actionable: !!d.actionable, reasoning: d.reasoning||'', decisionReply: d.decisionReply||'', editPrompt: d.editPrompt||'' };
  } catch {
    return { category:'unclear', actionable:false, reasoning:'parse error', decisionReply:'', editPrompt:'' };
  }
}

// ── Daemon State ───────────────────────────────────────────────────
const BOT_STATE_PATH = nodePath.join(__dirname, 'comment-bot-seen.json');
const STATE_MAX_AGE_DAYS = parseInt(process.env.AGENT_STATE_MAX_AGE_DAYS || '90', 10);

function loadBotState() {
  try {
    const s = JSON.parse(fs.readFileSync(BOT_STATE_PATH, 'utf8'));
    if (!s.entries) s.entries = {};
    if (!s.queue) s.queue = [];
    if (!s.checklist) s.checklist = [];
    return s;
  } catch {
    return { entries: {}, queue: [], checklist: [], currentlyProcessing: null, lastAnnounce: null, lastRun: null };
  }
}
function saveBotState(state) { fs.writeFileSync(BOT_STATE_PATH, JSON.stringify(state, null, 2)); }

// ── Queue System ───────────────────────────────────────────────────
function addToQueue(state, comment) {
  const author = comment.author?.username || '';
  const content = extractCommentText(comment);

  // Skip empty or already queued
  if (!content.trim()) return;
  if (state.queue.find(q => q.commentId === comment.id)) return;

  const item = { commentId: comment.id, author, content: content.slice(0, 200), addedAt: new Date().toISOString() };

  // Endoxidev always jumps to front
  if (author === 'Endoxidev') {
    state.queue.unshift(item);
    console.log(`   ⭐ @Endoxidev → queue position #1 (priority)`);
  } else {
    state.queue.push(item);
    const pos = state.queue.length;
    console.log(`   📥 @${author} → queue position #${pos}`);
  }
}

async function announceQueuePositions(projectAlias, state) {
  if (state.queue.length === 0) return;
  const now = Date.now();
  const last = state.lastAnnounce ? new Date(state.lastAnnounce).getTime() : 0;
  if (now - last < CONFIG.queueAnnounceMs) return;

  console.log(`   📢 Announcing queue positions (${state.queue.length} waiting)...`);
  const WIP = '⚠️ *Heads up — heavy work in progress!*\n\n';

  for (let i = 0; i < state.queue.length; i++) {
    const item = state.queue[i];
    const quote = RANDOM_QUOTES[Math.floor(Math.random() * RANDOM_QUOTES.length)];
    const msg = `${WIP}Your spot in the generation queue: **#${i + 1}**. Please be patient!\n\n> ${quote}`;
    try {
      await mcpClient.callTool({ name: 'post_reply', arguments: { project: projectAlias, comment_id: item.commentId, content: msg } });
    } catch {}
    if (i < state.queue.length - 1) await new Promise(r => setTimeout(r, 2000)); // rate limit
  }

  state.lastAnnounce = new Date().toISOString();
  saveBotState(state);
}

async function processNextInQueue(projectAlias, state) {
  if (state.queue.length === 0) return;
  if (state.currentlyProcessing) return; // already working on something

  const item = state.queue.shift();
  state.currentlyProcessing = item.commentId;
  saveBotState(state);

  console.log(`\n🛠️  Processing queue #1 (was waiting): @${item.author}: "${item.content.slice(0, 80)}..."`);

  // Triage + Build
  const comment = { id: item.commentId, content: item.content, raw_content: item.content, author: { username: item.author } };

  const WIP = '⚠️ *Heads up — heavy work in progress! Pardon our dust.*\n\n';

  console.log('   🧠 Reasoning...');
  const decision = await triageComment(comment);

  const emojis = { feature_request:'✨', bug_fix:'🐛', ui_change:'🎨', content_change:'✏️', question:'❓', praise:'❤️', spam:'🗑️', abuse:'🚫', greeting:'👋', unclear:'🤷' };
  console.log(`   ${emojis[decision.category]||'📌'} ${decision.category} → ${decision.actionable ? 'BUILD' : 'PASS'}`);
  console.log(`   ↳ ${decision.reasoning}`);

  // Reply with decision
  try {
    const reply = WIP + (decision.decisionReply || (decision.actionable ? "Great idea! I'll build this now." : "Thanks for the comment!"));
    await mcpClient.callTool({ name: 'post_reply', arguments: { project: projectAlias, comment_id: item.commentId, content: reply } });
    console.log('   💬 Decision reply sent.');
  } catch (err) { console.error(`   ⚠️ Reply failed: ${err.message}`); }

  // Build if actionable
  if (decision.actionable && decision.editPrompt) {
    console.log(`   🛠️  Building...`);
    try {
      const result = await runAgent(decision.editPrompt, projectAlias);
      state.checklist.push({ what: decision.editPrompt, category: decision.category, commentId: item.commentId, author: item.author, at: new Date().toISOString() });
      state.entries[item.commentId] = { id: item.commentId, category: decision.category, at: new Date().toISOString(), reasoning: decision.reasoning, built: result.ok };

      const done = `${WIP}✅ Done! Refresh to see the changes.\n\n> ${decision.reasoning}\n\nLet me know if you want tweaks!`;
      await mcpClient.callTool({ name: 'post_reply', arguments: { project: projectAlias, comment_id: item.commentId, content: done } });
      console.log('   ✅ Build complete + done reply.');
    } catch (err) {
      console.error(`   ❌ Build failed: ${err.message}`);
      try {
        await mcpClient.callTool({ name: 'post_reply', arguments: { project: projectAlias, comment_id: item.commentId, content: `${WIP}😅 Hit a snag: ${err.message.slice(0, 150)}. Trying a different approach...` } });
      } catch {}
    }
  }

  state.entries[item.commentId] = state.entries[item.commentId] || { id: item.commentId, category: decision.category, at: new Date().toISOString() };
  state.currentlyProcessing = null;
  saveBotState(state);

  // Immediately process next if any
  if (state.queue.length > 0) {
    console.log(`   📋 ${state.queue.length} more in queue — processing next...`);
    await processNextInQueue(projectAlias, state);
  }
}

// ── Daemon Loop ────────────────────────────────────────────────────
async function daemonLoop(projectAlias) {
  const state = loadBotState();
  // Clear any stale processing state from crash
  if (state.currentlyProcessing) state.currentlyProcessing = null;
  saveBotState(state);

  const intervalSec = Math.round(CONFIG.watchIntervalMs / 1000);
  console.log(`\n🤖 Daemon v2.1 started | Model: ${CONFIG.model} | Poll: ${intervalSec}s | Queue announce: ${CONFIG.queueAnnounceMs/1000}s`);
  console.log(`   Queue: ${state.queue.length} waiting | Built: ${state.checklist.length} items | Priority: @Endoxidev\n`);

  await pollAndEnqueue(projectAlias, state);

  // Poll loop
  const pollTimer = setInterval(() => pollAndEnqueue(projectAlias, state), CONFIG.watchIntervalMs);
  // Announce loop
  const announceTimer = setInterval(() => announceQueuePositions(projectAlias, state), CONFIG.queueAnnounceMs);

  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    clearInterval(pollTimer);
    clearInterval(announceTimer);
    state.currentlyProcessing = null;
    saveBotState(state);
    await stopMCP();
    process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

async function pollAndEnqueue(projectAlias, state) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    const res = await mcpClient.callTool({ name: 'list_comments', arguments: { project: projectAlias, limit: 50 } });
    const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    let comments;
    try { const p = JSON.parse(text); comments = p.comments || p; } catch { comments = []; }
    if (!Array.isArray(comments)) comments = [];

    const foreign = comments.filter(c => (c.author?.username || '') !== CONFIG.botUsername);
    const selfCount = comments.length - foreign.length;

    const newComments = foreign.filter(c => !state.entries[c.id] && !state.queue.find(q => q.commentId === c.id));

    for (const c of newComments) {
      state.entries[c.id] = { id: c.id, category: 'queued', at: new Date().toISOString(), author: c.author?.username };
      addToQueue(state, c);
    }
    saveBotState(state);

    if (newComments.length > 0) {
      const sn = selfCount > 0 ? ` (${selfCount} self skipped)` : '';
      console.log(`[${ts}] ${newComments.length} new → queue now ${state.queue.length}${sn}`);
    }

    // Try to process next item
    if (!state.currentlyProcessing && state.queue.length > 0) {
      await processNextInQueue(projectAlias, state);
    }

    state.lastRun = new Date().toISOString();
    saveBotState(state);
  } catch (err) {
    console.error(`[${ts}] ⚠️ ${err.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  let projectAlias = null, prompt = '', interactive = false, watch = false, listProjects = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' || args[i] === '-p') projectAlias = args[++i];
    else if (args[i] === '--interactive' || args[i] === '-i') interactive = true;
    else if (args[i] === '--watch' || args[i] === '-w' || args[i] === '--daemon') watch = true;
    else if (args[i] === '--list-projects') listProjects = true;
    else if (args[i] === '--help' || args[i] === '-h') { console.log('USAGE: node agent.js [--watch] [--project <alias>] [--interactive] ["prompt"]'); process.exit(0); }
    else prompt += (prompt ? ' ' : '') + args[i];
  }

  if (listProjects) {
    const c = loadProjectsConfig();
    console.log(JSON.stringify(Object.entries(c.projects||{}).map(([k,v])=>({alias:k,id:v.id,slug:v.slug,label:v.label,isDefault:k===c.defaultProject})),null,2));
    process.exit(0);
  }
  if (!CONFIG.apiKey) { console.error('❌ OPENAI_API_KEY not set in .env'); process.exit(1); }

  try { await startMCP(); } catch (err) { console.error('❌ MCP failed:', err.message); process.exit(1); }

  process.on('SIGINT', async () => { await stopMCP(); process.exit(0); });

  if (watch) { await daemonLoop(projectAlias); return; }
  if (interactive || !prompt) { console.log('Interactive mode — not implemented in v2.1. Use --watch for daemon.'); await stopMCP(); return; }

  try { await runAgent(prompt, projectAlias); } catch (err) { console.error(`\n❌ ${err.message}`); } finally { await stopMCP(); }
}

main().catch(async e => { console.error('Fatal:', e); await stopMCP(); process.exit(1); });
