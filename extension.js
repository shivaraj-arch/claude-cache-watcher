const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICING_CACHE_PATH  = path.join(os.homedir(), '.claude', 'pricing-cache.json');
const CLAUDE_CONFIG_PATH  = path.join(os.homedir(), '.claude.json');
const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

let _pricingCache = null; // { fetchedAt, models }

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
        input:     v.input_cost_per_token,
        output:    v.output_cost_per_token          || 0,
        cacheRead: v.cache_read_input_token_cost     || 0,
        cacheWrite:v.cache_creation_input_token_cost || 0,
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

      const pricing = resolvePricing(models, model);
      // LiteLLM reports 1M for sonnet-4-6; Claude Code uses 200K for all current models.
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
    md.appendMarkdown('Pricing: [LiteLLM model prices](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) · refreshed daily');

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
