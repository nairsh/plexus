# Orchestrator Menu Bar App

macOS menu bar app for the Orchestrator platform, built with Tauri v2 + React + TypeScript.

## Prerequisites

```bash
# 1. Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. Tauri CLI (via cargo)
cargo install tauri-cli --version "^2.0"

# 3. ImageMagick (for icon generation)
brew install imagemagick
```

## Setup

```bash
cd packages/menubar

# Install JS dependencies
pnpm install

# Generate app icons (creates src-tauri/icons/)
bash scripts/generate-icons.sh
```

## Development

```bash
# From the menubar package directory:
pnpm dev

# Or from workspace root:
cd packages/menubar && pnpm dev
```

This launches the Vite dev server on port 1420 and opens the Tauri window. Click the tray icon to toggle the popover.

## Build

```bash
pnpm build
# Output: src-tauri/target/release/bundle/
```

## First launch

On first launch the app shows the Settings view. Enter:
- **Server URL** — e.g. `http://localhost:8080`

Then sign in with Clerk (when `VITE_CLERK_PUBLISHABLE_KEY` is configured).

Click **Test Connection** to verify, then **Get Started**.

## Architecture

```
src/
├── api/
│   ├── client.ts       # fetch() wrapper with Bearer auth
│   ├── sse.ts          # SSE via fetch + eventsource-parser (supports auth headers)
│   └── types.ts        # WorkflowEvent types mirrored from @orchestrator/shared
├── hooks/
│   ├── useConfig.ts    # Persists server URL via tauri-plugin-store
│   ├── useWorkflows.ts # Polls GET /v1/workflows (adaptive: 3s active, 10s idle)
│   └── useWorkflowStream.ts  # SSE per active workflow
├── components/
│   ├── App.tsx         # Root: settings vs main view routing
│   ├── InputBar.tsx    # Objective input (Enter to submit)
│   ├── WorkflowCard.tsx    # Live activity card with task list
│   ├── WorkflowList.tsx    # Scrollable card list
│   ├── StatusBadge.tsx     # Running/Completed/Failed pill
│   ├── TaskProgress.tsx    # Sub-task status within a card
│   ├── SettingsView.tsx    # Config + test connection
│   └── EmptyState.tsx      # "No active workflows"
src-tauri/
├── src/
│   ├── lib.rs          # Tray icon, window toggle, hide-on-blur
│   └── main.rs         # Entry point
└── tauri.conf.json     # 360×480 borderless transparent window
```

## Notes

- The tray icon uses `iconAsTemplate: true` — macOS automatically inverts it for light/dark mode
- The window hides when it loses focus (popover behaviour)
- SSE streams use `fetch()` instead of native `EventSource` to support `Authorization` headers
- Settings are persisted to `~/Library/Application Support/com.orchestrator.menubar/config.json`
