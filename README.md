# Claude Code Turn Monitor

Real-time per-turn telemetry for Claude Code in the VS Code status bar. See context fill, cache efficiency, and API-equivalent cost the moment Claude responds — without leaving your editor.

---

## Features

**Per-turn metrics in the status bar**

After every Claude response, the status bar updates with:

```
🤖 sonnet-4-6 | Ctx: 31% | Hit: 100% | ~$0.02
```

| Indicator | Description |
|---|---|
| `Ctx: 31%` | Percentage of the 200K context window consumed this turn |
| `Hit: 100%` | Cache hit rate — proportion of input served from cache vs billed fresh |
| `~$0.02` | API-equivalent cost for this turn (subscription users see `~` prefix) |

**Cache health indicator**

The status bar background reflects cache efficiency at a glance:
- **Blue/Green** — hit rate ≥ 70%. Cache is warm; reads cost ~10× less than fresh input.
- **Orange** — hit rate 31–69%. Cache partially stale.
- **Red** — hit rate ≤ 30%. Context is rebuilding every turn at full cost.

**Hover tooltip**

Hovering the status bar item shows a full token breakdown for the current turn — input, cache write, cache read, output — along with your plan type, rate limit tier, and subscription date read from `~/.claude.json`.

**Plan awareness**

Set `claudeWatcher.planType` to `subscription` or `api`. Subscription users see API-equivalent costs (prefixed `~`) rather than actual charges, making the numbers meaningful for understanding value rather than spend.

---

## How It Works

The extension watches `~/.claude/projects/**/*.jsonl` — the conversation logs Claude Code writes locally for every session. On each file change, it reads the last assistant entry and computes metrics from the raw token counts.

**Per-window isolation:** Each VS Code window scopes to its own workspace. Claude Code encodes the workspace path as the project directory name (e.g. `/Users/you/project` → `~/.claude/projects/-Users-you-project/`), so the extension reads only the JSONL files belonging to that window's workspace. Multiple windows running different models — or different projects — display independent metrics.

No Anthropic API calls are made. No extra tokens are consumed. The only network request is a daily fetch of [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) to calculate cost. If the page cannot be parsed, the extension falls back to hardcoded prices bundled with the release.

> **Note on usage limits:** Session and weekly usage percentages depend on Anthropic's server-side rate limit state, which varies with capacity. Use `/usage` inside Claude Code for real-time limit data.

---

## Requirements

- [Claude Code](https://claude.ai/code) CLI installed and active (creates `~/.claude/projects/` automatically)
- VS Code 1.85.0 or later

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `claudeWatcher.planType` | `subscription` | `subscription` for Pro/Max/Team flat-fee plans; `api` for pay-as-you-go. Controls cost labelling. |

---

## Author

[Shivaraj](https://github.com/shivaraj-arch)

---

MIT © 2026 Shivaraj
