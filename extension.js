const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const ANTHROPIC_MODELS_URL  = 'https://platform.claude.com/docs/en/about-claude/models/overview';
const PRICING_CACHE_PATH    = path.join(os.homedir(), '.claude', 'pricing-cache.json');
const CLAUDE_CONFIG_PATH    = path.join(os.homedir(), '.claude.json');
const PRICING_CACHE_TTL_MS  = 24 * 60 * 60 * 1000; // 24 h

let _pricingCache = null; // { fetchedAt, models: { modelId: { input, output, cacheRead, cacheWrite, contextWindow } } }

function readAccountInfo() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, 'utf8'));
    const acc = cfg?.oauthAccount || {};
    return {
      subscriptionCreatedAt:   acc.subscriptionCreatedAt   || null,
      organizationType:        acc.organizationType        || null,
      organizationRateLimitTier: acc.organizationRateLimitTier || null,
    };
  } catch { return {}; }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function fetchText(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const options = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; claude-code-monitor/1.0)' } };
    https.get(url, options, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && maxRedirects > 0) {
        const loc = res.headers.location;
        const target = loc.startsWith('http') ? loc : `https://platform.claude.com${loc}`;
        res.resume();
        return fetchText(target, maxRedirects - 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── Pricing + model registry ──────────────────────────────────────────────────
const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function tableRows(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while ((td = tdRe.exec(tr[1])) !== null) cells.push(stripTags(td[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// "Claude Opus 4.8 (deprecated)" → "claude-opus-4-8"
const toModelId = (name) =>
  name.replace(/\s*\([^)]*\)/g, '').replace(/`/g, '').trim().toLowerCase().replace(/[\s.]+/g, '-');

// Pricing page → { modelId: { input, output, cacheRead, cacheWrite } }
function parsePricingPage(html) {
  const parsePrice = (s) => { const m = s.match(/\$([0-9.]+)\s*\/\s*MTok/i); return m ? parseFloat(m[1]) / 1e6 : null; };
  const result = {};
  for (const cells of tableRows(html)) {
    if (cells.length < 6) continue;
    const name = cells[0];
    if (!name.toLowerCase().includes('claude')) continue;
    const input = parsePrice(cells[1]), output = parsePrice(cells[5]);
    if (!input || !output) continue;
    result[toModelId(name)] = { input, output, cacheRead: parsePrice(cells[4]) || 0, cacheWrite: parsePrice(cells[2]) || 0 };
  }
  return Object.keys(result).length > 0 ? result : null;
}

// Pricing page prose → Set of model IDs known to have 1M context window
// Parses: "Claude X, Claude Y, ... include the full 1M token context window"
function parseOneMegaModels(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const m = text.match(/([A-Za-z0-9,\s.]+?)\s+include\s+the\s+full\s+1[Mm]\s+token\s+context\s+window/i);
  if (!m) return new Set();
  return new Set(
    m[1].split(/,|and\s+/).map(s => toModelId(s.trim())).filter(s => s.includes('claude') || s.includes('opus') || s.includes('sonnet') || s.includes('fable') || s.includes('mythos'))
      .flatMap(id => [id, id.startsWith('claude-') ? id : `claude-${id}`])
  );
}

// Models overview page → { modelAlias: { contextWindow } }
function parseModelsPage(html) {
  const parseCtx = (s) => {
    const m = s.match(/([0-9.]+)\s*(k|M)\s*tokens/i);
    if (!m) return null;
    return m[2].toLowerCase() === 'm' ? Math.round(parseFloat(m[1]) * 1e6) : Math.round(parseFloat(m[1]) * 1e3);
  };
  const normalize = (s) => s.replace(/`|\*/g, '').trim().toLowerCase();
  const result = {};
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tbl;
  while ((tbl = tableRe.exec(html)) !== null) {
    const rows = tableRows(tbl[1]);
    let aliases = null, apiIds = null, contexts = null;
    for (const cells of rows) {
      const label = normalize(cells[0]);
      if (label === 'claude api alias') aliases  = cells.slice(1).map(normalize);
      if (label === 'claude api id')    apiIds   = cells.slice(1).map(normalize);
      if (label === 'context window')   contexts = cells.slice(1);
    }
    if (!contexts) continue;
    const ids = aliases || apiIds; // prefer clean alias; fall back to dated API ID
    if (!ids) continue;
    const n = Math.min(ids.length, contexts.length);
    for (let i = 0; i < n; i++) {
      const id = toModelId(ids[i]);
      const ctx = parseCtx(contexts[i]);
      if (id.includes('claude') && ctx) result[id] = { contextWindow: ctx };
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function loadPricing() {
  if (_pricingCache && (Date.now() - _pricingCache.fetchedAt) < PRICING_CACHE_TTL_MS)
    return _pricingCache.models;

  let stale = null;
  try {
    const disk = JSON.parse(fs.readFileSync(PRICING_CACHE_PATH, 'utf8'));
    if (disk.fetchedAt && (Date.now() - disk.fetchedAt) < PRICING_CACHE_TTL_MS) {
      _pricingCache = disk;
      return disk.models;
    }
    stale = disk.models; // expired but usable if refresh fails
  } catch {}

  try {
    const [pricingHtml, modelsHtml] = await Promise.all([
      fetchText(ANTHROPIC_PRICING_URL),
      fetchText(ANTHROPIC_MODELS_URL),
    ]);
    const pricing = parsePricingPage(pricingHtml);
    const registry = parseModelsPage(modelsHtml);
    const oneMega  = parseOneMegaModels(pricingHtml); // fallback when models page unavailable
    if (pricing) {
      const models = {};
      for (const [id, p] of Object.entries(pricing)) {
        const reg = registry && resolveModel(registry, id);
        let contextWindow = reg?.contextWindow;
        if (!contextWindow) {
          // Use prose-parsed 1M list from pricing page as fallback
          const isOneMega = [...oneMega].some(k => id.startsWith(k) || k.startsWith(id));
          contextWindow = isOneMega ? 1_000_000 : 200_000;
        }
        models[id] = { ...p, contextWindow };
      }
      _pricingCache = { fetchedAt: Date.now(), models };
      try { fs.writeFileSync(PRICING_CACHE_PATH, JSON.stringify(_pricingCache)); } catch {}
      return models;
    }
  } catch {}

  return stale; // null if no cache exists at all
}

function resolveModel(map, modelId) {
  if (!map || !modelId) return null;
  if (map[modelId]) return map[modelId];
  const sorted = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const k of sorted) { if (modelId.startsWith(k)) return map[k]; }
  return null;
}

// ── JSONL scanning ────────────────────────────────────────────────────────────
const projectsDir = path.join(os.homedir(), '.claude', 'projects');

// Claude encodes the workspace path by replacing every '/' with '-'.
function workspaceProjectDir() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const encoded = folders[0].uri.fsPath.replace(/\//g, '-');
  return path.join(projectsDir, encoded);
}

function findMostRecentJsonl() {
  if (!fs.existsSync(projectsDir)) return null;

  // Prefer scoping to the current workspace; fall back to global search.
  const scopedDir = workspaceProjectDir();
  const dirs = (scopedDir && fs.existsSync(scopedDir))
    ? [scopedDir]
    : fs.readdirSync(projectsDir).map(p => path.join(projectsDir, p));

  let bestFile = null, bestTime = 0;
  for (const projDir of dirs) {
    try { if (!fs.statSync(projDir).isDirectory()) continue; } catch { continue; }
    try {
      for (const f of fs.readdirSync(projDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(projDir, f);
        try {
          const mtime = fs.statSync(fp).mtimeMs;
          if (mtime > bestTime) { bestTime = mtime; bestFile = fp; }
        } catch {}
      }
    } catch {}
  }
  return bestFile ? { path: bestFile, mtime: bestTime } : null;
}

function readLastUsage(filePath) {
  const TAIL_BYTES = 16384;
  try {
    const size = fs.statSync(filePath).size;
    const fd   = fs.openSync(filePath, 'r');
    const buf  = Buffer.alloc(Math.min(TAIL_BYTES, size));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - TAIL_BYTES));
    fs.closeSync(fd);
    for (const line of buf.toString('utf8').split('\n').reverse()) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message?.usage)
          return { usage: obj.message.usage, model: obj.message.model || '' };
      } catch {}
    }
  } catch {}
  return null;
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(cost, known) {
  if (!known) return '$?';
  if (cost >= 1)     return `$${cost.toFixed(2)}`;
  if (cost >= 0.001) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

// ── Activate ──────────────────────────────────────────────────────────────────
function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.tooltip = new vscode.MarkdownString('**Claude Code** — loading…');
  item.tooltip.isTrusted = true;
  context.subscriptions.push(item);

  async function refresh() {
    try {
      const cfg            = vscode.workspace.getConfiguration('claudeWatcher');
      const isSubscription = cfg.get('planType', 'subscription') === 'subscription';
      const pfx            = isSubscription ? '~' : '';

      const recent = findMostRecentJsonl();
      if (!recent) {
        item.text = '🤖 Claude: Ready';
        item.backgroundColor = undefined;
        item.show();
        return;
      }

      const ageMinutes = (Date.now() - recent.mtime) / 60000;

      if (ageMinutes > 10) {
        item.text = '🤖 Claude: Idle';
        item.backgroundColor = undefined;
        item.tooltip = buildTooltip(null, isSubscription);
        item.show();
        return;
      }

      const models = await loadPricing();
      const result = readLastUsage(recent.path);
      if (!result) return;

      const { usage, model } = result;
      const inputTokens  = usage.input_tokens                || 0;
      const cacheCreate  = usage.cache_creation_input_tokens || 0;
      const cacheRead    = usage.cache_read_input_tokens     || 0;
      const outputTokens = usage.output_tokens               || 0;

      const pricing    = resolveModel(models, model);
      const windowSize = pricing?.contextWindow || 200_000;
      const usedTokens = inputTokens + cacheCreate + cacheRead;
      const ctxPct     = Math.min(100, Math.round(usedTokens * 100 / windowSize));

      const totalInput = inputTokens + cacheRead;
      const hitRate    = totalInput > 0 ? Math.round(cacheRead * 100 / totalInput) : 0;

      const turnCost = pricing
        ? inputTokens  * pricing.input      +
          cacheCreate  * pricing.cacheWrite  +
          cacheRead    * pricing.cacheRead   +
          outputTokens * pricing.output
        : null;

      const modelLabel  = model.replace(/^claude-/i, '');
      const turnCostStr = fmtCost(turnCost, pricing !== null);

      if      (hitRate >= 70) item.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground');
      else if (hitRate <= 30) item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      else                    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

      item.text = `🤖 ${modelLabel} | Ctx: ${ctxPct}% | Hit: ${hitRate}% | ${pfx}${turnCostStr}`;

      const currentTurn = { inputTokens, cacheCreate, cacheRead, outputTokens,
                            ctxPct, hitRate, windowSize, cost: turnCost, modelLabel };
      item.tooltip = buildTooltip(currentTurn, isSubscription);
      item.show();

    } catch (err) {
      console.debug('Claude watcher error:', err.message);
    }
  }

  function buildTooltip(turn, isSubscription) {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown('### 🤖 Claude Code — Turn Monitor\n\n');

    if (turn) {
      const costLabel = isSubscription ? 'API-equiv cost' : 'Cost';
      md.appendMarkdown(`**Current Turn** · \`${turn.modelLabel}\`\n\n`);
      md.appendMarkdown(`| | |\n|---|---|\n`);
      md.appendMarkdown(`| Context | ${turn.ctxPct}% (${fmtTokens(turn.inputTokens + turn.cacheCreate + turn.cacheRead)} / ${fmtTokens(turn.windowSize)}) |\n`);
      md.appendMarkdown(`| Cache Hit | ${turn.hitRate}% |\n`);
      md.appendMarkdown(`| Input (fresh) | ${fmtTokens(turn.inputTokens)} |\n`);
      md.appendMarkdown(`| Cache write | ${fmtTokens(turn.cacheCreate)} |\n`);
      md.appendMarkdown(`| Cache read | ${fmtTokens(turn.cacheRead)} |\n`);
      md.appendMarkdown(`| Output | ${fmtTokens(turn.outputTokens)} |\n`);
      md.appendMarkdown(`| ${costLabel} | **${fmtCost(turn.cost, turn.cost !== null)}** |\n\n`);
    } else {
      md.appendMarkdown('_No recent Claude activity (last turn > 10 min ago)._\n\n');
    }

    // ── Account info ───────────────────────────────────────────────────────
    const acct = readAccountInfo();
    if (acct.subscriptionCreatedAt || acct.organizationType) {
      md.appendMarkdown('**Plan**\n\n');
      md.appendMarkdown(`| | |\n|---|---|\n`);
      if (acct.organizationType)
        md.appendMarkdown(`| Type | ${acct.organizationType} |\n`);
      if (acct.organizationRateLimitTier)
        md.appendMarkdown(`| Rate tier | ${acct.organizationRateLimitTier} |\n`);
      if (acct.subscriptionCreatedAt) {
        const since = new Date(acct.subscriptionCreatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
        md.appendMarkdown(`| Subscribed since | ${since} |\n`);
      }
      md.appendMarkdown('\n');
    }

    md.appendMarkdown('---\n\n');
    md.appendMarkdown('**Session & weekly usage %** vary with Anthropic\'s server capacity. Run `/usage` in Claude Code for real-time limits.\n\n');
    md.appendMarkdown('Pricing: [Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing) · refreshed daily');

    return md;
  }

  let watcher;
  if (fs.existsSync(projectsDir)) {
    try {
      watcher = fs.watch(projectsDir, { recursive: true }, (_, filename) => {
        if (filename?.endsWith('.jsonl')) refresh();
      });
    } catch {}
  }

  refresh();
  const interval = setInterval(refresh, 10000);

  context.subscriptions.push({ dispose: () => { watcher?.close(); clearInterval(interval); } });
}

function deactivate() {}

module.exports = { activate, deactivate };
