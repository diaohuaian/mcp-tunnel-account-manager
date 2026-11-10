# 🚀 MCP Tunnel Account Manager

<div align="center">

<p align="center">
  <img src="./docs/assets/logo.png" alt="MCP Tunnel Logo" width="120" height="120" style="border-radius: 24px;" />
</p>

<p align="center">
  <a href="./README.md">简体中文</a> | <b>English</b>
</p>

**A sleek, zero-dependency, local-first OpenAI Secure MCP Tunnel & Multi-Account Orchestration Console designed for macOS & Windows**

[![Platform: macOS & Windows](https://img.shields.io/badge/Platform-macOS%20(Apple%20Silicon%20%26%20Intel)%20%7C%20Windows-blue.svg?logo=apple&logoColor=white)](https://github.com/diaohuaian/mcp-tunnel-account-manager)
[![Node: >=22.14.0](https://img.shields.io/badge/Node.js-%3E%3D%2022.14.0%20(Zero%20Dependencies)-green.svg?logo=node.js)](https://nodejs.org)
[![Security: AES-256-GCM](https://img.shields.io/badge/Security-AES--256--GCM%20Vault-red.svg?logo=lock)](https://github.com/diaohuaian/mcp-tunnel-account-manager)
[![Tests: 44/44 Passed](https://img.shields.io/badge/Tests-44%2F44%20Passed%20(100%25)-success.svg?logo=github-actions)](https://github.com/diaohuaian/mcp-tunnel-account-manager)
[![GitHub Star](https://img.shields.io/github/stars/diaohuaian/mcp-tunnel-account-manager?style=social)](https://github.com/diaohuaian/mcp-tunnel-account-manager/stargazers)

<br/>

Seamlessly and securely connect **ChatGPT** to your local MCP servers (**Overleaf LaTeX Collaboration**, **Antigravity AI Agent IDE**, **DeepSeek**, etc.) via **OpenAI Secure MCP Tunnel**, with atomic 5-stage profile switching and automated rollback!

<br/>

<img src="./docs/assets/dashboard.png" alt="MCP Tunnel Account Manager Dashboard" width="780" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);" />

</div>

---

## ✨ Why MCP Tunnel Account Manager?

Connecting ChatGPT to local MCP tools on macOS often comes with pain points: **tedious configuration edits**, **process disconnections**, and **risky credential handling across multiple accounts**.

This project provides an out-of-the-box, reliable, and secure orchestration system:

### 🍏 Native macOS Experience
- **Zero PowerShell Dependency**: Completely rewritten with modern Node.js asynchronous architecture for process control and daemon supervision. Native support for **Apple Silicon (M1/M2/M3/M4) and Intel architectures**.
- **One-Click Native Desktop App (with Retina Neon Icon)**: Double-click to silently start the background manager and open your browser console. No lingering terminal windows!
- **macOS System Integration**: Securely stores encrypted databases in `~/Library/Application Support/McpTunnelAccountManager` and supports revealing configuration files in Finder with a single click.

### ⚡ Zero External Dependencies
- Leverages modern Node.js (>= 22.14.0) standard libraries: built-in `node:sqlite` (zero node-gyp or C++ compilation issues), `node:crypto`, native WebSocket, and process supervision.
- **No endless `npm install` needed**—just clone and run!

### 🔒 Local-First Security Vault
- **AES-256-GCM Encryption**: All API keys, Tunnel IDs, and sensitive environment variables are sealed in an encrypted SQLite database using a persistent master key.
- **Strict Permission Isolation**: Secrets and runtime state are restricted to `0600` permissions (accessible only by the current user).
- **Zero Leakage / No Network Exposure**: Strictly bound to loopback `127.0.0.1`, rejecting all public interface exposure and cross-origin attempts.

### 🛡️ 5-Stage Atomic Switch & Automatic Rollback
- Manage multiple account configurations (Profiles) and switch between them on the fly.
- Transaction flow: `QUEUED` $\to$ `PREPARING` $\to$ `APPLYING` $\to$ `VERIFYING` $\to$ `SUCCEEDED`.
- **Zero Drift Protection**: If any health check, PID binding, or tunnel handshake fails during verification, the transaction **automatically rolls back (`ROLLED_BACK`)** to the previous working state.

### 📦 Ready-to-Use Ecosystem Installers
- **OpenAI `tunnel-client` Installer**: Auto-detects Apple Silicon (`darwin-arm64`) vs Intel (`darwin-amd64`), safely downloads the verified v0.0.19 binary, and bypasses Gatekeeper quarantine.
- **Overleaf MCP Installer**: Integrates `mcp-server-overleaf` for real-time LaTeX paper reading, tracked suggestions, diffs, and local compilation.
- **Antigravity MCP Installer**: One-click setup for the [Antigravity MCP](https://github.com/Kio-pon/antigravity-mcp) subagent orchestration engine.

<br/>

<p align="center">
  <img src="./docs/assets/mcp-services.png" alt="MCP Services Registry" width="780" style="border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);" />
</p>

---

## 🏗️ Architecture & Interaction Flow

```mermaid
flowchart LR
    subgraph Cloud["Cloud / Clients"]
        ChatGPT["💬 ChatGPT Web / App"]
        OpenAIControl["🌐 OpenAI Tunnel Endpoint"]
    end

    subgraph LocalMac["Local macOS System"]
        subgraph Manager["🎛️ Local Console (127.0.0.1:17642)"]
            WebUI["Modern Web Console"]
            Vault[("🔐 AES-256-GCM Vault")]
            Controller["Node.js Process & Switch Engine"]
        end

        subgraph Tunnel["⚡ Official Tunnel Runtime"]
            TunnelDaemon["tunnel-client Daemon"]
        end

        subgraph Services["🛠️ Local MCP Server Fleet"]
            Overleaf["📝 Overleaf MCP (LaTeX Papers)"]
            Antigravity["🧠 Antigravity MCP (Agent Orchestration)"]
            CustomMCP["⚙️ Custom Stdio / HTTP MCP"]
        end
    end

    ChatGPT -->|Tool Calls| OpenAIControl
    OpenAIControl <==>|Outbound TLS Tunnel| TunnelDaemon
    TunnelDaemon -->|stdio| Overleaf
    TunnelDaemon -->|stdio| Antigravity
    TunnelDaemon -->|stdio / HTTP| CustomMCP

    WebUI <--> Controller
    Controller <--> Vault
    Controller -->|Supervise & Switch| TunnelDaemon
```

---

## ⚡ 30-Second Quick Start (macOS)

### 1. Check Prerequisites
Ensure Node.js 22.14.0+ and Git are installed (recommended via Homebrew):
```bash
brew install node git
```

### 2. Clone the Repository
```bash
git clone https://github.com/diaohuaian/mcp-tunnel-account-manager.git
cd mcp-tunnel-account-manager
```

### 3. Install Desktop Shortcut (Recommended 🌟)
Run the desktop shortcut installer to generate a native macOS app with a high-resolution icon:
```bash
./Install-Desktop-Shortcut.sh
```
> 🎉 **Double-click `MCP Tunnel 账户管理器.app` on your Desktop** to automatically start the background daemon and launch the web console in your default browser!

*(Or launch directly from terminal: `./start-manager.sh`)*

---

## 🛠️ Included One-Click Installers

Helper scripts located in `scripts/` automate prerequisites on macOS:

### 1. Install OpenAI `tunnel-client`
```bash
./scripts/install-tunnel-client.sh
```
- Auto-detects Apple Silicon (`darwin-arm64`) vs Intel (`darwin-amd64`).
- Fetches the verified binary from OpenAI, removes quarantine flags, and sets up executables.

### 2. Install Overleaf MCP Server
```bash
./scripts/install-overleaf-mcp.sh
```
- Installs `mcp-server-overleaf` into isolated runtime storage.
- Enables ChatGPT to read sections, review LaTeX papers, and push tracked changes.

### 3. Install Antigravity MCP Server
```bash
./scripts/install-antigravity-mcp.sh
```
- Clones and configures [Antigravity MCP](https://github.com/Kio-pon/antigravity-mcp) for subagent dispatching.

---

## 💻 Common Commands

| Action | Command | Description |
| :--- | :--- | :--- |
| **Start Daemon** | `./start-manager.sh` | Starts background daemon on `127.0.0.1:17642` and opens browser |
| **Stop Daemon** | `./start-manager.sh --stop` | Gracefully shuts down the running daemon process |
| **Foreground Mode** | `./start-manager.sh --foreground` | Runs manager attached to stdout/stderr for debugging |
| **Custom Port** | `./start-manager.sh --port 18000` | Overrides default port 17642 |
| **Run Test Suite** | `npm test` | Runs all 44 test suites (unit, integration, heavy) |

---

## 🔒 Security & Privacy Guarantees

1. **Zero Telemetry**: No analytics, phone-home code, tracking beacons, or third-party requests.
2. **Local-First Credential Isolation**: All master keys, tokens, and database files remain strictly on your local machine (`~/Library/Application Support/McpTunnelAccountManager`). Nothing is ever committed or uploaded.
3. **Defense-in-Depth**: Built-in CSRF protection, session expiration, and atomic Idempotency-Key validation.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!

1. Fork the Project (`git checkout -b feat/amazing-feature`)
2. Commit your Changes (`git commit -m 'feat: Add amazing feature'`)
3. Ensure all tests pass (`npm test`)
4. Push to the Branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

---

## 🌟 Show Your Support

If this project helps streamline your **ChatGPT + MCP workflow on Mac**, please consider giving it a **⭐️ Star**!

<div align="center">

<a href="https://github.com/diaohuaian/mcp-tunnel-account-manager/stargazers">
  <img src="https://img.shields.io/badge/🌟%20Star%20This%20Project-yellow?style=for-the-badge&logo=github" alt="Star This Project" />
</a>

</div>
