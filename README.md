# Claude Code Cache & Cost Watcher 🤖

An ultra-lightweight, zero-config native VS Code extension that pipes real-time telemetry from your active `claude` CLI sessions directly into the global editor status bar.

## Key Features 🚀

- **Zero-config**: Works out of the box for any Claude Code user — no setup, no API keys, no statusline script required.
- **Current turn metrics**: Context fill %, cache hit rate, and per-turn cost shown instantly after each Claude response.
- **5-hour window cost**: Running total of what you've spent in the last 5 hours.
- **Weekly cost**: Cumulative spend across all Claude Code sessions this week.
- **Rich hover tooltip**: Detailed breakdown — token counts, hit rate, cost — for the current turn, last 5 hours, and this week.
- **Traffic-light cache health**: Dynamic status bar background based on cache hit rate:
  - 🟢 **Blue/Green (≥ 70%)**: Cache well-warmed — reads at ~10% of fresh input cost.
  - 🟡 **Orange (31–69%)**: Cache partially stale.
  - 🔴 **Red (≤ 30%)**: Cache constantly rebuilding — high spend alert.
- **Live pricing**: Fetches per-token rates from [LiteLLM's community-maintained price list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) once per day. Works correctly across mixed models in the same week.

---

## Status Bar

```
🤖 sonnet-4-6 | Ctx: 13% | Hit: 99% | $0.0217 | 5h: $1.59 | 7d: $354.44
```

Hover over the item for a full breakdown:

| | |
|---|---|
| Context | 13% (26.3K / 200K tokens) |
| Cache Hit | 99% |
| Input (fresh) | 1 |
| Cache write | 1.6K |
| Cache read | 24.6K |
| Output | 537 |
| Turn cost | **$0.0217** |

| Last 5 Hours · 43 turns | |
|---|---|
| Total tokens | 1.2M |
| Cache hit rate | 99% |
| Cost | **$1.59** |

| This Week · 1,195 turns | |
|---|---|
| Total tokens | 403.6M |
| Cache hit rate | 100% |
| Cost | **$354.44** |

---

## How It Works 🛠️

```
You submit a prompt
      │
      ▼
Claude Code CLI ──── calls Anthropic API ────► Response
      │
      ├──► writes to ~/.claude/projects/**/*.jsonl
      │         │
      │         └──► Extension reads this file (fs.watch + 10s poll)
      │
      └──► calls statusline.sh with JSON via stdin  (if configured)
```

The extension is a **pure file reader** — it watches `~/.claude/projects/**/*.jsonl`, the conversation logs Claude Code writes automatically for every session. It never calls the Anthropic API or uses extra tokens.

The only network request it makes is fetching LiteLLM pricing data once per day to calculate costs.

**Aggregate data** (5-hour and weekly) is recomputed every 5 minutes by scanning all `.jsonl` files modified within the relevant window. The current-turn display updates on every file write (instant) and every 10 seconds as a fallback.

---

## Installation 📦

### VS Code Marketplace
1. Open VS Code and press `Cmd + Shift + X`.
2. Search for **"Claude Code Cache and Cost Watcher"**.
3. Click **Install**.

### Manual / from source
```bash
git clone https://github.com/shivaraj-arch/claude-cache-watcher
cd claude-cache-watcher
npm install -g @vscode/vsce
vsce package
```
Drag and drop the resulting `.vsix` into the VS Code extensions panel.

---

## Requirements

- [Claude Code](https://claude.ai/code) CLI installed and used at least once (creates `~/.claude/projects/`).
- VS Code 1.85.0 or later.

No statusline script, no shell config, no API keys needed.

---

## Author 🧑‍💻

- **Developer**: Shivaraj
- **GitHub**: [@shivaraj-arch](https://github.com/shivaraj-arch)
- **Email**: shivrajsys@gmail.com

---

## License 📄

MIT — see the LICENSE file for details.
