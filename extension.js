const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICING_CACHE_PATH  = path.join(os.homedir(), '.claude', 'pricing-cache.json');
const CLAUDE_CONFIG_PATH  = path.join(os.homedir(), '.claude.json');
const PRICING_CACHE_TTL_MS  = 24 * 60 * 60 * 1000; // 24 h
const AGGREGATE_CACHE_TTL_MS =  5 * 60 * 1000;      //  5 min

let _pricingCache   = null; // { fetchedAt, models }
let _aggregateCache = null; // { fiveHr, weekly, computedAt }

function readSubscriptionStart() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, 'utf8'));
    const ts  = cfg?.oauthAccount?.subscriptionCreatedAt;
    return ts ? new Date(ts).getTime() : null;
  } catch { return null; }
}

// Next 7-day window boundary anchored to subscription creation date.
// Falls back to rolling oldest-entry if subscription date unavailable.
function weeklyResetMs(subStartMs) {
  if (!subStartMs) return null;
  const WEEK_MS  = 7 * 24 * 3600 * 1000;
  const elapsed  = Date.now() - subStartMs;
  const weeksDone = Math.floor(elapsed / WEEK_MS);
  return subStartMs + (weeksDone + 1) * WEEK_MS;
}

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
  let earliestMs = Infinity;
  for (const e of entries) {
    inp += e.input;  cw += e.cacheWrite;  cr += e.cacheRead;  out += e.output;
    const c = calcCost(e, models);
    if (c !== null) { cost += c; costKnown = true; }
    if (e.time < earliestMs) earliestMs = e.time;
  }
  const totalTokens = inp + cw + cr + out;
  const allInput    = inp + cr;
  const hitRate     = allInput > 0 ? Math.round(cr * 100 / allInput) : 0;
  return { turns: entries.length, totalTokens, hitRate, cost, costKnown,
           earliestMs: entries.length ? earliestMs : null };
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

