# Building ServiceNow MCP Toolkit Desktop

Cross-platform Electron desktop app with React 18 + Vite renderer.

## Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org/)
- **npm 9+** (comes with Node.js)
- The parent `servicenow-mcp` project must be built first (`npm run build` in root)

## Quick Start (Development)

```bash
# 1. Build the MCP server (from the repo root)
cd /path/to/servicenow-mcp
npm install
npm run build

# 2. Install desktop dependencies
cd desktop
npm install

# 3. Start development mode (hot-reload)
npm run dev
```

This launches Vite dev server for the renderer + Electron with the main process. Changes to React components hot-reload instantly. Main process changes require a restart.

## Production Build

```bash
# Build both renderer and main process
npm run build

# Package for current platform
npm run package

# Package for specific platform
npm run package:win     # Windows (NSIS installer)
npm run package:mac     # macOS (DMG)
npm run package:linux   # Linux (AppImage + .deb)
```

Output goes to `desktop/release/`.

## Separate DEV Build (parallel install)

You can build and install a **completely independent "DEV" copy** that runs side-by-side with the production app and never touches its data. It gets its own:

- **App identity** — `appId: com.servicenow-mcp.desktop.dev`, product name `servicenow-mcp-dev` (so macOS treats it as a distinct app, with its own Dock/Launch Services entry).
- **Application Support directory** — `~/Library/Application Support/servicenow-mcp-dev/`, separate from the production app's own data directory (`…/servicenow-mcp-desktop/`). Instances, encrypted credentials, audit log, and the encryption key are fully isolated.
- **Build output** — `desktop/release-dev/` (prod artifacts in `release/` are never overwritten).

```bash
npm run package:dev        # current platform
npm run package:mac:dev    # macOS DMG  → release-dev/servicenow-mcp-dev-<version>.dmg
npm run package:win:dev    # Windows installer
npm run package:linux:dev  # Linux AppImage/.deb
```

Drag the DEV `.app` to `/Applications` (or anywhere) — it installs and updates independently of the production app. You can run both at the same time.

### How the isolation works

The data directory is keyed off the app's name, not the folder the `.app` lives in. Two pieces guarantee separation:

1. **Packaging** — the `package:*:dev` scripts pass `-c.extraMetadata.name=servicenow-mcp-dev` (plus the distinct `appId`/`productName`), so the bundled `package.json` name carries the `dev` signal.
2. **Runtime** (`main/index.ts` → `resolveBuildVariant` in `main/security.ts`) — before the config store is created, the app resolves its variant: a packaged build is "dev" when its bundled `package.json` name ends in `-dev`; `SNMCP_VARIANT=dev|prod` overrides; and unpackaged `npm run dev` defaults to dev. **Only the dev variant** calls `app.setName('servicenow-mcp-dev')` (which redirects `app.getPath('userData')`). **Production is never renamed**, so upgrading an existing install never moves or orphans its data — including the OS-keychain-bound encryption key. The code calls `setName` but never `setPath`, so an explicit `--user-data-dir` (E2E/packaging tests) still takes precedence.

### DEV in development mode (no packaging)

`npm run dev` already uses the `servicenow-mcp-dev` data directory, so day-to-day development never touches a production install's data. To point dev mode at the production data directory instead:

```bash
SNMCP_VARIANT=prod npm run dev
```

## Windows-Specific Notes

### Building on Windows

```powershell
# PowerShell (run as admin if needed)
cd C:\path\to\servicenow-mcp\desktop
npm install
npm run package:win
```

The NSIS installer will be at `release/servicenow-mcp-Setup.exe`.

### Code Signing (Optional)

For Windows code signing, set these environment variables before building:

```powershell
$env:CSC_LINK = "path/to/your-certificate.pfx"
$env:CSC_KEY_PASSWORD = "your-certificate-password"
npm run package:win
```

Without code signing, Windows SmartScreen will show a warning on first launch.

## macOS-Specific Notes

### Code Signing & Notarization

For macOS distribution, you need an Apple Developer certificate:

```bash
export CSC_LINK="path/to/DeveloperID.p12"
export CSC_KEY_PASSWORD="password"
export APPLE_ID="your@appleid.com"
export APPLE_APP_SPECIFIC_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
npm run package:mac
```

## Architecture

