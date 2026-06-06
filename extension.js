const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// Pricing source: LiteLLM community-maintained model prices
// https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICING_CACHE_PATH = path.join(os.homedir(), '.claude', 'pricing-cache.json');
const PRICING_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refresh once per day

let _pricingCache = null; // { fetchedAt, models }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function loadPricing() {
  // 1. In-memory cache
  if (_pricingCache && (Date.now() - _pricingCache.fetchedAt) < PRICING_CACHE_TTL_MS) {
    return _pricingCache.models;
  }

  // 2. Disk cache
  try {
    const disk = JSON.parse(fs.readFileSync(PRICING_CACHE_PATH, 'utf8'));
    if (disk.fetchedAt && (Date.now() - disk.fetchedAt) < PRICING_CACHE_TTL_MS) {
      _pricingCache = disk;
      return disk.models;
    }
  } catch {}

  // 3. Fetch fresh from LiteLLM
  try {
    const raw = await fetchJson(LITELLM_PRICING_URL);
    const models = {};
    for (const [key, v] of Object.entries(raw)) {
      if (!v.input_cost_per_token) continue;
      // Skip regional variants (us./eu./au./jp. prefixes) — use base prices
      if (/^(us|eu|au|jp)\./.test(key)) continue;
      models[key] = {
        input:         v.input_cost_per_token,
        output:        v.output_cost_per_token        || 0,
        cacheRead:     v.cache_read_input_token_cost  || 0,
        cacheWrite:    v.cache_creation_input_token_cost || 0,
        maxInputTokens: v.max_input_tokens            || 200000,
      };
    }
    _pricingCache = { fetchedAt: Date.now(), models };
    try { fs.writeFileSync(PRICING_CACHE_PATH, JSON.stringify(_pricingCache)); } catch {}
    return models;
  } catch {
    return null; // network unavailable — cost shown as $?
  }
}

function resolvePricing(models, modelId) {
  if (!models || !modelId) return null;
  // Try: exact id → anthropic.{id} → first key containing the id
  const tries = [
    modelId,
    `anthropic.${modelId}`,
    ...Object.keys(models).filter((k) => k.includes(modelId)),
  ];
  for (const key of tries) {
    if (models[key]) return models[key];
  }
  return null;
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.tooltip = new vscode.MarkdownString(
    '**Claude Code — Context & Cost**\n\nPricing data: [LiteLLM model prices](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) · refreshed daily'
  );
  item.tooltip.isTrusted = true;
  context.subscriptions.push(item);

  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  function findMostRecentJsonl() {
    if (!fs.existsSync(projectsDir)) return null;
    let bestFile = null;
    let bestTime = 0;
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
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(Math.min(TAIL_BYTES, size));
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - TAIL_BYTES));
      fs.closeSync(fd);
      for (const line of buf.toString('utf8').split('\n').reverse()) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'assistant' && obj.message?.usage) {
            return { usage: obj.message.usage, model: obj.message.model || '' };
          }
        } catch {}
      }
    } catch {}
    return null;
  }

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
      if (ageMinutes > 10) {
        item.text = '🤖 Claude: Idle';
        item.backgroundColor = undefined;
        item.show();
        return;
      }

      const result = readLastUsage(recent.path);
      if (!result) return;

      const { usage, model } = result;
      const inputTokens  = usage.input_tokens                  || 0;
      const cacheCreate  = usage.cache_creation_input_tokens   || 0;
      const cacheRead    = usage.cache_read_input_tokens        || 0;
      const outputTokens = usage.output_tokens                  || 0;

      const models = await loadPricing();
      const pricing = resolvePricing(models, model);

      // Context window % (max_input_tokens from LiteLLM, default 200K)
      const windowSize = pricing?.maxInputTokens || 200000;
      const usedTokens = inputTokens + cacheCreate + cacheRead;
      const ctxPct = Math.min(100, Math.round(usedTokens * 100 / windowSize));

      // Cache hit % — cached reads as share of total input consumed
      const totalInput = inputTokens + cacheRead;
      const hitRate = totalInput > 0 ? Math.round(cacheRead * 100 / totalInput) : 0;

      // Per-turn cost in USD using LiteLLM per-token rates
      let costStr = '$?';
      if (pricing) {
        const cost = inputTokens  * pricing.input      +
                     cacheCreate  * pricing.cacheWrite  +
                     cacheRead    * pricing.cacheRead   +
                     outputTokens * pricing.output;
        costStr = `$${cost.toFixed(4)}`;
      }

      if (hitRate >= 70) {
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground');
      } else if (hitRate <= 30) {
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      } else {
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      }

      // Compact model label: strip "claude-" prefix (e.g. claude-sonnet-4-6 → sonnet-4-6)
      const modelLabel = model.replace(/^claude-/i, '');

      item.text = `🤖 ${modelLabel} | Context: ${ctxPct}% | Cache Hit: ${hitRate}% | Turn Cost: ${costStr}`;
      item.show();

    } catch (err) {
      console.debug('Claude watcher error:', err.message);
    }
  }

  // Watch ~/.claude/projects/ for any JSONL writes
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

  context.subscriptions.push({
    dispose: () => {
      watcher?.close();
      clearInterval(interval);
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };