# Claude Code Cache & Cost Watcher 🤖

An ultra-lightweight, zero-config native VS Code extension that pipes real-time telemetry from your active `claude` CLI sessions directly into the global editor status bar. 

No complex terminal configurations, no `.zshrc` hacks, and zero token overhead.

![License](https://shields.io)
![Version](https://shields.io)

---

## Key Features 🚀

* **Zero Approximation Tracking**: Pulls direct JSON telemetry from Claude Code's internal engine logs for absolute mathematical accuracy.
* **Cost Guardrail**: Displays cumulative session pricing in real-time to prevent quota shock.
* **Context Monitor**: Visualizes how much of your 200,000 token maximum capacity has been filled.
* **Traffic-Light Cache Health**: Features dynamic visual warning triggers based on the strict 70/30 caching efficiency law:
  * 🟢 **Green (>= 70%)**: Caching is optimized, drawing files from GPU memory at a 90% discount.
  * 🟡 **Yellow (31% - 69%)**: Stale session warnings.
  * 🔴 **Red (<= 30%)**: Cache is constantly invalidating and rebuilding, alerting you to high quota spend.

---

## How It Works 🛠️

Unlike basic terminal hacks, this extension operates via an **independent background file-watch architecture**. 

Whenever you invoke the `claude` CLI in your terminal, the engine streams operational diagnostics locally. This extension intercepts the state payloads, calculates cache percentages, and updates your status bar instantly without sending secondary API requests or using extra tokens.

---

## Installation 📦

### Method 1: VS Code Extensions Marketplace
1. Open VS Code and press `Cmd + Shift + X`.
2. Search for **"Claude Code Cache and Cost Watcher"**.
3. Click **Install**.

### Method 2: Manual Developer Compilation
If you prefer to build the extension manually from source assets:
```bash
git clone https://github.com
cd claude-cache-watcher
npm install
npm install -g @vscode/vsce
vsce package
```
Drag and drop the resulting `.vsix` bundle directly into your VS Code extension panel.

---

## Configuration ⚙️

The extension is entirely plug-and-play. It handles directory monitoring out of the box:
* Spawns clean sandbox data paths automatically if `~/.claude` profiles are missing.
* Gracefully displays a neutral `🤖 Claude: Ready` status bar item when the CLI is offline.

---

## Author 🧑‍💻

* **Developer**: Shivaraj
* **GitHub**: [@shivaraj-arch](https://github.com)
* **Email**: shivrajsys@gmail.com

---

## License 📄

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for configuration details.
