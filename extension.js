const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICING_CACHE_PATH = path.join(os.homedir(), '.claude', 'pricing-cache.json');
const PRICING_CACHE_TTL_MS  = 24 * 60 * 60 * 1000; // 24 h
const AGGREGATE_CACHE_TTL_MS =  5 * 60 * 1000;      //  5 min

let _pricingCache   = null; // { fetchedAt, models }
let _aggregateCache = null; // { fiveHr, weekly, computedAt }

// ── HTTP helper ───────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ── Pricing ───────────────────────────────────────────────────────────────────
async function loadPricing() {
  if (_pricingCache && (Date.now() - _pricingCache.fetchedAt) < PRICING_CACHE_TTL_MS)
    return _pricingCache.models;

  try {
    const disk = JSON.parse(fs.readFileSync(PRICING_CACHE_PATH, 'utf8'));
    if (disk.fetchedAt && (Date.now() - disk.fetchedAt) < PRICING_CACHE_TTL_MS) {
      _pricingCache = disk;
      return disk.models;
    }
  } catch {}

  try {
    const raw = await fetchJson(LITELLM_PRICING_URL);
    const models = {};
    for (const [key, v] of Object.entries(raw)) {
      if (!v.input_cost_per_token) continue;
      if (/^(us|eu|au|jp)\./.test(key)) continue;
      models[key] = {
        input:          v.input_cost_per_token,
        output:         v.output_cost_per_token           || 0,
        cacheRead:      v.cache_read_input_token_cost      || 0,
        cacheWrite:     v.cache_creation_input_token_cost  || 0,
        maxInputTokens: v.max_input_tokens                 || 200000,
      };
    }
    _pricingCache = { fetchedAt: Date.now(), models };
    try { fs.writeFileSync(PRICING_CACHE_PATH, JSON.stringify(_pricingCache)); } catch {}
    return models;
  } catch {
    return null;
  }
}

function resolvePricing(models, modelId) {
  if (!models || !modelId) return null;
  const tries = [modelId, `anthropic.${modelId}`, ...Object.keys(models).filter((k) => k.includes(modelId))];
  for (const key of tries) { if (models[key]) return models[key]; }
  return null;
}

function calcCost(entry, models) {
  const p = resolvePricing(models, entry.model);
  if (!p) return null;
  return entry.input      * p.input     +
         entry.cacheWrite * p.cacheWrite +
         entry.cacheRead  * p.cacheRead  +
         entry.output     * p.output;
}

// ── JSONL scanning ────────────────────────────────────────────────────────────
const projectsDir = path.join(os.homedir(), '.claude', 'projects');

function findMostRecentJsonl() {
  if (!fs.existsSync(projectsDir)) return null;
  let bestFile = null, bestTime = 0;
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const projDir = path.join(projectsDir, proj);
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
  } catch {}
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