```
desktop/
  main/                    # Electron main process (Node.js, CommonJS)
    index.ts               # Window management, IPC handlers, app lifecycle
    preload.ts             # Context bridge — exposes window.api to renderer
    server-manager.ts      # Spawns and manages the MCP server child process
    config-store.ts        # Persists instances, settings, audit logs
  renderer/                # React 18 UI (Vite, ESM)
    src/
      main.tsx             # React entry + router
      components/
        AppLayout.tsx      # Sidebar + main content layout
      pages/
        Dashboard.tsx      # Server status, stats, recent activity
        SetupWizard.tsx    # 8-step interactive setup wizard
        ToolBrowser.tsx    # Browse & search all 400+ tools
        AuditLog.tsx       # Filterable audit log viewer
        Instances.tsx      # Manage ServiceNow instances
        Settings.tsx       # App settings & system info
      styles/
        global.css         # Dark theme, components, utilities
      types.d.ts           # TypeScript types for window.api
    index.html             # Vite entry HTML
  electron-builder.yml     # Packaging configuration
  package.json             # Desktop-specific dependencies
  tsconfig.json            # Renderer TypeScript config
  tsconfig.main.json       # Main process TypeScript config
  vite.config.ts           # Vite bundler config
  BUILDING.md              # This file
```

## How It Works

1. **Electron main process** creates the app window and registers IPC handlers
2. **Preload script** exposes a safe `window.api` bridge to the renderer
3. **React renderer** renders the UI and calls `window.api.*` for all backend operations
4. **ServerManager** spawns the MCP server (`dist/server.js`) as a child process with the correct environment variables
5. **ConfigStore** persists instance configs and audit logs to `~/.config/servicenow-mcp/`

The MCP server is the same one used by Claude, Cursor, and all other AI clients. The desktop app just provides a visual management layer.

## Testing

The desktop app has a full test pyramid. Layers L0–L3 and L5 run anywhere; **L4 and L6 require a real Electron binary** (downloaded on `npm install`), so they only run on a developer machine — not in a sandboxed/CI environment where the Electron download is blocked.

```bash
cd desktop
npm install                 # also downloads the Electron + Playwright binaries

# L0 — build & strict typecheck
npm run build
npm run type-check

# L1–L3 — unit (main process), IPC contract, renderer components (vitest)
npm test                    # 44 tests; npm run coverage for V8 coverage

# L5 — web-mode E2E (Playwright + chromium, browser deployment of the renderer)
npm run test:e2e:web

# L4 + L6 — Electron E2E and packaging smoke (need a real Electron binary)
npm run test:e2e           # launches the built app via Playwright _electron
```

| Layer | What it covers | Command |
|-------|----------------|---------|
| L0 | Build + strict TS typecheck | `npm run build && npm run type-check` |
| L1 | Main-process units (config-store encryption, server-manager, security helpers) | `npm test` |
| L2 | IPC contract — preload channels ≡ main handlers | `npm test` |
| L3 | Renderer component tests (all 7 pages + web-API fallback) | `npm test` |
| L4 | Electron E2E — launch, navigate, gated live start-server flow | `npm run test:e2e` |
| L5 | Web-mode E2E — serve.cjs renderer in a real browser | `npm run test:e2e:web` |
| L6 | Packaging smoke — packaged `.app` launches + bundles the server | `npm run package:mac && npm run test:e2e` |

### L4 live flow (optional)

The Electron E2E suite includes a live "start the server and load tools" flow that is gated behind an env flag so it never runs by accident:

```bash
RUN_LIVE_E2E=1 \
SERVICENOW_INSTANCE_URL=https://yourinstance.service-now.com \
SERVICENOW_BASIC_USERNAME=admin \
SERVICENOW_BASIC_PASSWORD=... \
npm run test:e2e
```

Use read-only credentials; the flow creates no test data.

### L6 packaging smoke

`tests/e2e/package.spec.ts` **self-skips** until you have produced a package. To run it:

```bash
npm run package:mac        # electron-builder → release/<arch>/servicenow-mcp.app
npm run test:e2e           # the package smoke test now finds and launches the .app
```

It launches the packaged bundle (not the dev build), asserts the window renders with no uncaught errors, and verifies the MCP server was bundled at `resources/server/server.js` (per `electron-builder.yml`). Code-signing/notarization are out of scope for this test.

## Troubleshooting

### "Server not found at ..."

Run `npm run build` in the root `servicenow-mcp` directory first. The desktop app looks for `../dist/server.js` in development mode.

### Blank window on launch

Check the developer console (View > Toggle Developer Tools or Ctrl+Shift+I). Common causes:
- Missing `renderer/dist/` — run `npm run build:renderer`
- CSP violation — check Content-Security-Policy in `renderer/index.html`

### Windows: "This app has been blocked"

The installer isn't code-signed. Right-click > Properties > Unblock, or click "More info" > "Run anyway" on the SmartScreen dialog.
