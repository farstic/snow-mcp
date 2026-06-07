# Design Brief — Visual-only redesign of the ServiceNow MCP Toolkit UI

> Paste everything below the line into Claude (or a design/coding agent). Edit the
> **DESIGN DIRECTION** section to taste before sending. The rest are hard constraints —
> keep them intact so the redesign stays purely visual and nothing breaks.

---

You are a senior product designer + front-end engineer. Redesign the **visual appearance only** of an existing React desktop app's UI. This is a **restyle, not a rewrite**: do not change behavior, data flow, or structure beyond what styling requires.

## Absolute scope — VISUALS ONLY

✅ You MAY change:
- CSS (`src/styles/global.css`, `src/styles.css`) — colors, typography, spacing, radii, shadows, borders, gradients, transitions, layout/grid, responsive behavior.
- Inline `style={{ ... }}` objects and `className`s in components/pages — purely for appearance.
- The visual structure of JSX **only** where needed for layout (wrapping elements in styling containers, adding presentational `<div>`/`<span>`, reordering purely-visual elements). Add CSS classes freely.
- The CSS-variable design tokens and the dark/light + accent theming values.
- Icons/illustrations (SVG), as long as they stay neutral/brandless and CSP-safe.

🚫 You MUST NOT change (out of scope — leave exactly as-is):
- Any application logic, state, hooks, effects, event handlers, or control flow.
- Data fetching / API calls. **Do not touch `window.api.*` calls, `src/api.ts`, IPC, or the `serve.cjs` proxy.**
- Component **props, exports, function signatures, or the data passed between components.**
- Routing/navigation logic, page-switching state, or the `useTheme()` context contract.
- **Visible text content, labels, button copy, headings, placeholder text, and ARIA roles** — the test suite matches on text and roles, so keep all user-facing strings and roles identical.
- File/identifier names, `localStorage` keys, environment handling, build config.
- Anything in `main/`, `tests/`, `dist/`, `node_modules/`, `*.config.ts`, `package.json`.

If a visual change would require a logic change, STOP and call it out instead of doing it.

## What the app is
A cross-platform desktop app (also runs in-browser) for managing a ServiceNow MCP server: a visual setup wizard, server dashboard, instance manager, a browser for ~394 tools, an audit-log viewer, an AI chat, and settings. It is **not** branded "NowAIKit" — keep it neutral / "ServiceNow MCP Toolkit".

## Tech stack & hard constraints
- **React 18 + TypeScript + Vite.** Renderer lives in `desktop/renderer/`.
- **Runs in two environments:** Electron (desktop) AND a plain browser (web mode served by `serve.cjs`). Styles must work in both. Preserve the macOS window-drag region / traffic-light spacer in the sidebar (`WebkitAppRegion: 'drag'`, ~38px top spacer).
- **Strict Content-Security-Policy** (see `renderer/index.html`): `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`, `default-src 'self'`. ⇒ **No external resources**: no Google Fonts/CDNs, no remote images/icons. Use **system font stacks** or self-hosted fonts placed under `renderer/public/`, and inline SVG or `data:`/local images only.
- **Theming is token-based.** The app sets `data-theme="dark|light"` and `data-accent="<accent>"` on `<html>` and reads CSS variables. Keep this mechanism. Both **dark and light** modes and all accent options must look polished. Existing tokens include (extend, don't remove names other code depends on):
  `--bg, --bg-surface, --bg-card, --bg-hover, --surface, --surface2, --surface3, --border, --border2, --text, --text2, --text-dim, --text-muted, --dim, --accent (+ --accent-bg/-hover/-dim/-glow/-2), --green/-bg, --red/-bg, --yellow/-bg, --radius, --radius-lg, --shadow/-sm, --font, --mono, --brand-gradient, --text-gradient, --sidebar-width`.
- **Tests must keep passing** (`npm test`, `npm run type-check` in `desktop/`). There are no `data-testid`s — tests rely on visible text + roles, so do not alter copy or roles.

## Files in scope
- `renderer/src/styles/global.css` and `renderer/src/styles.css` (primary).
- `renderer/src/components/`: `Sidebar.tsx` (rendered nav/brand; heavy inline styles), `AppLayout.tsx`, `ProviderIcons.tsx`.
- `renderer/src/pages/`: `Dashboard.tsx`, `Instances.tsx`, `Tools.tsx` / `ToolBrowser.tsx`, `Logs.tsx` / `AuditLog.tsx`, `Chat.tsx`, `Settings.tsx`, `Setup.tsx` / `SetupWizard.tsx`.
- `renderer/index.html` (only the `<title>`-area markup/fonts if self-hosting a font; keep the CSP).
- Icons: `renderer/public/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `resources/icon.png` (optional; keep neutral if changed).

## Screens to cover (restyle every state, including empty/loading/error)
1. **Setup / Setup Wizard** — first-run flow to add a ServiceNow instance.
2. **Dashboard** — server status, stat cards, recent activity, start/stop controls.
3. **Instances** — list + add/edit/remove/test connection forms.
4. **Tools / Tool Browser** — searchable list of ~394 tools, detail/schema, execute + results.
5. **Logs / Audit Log** — filterable log table.
6. **AI Chat** — chat thread, message bubbles, tool-call rendering, composer.
7. **Settings** — theme/accent controls, providers & API keys, About section.
8. **Sidebar** — navigation, brand wordmark "ServiceNow MCP", instance indicator, server status dot, theme/accent switcher.

## DESIGN DIRECTION  ← edit this section to your taste
- **Overall feel:** modern, clean, professional developer-tool / SaaS dashboard. Calm, high-contrast, generous spacing, strong visual hierarchy.
- **Palette:** keep a teal→blue accent family as the default (current brand gradient `#00D4AA → #0F4C81`), but you may refine shades and introduce supporting neutrals. Dark mode is primary; light mode must be equally refined.
- **Typography:** crisp system-font stack; clear type scale; tabular numerals for metrics.
- **Components:** consistent cards, subtle elevation/borders, rounded corners (~8–12px), smooth micro-interactions/hover states, accessible focus rings, good empty/loading/error states.
- **Density:** comfortable but information-dense where it matters (tools list, logs).
- *(Optional alternatives to pick instead: minimalist/flat, glassmorphism, neo-brutalist, "Linear/Vercel"-style. State your choice and apply it consistently.)*

## Deliverables
1. Updated CSS + component styling implementing the direction across all screens and both themes.
2. A short **STYLE.md** documenting the token system, type scale, spacing scale, and component patterns you settled on.
3. Before/after notes per screen (1–2 lines each) describing the visual changes.

## Acceptance criteria (must all hold)
- `npm run type-check` and `npm test` pass unchanged (49 tests).
- App renders correctly in **both** dark and light mode and in **both** Electron and browser/web mode.
- **Zero** behavioral diffs: no changed `window.api` calls, props, handlers, routes, copy, or roles.
- No external network resources (CSP-clean). No new runtime dependencies without explicit approval.
- Diffs are styling-focused and reviewable; call out anything that needed more than CSS.

Work screen-by-screen. Show the diff for one screen (start with the Sidebar + Dashboard) and pause for feedback before doing the rest.
