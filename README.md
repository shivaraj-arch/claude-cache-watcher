# Claude Code Turn Monitor 🤖

A zero-config VS Code extension that shows real-time per-turn telemetry from your Claude Code sessions directly in the status bar — context fill, cache hit rate, and API-equivalent cost, updated after every response.

## Key Features 🚀

- **Zero-config**: Works out of the box for any Claude Code user — no setup, no API keys, no shell scripts.
- **Per-turn metrics**: Context fill %, cache hit rate, and cost appear instantly after each Claude response.
- **Subscription aware**: Configure your plan type (`subscription` or `api`). Subscription users see costs prefixed with `~` (API-equivalent value, not an actual charge).
- **Traffic-light cache health**: Status bar background changes based on cache hit rate:
  - 🟢 **Green (≥ 70%)**: Cache well-warmed — reads at ~10% of fresh input cost.
  - 🟡 **Orange (31–69%)**: Cache partially stale.
  - 🔴 **Red (≤ 30%)**: Cache constantly rebuilding — high spend per turn.
- **Plan info on hover**: Tooltip shows your subscription start date, organisation type, and rate limit tier — read from `~/.claude.json`.
- **Live pricing**: Fetches per-token rates from [LiteLLM's community-maintained price list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) once per day.

---

## Status Bar

**Subscription (Pro / Max):** `~` prefix = API-equivalent value, not actual charge:
```
🤖 sonnet-4-6 | Ctx: 31% | Hit: 100% | ~$0.02
```

**API key (pay-as-you-go):**
```
🤖 sonnet-4-6 | Ctx: 31% | Hit: 100% | $0.02
```

**Idle** (no Claude activity for > 10 min):
```
🤖 Claude: Idle
```

---

## Tooltip (hover)

| | |
|---|---|
| Context | 31% (61.4K / 200K tokens) |
| Cache Hit | 100% |
| Input (fresh) | 1 |
| Cache write | 2.5K |
| Cache read | 58.9K |
| Output | 4.6K |
| API-equiv cost | **~$0.02** |

**Plan**

| | |
|---|---|
| Type | claude_pro |
| Rate tier | default_claude_ai |
| Subscribed since | May 25, 2026 |

> **Session & weekly usage %** vary with Anthropic's server capacity and cannot be tracked locally. Run `/usage` inside Claude Code for real-time limits.

---

## How It Works 🛠️

```
You submit a prompt
      │
      ▼
Claude Code CLI ──── calls Anthropic API ────► Response
      │
      └──► writes to ~/.claude/projects/**/*.jsonl
                    │
                    └──► Extension reads this file (fs.watch + 10s poll)
```

The extension is a **pure file reader** — it watches `~/.claude/projects/**/*.jsonl`, the conversation logs Claude Code writes automatically for every session. It never calls the Anthropic API or uses extra tokens.

The only network request it makes is fetching LiteLLM pricing data once per day to calculate per-turn cost.

---

## Installation 📦

### VS Code Marketplace
1. Open VS Code and press `Cmd + Shift + X`.
2. Search for **"Claude Code Turn Monitor"**.
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

## Configuration ⚙️

Open VS Code settings (`Cmd+,`) and search for **Claude Watcher**:

| Setting | Default | Description |
|---|---|---|
| `claudeWatcher.planType` | `subscription` | `subscription` (Pro/Max/Team flat fee) or `api` (pay-as-you-go). Controls the `~` prefix on costs. |

---

## Requirements

- [Claude Code](https://claude.ai/code) CLI installed and used at least once (creates `~/.claude/projects/`).
- VS Code 1.85.0 or later.

No statusline script, no shell config, no API keys needed.

---

## Author 🧑‍💻

- **Developer**: Shivaraj
- **GitHub**: [@shivaraj-arch](https://github.com/shivaraj-arch)

---

## License 📄

MIT © 2026 Shivaraj — see the LICENSE file for details.