// Read every assistant usage entry across all JSONL files modified since cutoffMs.
function readAllUsageSince(cutoffMs) {
  const entries = [];
  if (!fs.existsSync(projectsDir)) return entries;
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const projDir = path.join(projectsDir, proj);
      try { if (!fs.statSync(projDir).isDirectory()) continue; } catch { continue; }
      try {
        for (const f of fs.readdirSync(projDir)) {
          if (!f.endsWith('.jsonl')) continue;
          const fp = path.join(projDir, f);
          try {
            if (fs.statSync(fp).mtimeMs < cutoffMs) continue; // skip old files
            const content = fs.readFileSync(fp, 'utf8');
            for (const line of content.split('\n')) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line);
                if (obj.type !== 'assistant') continue;
                const usage = obj.message?.usage;
                const ts    = obj.timestamp;
                if (!usage || !ts) continue;
                const t = new Date(ts).getTime();
                if (t < cutoffMs) continue;
                entries.push({
                  time:       t,
                  model:      obj.message?.model || '',
                  input:      usage.input_tokens                  || 0,
                  cacheWrite: usage.cache_creation_input_tokens   || 0,
                  cacheRead:  usage.cache_read_input_tokens       || 0,
                  output:     usage.output_tokens                 || 0,
                });
              } catch {}
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return entries;
}

function summariseEntries(entries, models) {
  let cost = 0, costKnown = false;
  let inp = 0, cw = 0, cr = 0, out = 0;
  for (const e of entries) {
    inp += e.input;  cw += e.cacheWrite;  cr += e.cacheRead;  out += e.output;
    const c = calcCost(e, models);
    if (c !== null) { cost += c; costKnown = true; }
  }
  const totalTokens = inp + cw + cr + out;
  const allInput    = inp + cr;
  const hitRate     = allInput > 0 ? Math.round(cr * 100 / allInput) : 0;
  return { turns: entries.length, totalTokens, hitRate, cost, costKnown };
}

async function computeAggregate(models) {
  const now          = Date.now();
  const fiveHrCutoff = now - 5 * 3600 * 1000;
  const weekCutoff   = now - 7 * 24 * 3600 * 1000;

  const weekEntries  = readAllUsageSince(weekCutoff);
  const fiveHrEntries = weekEntries.filter((e) => e.time >= fiveHrCutoff);

  return {
    fiveHr:     summariseEntries(fiveHrEntries, models),
    weekly:     summariseEntries(weekEntries,   models),
    computedAt: now,
  };
}

// ── Formatting helpers ────────────────────────────────────────────────────────
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(cost, known) {
  if (!known) return '$?';
  if (cost >= 1)      return `$${cost.toFixed(2)}`;
  if (cost >= 0.001)  return `$${cost.toFixed(3)}`;
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
      const recent = findMostRecentJsonl();
      if (!recent) {
        item.text = '🤖 Claude: Ready';
        item.backgroundColor = undefined;
        item.show();
        return;
      }

      const ageMinutes = (Date.now() - recent.mtime) / 60000;
      const models     = await loadPricing();

      // ── Aggregate (5 h + weekly) — recomputed every 5 min ─────────────────
      if (!_aggregateCache || (Date.now() - _aggregateCache.computedAt) >= AGGREGATE_CACHE_TTL_MS) {
        _aggregateCache = await computeAggregate(models);
      }
      const { fiveHr, weekly } = _aggregateCache;

      // ── Current turn ───────────────────────────────────────────────────────
      if (ageMinutes > 10) {
        const fiveHrStr = fmtCost(fiveHr.cost, fiveHr.costKnown);
        const weekStr   = fmtCost(weekly.cost, weekly.costKnown);
        item.text = `🤖 Claude: Idle | 5h: ${fiveHrStr} | 7d: ${weekStr}`;
        item.backgroundColor = undefined;
        item.tooltip = buildTooltip(null, fiveHr, weekly);
        item.show();
        return;
      }

      const result = readLastUsage(recent.path);
      if (!result) return;

      const { usage, model } = result;
      const inputTokens  = usage.input_tokens                  || 0;
      const cacheCreate  = usage.cache_creation_input_tokens   || 0;
      const cacheRead    = usage.cache_read_input_tokens       || 0;
      const outputTokens = usage.output_tokens                 || 0;

      const pricing    = resolvePricing(models, model);
      const windowSize = pricing?.maxInputTokens || 200000;
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

      const modelLabel   = model.replace(/^claude-/i, '');
      const turnCostStr  = fmtCost(turnCost, pricing !== null);
      const fiveHrStr    = fmtCost(fiveHr.cost, fiveHr.costKnown);
      const weekStr      = fmtCost(weekly.cost, weekly.costKnown);

      if      (hitRate >= 70) item.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground');
      else if (hitRate <= 30) item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      else                    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

      item.text = `🤖 ${modelLabel} | Ctx: ${ctxPct}% | Hit: ${hitRate}% | ${turnCostStr} | 5h: ${fiveHrStr} | 7d: ${weekStr}`;

      const currentTurn = { inputTokens, cacheCreate, cacheRead, outputTokens,
                            ctxPct, hitRate, windowSize, cost: turnCost, model, modelLabel };
      item.tooltip = buildTooltip(currentTurn, fiveHr, weekly);
      item.show();

    } catch (err) {
      console.debug('Claude watcher error:', err.message);
    }
  }

  function buildTooltip(turn, fiveHr, weekly) {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown('### 🤖 Claude Code — Usage & Cost\n\n');

    if (turn) {
      md.appendMarkdown(`**Current Turn** · \`${turn.modelLabel}\`\n\n`);
      md.appendMarkdown(`| | |\n|---|---|\n`);
      md.appendMarkdown(`| Context | ${turn.ctxPct}% (${fmtTokens(turn.inputTokens + turn.cacheCreate + turn.cacheRead)} / ${fmtTokens(turn.windowSize)}) |\n`);
      md.appendMarkdown(`| Cache Hit | ${turn.hitRate}% |\n`);
      md.appendMarkdown(`| Input (fresh) | ${fmtTokens(turn.inputTokens)} |\n`);
      md.appendMarkdown(`| Cache write | ${fmtTokens(turn.cacheCreate)} |\n`);
      md.appendMarkdown(`| Cache read | ${fmtTokens(turn.cacheRead)} |\n`);
      md.appendMarkdown(`| Output | ${fmtTokens(turn.outputTokens)} |\n`);
      md.appendMarkdown(`| Turn cost | **${fmtCost(turn.cost, turn.cost !== null)}** |\n\n`);
    }

    md.appendMarkdown(`**Last 5 Hours** · ${fiveHr.turns} turns\n\n`);
    md.appendMarkdown(`| | |\n|---|---|\n`);
    md.appendMarkdown(`| Total tokens | ${fmtTokens(fiveHr.totalTokens)} |\n`);
    md.appendMarkdown(`| Cache hit rate | ${fiveHr.hitRate}% |\n`);
    md.appendMarkdown(`| Cost | **${fmtCost(fiveHr.cost, fiveHr.costKnown)}** |\n\n`);

    md.appendMarkdown(`**This Week** · ${weekly.turns} turns\n\n`);
    md.appendMarkdown(`| | |\n|---|---|\n`);
    md.appendMarkdown(`| Total tokens | ${fmtTokens(weekly.totalTokens)} |\n`);
    md.appendMarkdown(`| Cache hit rate | ${weekly.hitRate}% |\n`);
    md.appendMarkdown(`| Cost | **${fmtCost(weekly.cost, weekly.costKnown)}** |\n\n`);

    md.appendMarkdown('---\n\n');
    md.appendMarkdown('Pricing: [LiteLLM model prices](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) · refreshed daily  \n');
    md.appendMarkdown('Aggregate: refreshed every 5 min');

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