// "2h 15m" / "1d 4h" from a millisecond delta
function fmtDiff(ms) {
  if (ms <= 0) return 'now';
  const totalMins = Math.floor(ms / 60000);
  const days  = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins  = totalMins % 60;
  if (days > 0)  return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// 5hr: rolling from oldest entry still in window
function sessionResetIn(earliestMs) {
  if (!earliestMs) return null;
  return fmtDiff(earliestMs + 5 * 3600 * 1000 - Date.now());
}

// 7d: anchored to subscription start date (accurate) or rolling fallback
function weeklyResetIn(subStartMs, earliestMs) {
  const anchor = weeklyResetMs(subStartMs);
  if (anchor) return fmtDiff(anchor - Date.now());
  if (!earliestMs) return null;
  return fmtDiff(earliestMs + 7 * 24 * 3600 * 1000 - Date.now());
}

function fmtBar(pct, width = 16) {
  const filled = Math.round(Math.min(pct, 100) * width / 100);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
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
      const planType       = cfg.get('planType', 'subscription');
      const monthlyBudget  = cfg.get('monthlyBudget', 20);
      const sessionBudget  = cfg.get('sessionBudgetUSD', 0);
      const weeklyBudget   = cfg.get('weeklyBudgetUSD', 0);
      const isSubscription = planType === 'subscription';

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
      // Subscription users get API-equivalent costs prefixed with "~" so they
      // know the number is usage value, not an actual charge.
      const pfx = isSubscription ? '~' : '';

      if (ageMinutes > 10) {
        const fiveHrStr = fmtCost(fiveHr.cost, fiveHr.costKnown);
        const weekStr   = fmtCost(weekly.cost, weekly.costKnown);
        item.text = `🤖 Claude: Idle | 5h: ${pfx}${fiveHrStr} | 7d: ${pfx}${weekStr}`;
        item.backgroundColor = undefined;
        item.tooltip = buildTooltip(null, fiveHr, weekly, isSubscription, monthlyBudget, sessionBudget, weeklyBudget);
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
      // LiteLLM's maxInputTokens is unreliable (reports 1M for sonnet-4-6).
      // Claude Code uses a 200K context window for all current Claude models.
      const windowSize = 200000;
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
      const fiveHrStr   = fmtCost(fiveHr.cost, fiveHr.costKnown);
      const weekStr     = fmtCost(weekly.cost, weekly.costKnown);

      if      (hitRate >= 70) item.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground');
      else if (hitRate <= 30) item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      else                    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

      item.text = `🤖 ${modelLabel} | Ctx: ${ctxPct}% | Hit: ${hitRate}% | ${pfx}${turnCostStr} | 5h: ${pfx}${fiveHrStr} | 7d: ${pfx}${weekStr}`;

      const currentTurn = { inputTokens, cacheCreate, cacheRead, outputTokens,
                            ctxPct, hitRate, windowSize, cost: turnCost, model, modelLabel };
      item.tooltip = buildTooltip(currentTurn, fiveHr, weekly, isSubscription, monthlyBudget, sessionBudget, weeklyBudget, sessionResetsIn, weeklyResetsIn);
      item.show();

    } catch (err) {
      console.debug('Claude watcher error:', err.message);
    }
  }

  function buildTooltip(turn, fiveHr, weekly, isSubscription, monthlyBudget, sessionBudget, weeklyBudget) {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const costLabel = isSubscription ? 'API-equiv cost' : 'Cost';

    md.appendMarkdown('### 🤖 Claude Code — Usage & Cost\n\n');

    // ── Usage windows ──────────────────────────────────────────────────────
    md.appendMarkdown('**Usage**\n\n');

    // Session (5hr)
    const sessionPct = sessionBudget > 0 && fiveHr.costKnown
                       ? Math.min(100, Math.round(fiveHr.cost * 100 / sessionBudget))
                       : null;
    const subStartMs      = readSubscriptionStart();
    const sessionResetsIn = sessionResetIn(fiveHr.earliestMs);
    const weeklyResetsIn  = weeklyResetIn(subStartMs, weekly.earliestMs);

    md.appendMarkdown(`**Session (5hr)** · ${fiveHr.turns} turns\n\n`);
    if (sessionPct !== null) {
      md.appendMarkdown(`\`${fmtBar(sessionPct)}\` **${sessionPct}%**`);
      md.appendMarkdown(` · ${fmtCost(fiveHr.cost, fiveHr.costKnown)} of $${sessionBudget} budget`);
    } else {
      md.appendMarkdown(`${fmtTokens(fiveHr.totalTokens)} tokens · ${fmtCost(fiveHr.cost, fiveHr.costKnown)}`);
    }
    if (sessionResetsIn) md.appendMarkdown(` · Resets in **${sessionResetsIn}**`);
    md.appendMarkdown('\n\n');

    // Weekly (7d)
    const weeklyPct = weeklyBudget > 0 && weekly.costKnown
                      ? Math.min(100, Math.round(weekly.cost * 100 / weeklyBudget))
                      : null;
    md.appendMarkdown(`**Weekly (7d)** · ${weekly.turns} turns\n\n`);
    if (weeklyPct !== null) {
      md.appendMarkdown(`\`${fmtBar(weeklyPct)}\` **${weeklyPct}%**`);
      md.appendMarkdown(` · ${fmtCost(weekly.cost, weekly.costKnown)} of $${weeklyBudget} budget`);
    } else {
      md.appendMarkdown(`${fmtTokens(weekly.totalTokens)} tokens · ${fmtCost(weekly.cost, weekly.costKnown)}`);
    }
    if (weeklyResetsIn) md.appendMarkdown(` · Oldest expires **${weeklyResetsIn}**`);
    md.appendMarkdown('\n\n');

    // Cache hit rates
    md.appendMarkdown(`| | |\n|---|---|\n`);
    md.appendMarkdown(`| Session cache hit | ${fiveHr.hitRate}% |\n`);
    md.appendMarkdown(`| Weekly cache hit | ${weekly.hitRate}% |\n\n`);

    // ── Plan comparison (subscription users only) ──────────────────────────
    if (isSubscription && weekly.costKnown && weekly.cost > 0) {
      const weeklySubCost = monthlyBudget * 12 / 52;
      const savings       = Math.max(0, weekly.cost - weeklySubCost);
      const discountPct   = Math.round(savings * 100 / weekly.cost);
      md.appendMarkdown(`**Your Plan** · $${monthlyBudget}/month\n\n`);
      md.appendMarkdown(`| | |\n|---|---|\n`);
      md.appendMarkdown(`| API-equivalent this week | ${fmtCost(weekly.cost, true)} |\n`);
      md.appendMarkdown(`| Subscription cost (weekly) | ${fmtCost(weeklySubCost, true)} |\n`);
      md.appendMarkdown(`| You're saving | **${fmtCost(savings, true)} (${discountPct}% off API rates)** |\n\n`);
    }

    // ── Current turn ───────────────────────────────────────────────────────
    if (turn) {
      md.appendMarkdown(`**Current Turn** · \`${turn.modelLabel}\`\n\n`);
      md.appendMarkdown(`| | |\n|---|---|\n`);
      md.appendMarkdown(`| Context | ${turn.ctxPct}% (${fmtTokens(turn.inputTokens + turn.cacheCreate + turn.cacheRead)} / ${fmtTokens(turn.windowSize)}) |\n`);
      md.appendMarkdown(`| Cache Hit | ${turn.hitRate}% |\n`);
      md.appendMarkdown(`| Input (fresh) | ${fmtTokens(turn.inputTokens)} |\n`);
      md.appendMarkdown(`| Cache write | ${fmtTokens(turn.cacheCreate)} |\n`);
      md.appendMarkdown(`| Cache read | ${fmtTokens(turn.cacheRead)} |\n`);
      md.appendMarkdown(`| Output | ${fmtTokens(turn.outputTokens)} |\n`);
      md.appendMarkdown(`| ${costLabel} | **${fmtCost(turn.cost, turn.cost !== null)}** |\n\n`);
    }

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
