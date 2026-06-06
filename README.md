# ServiceNow MCP Toolkit

A [Model Context Protocol](https://modelcontextprotocol.io) server for ServiceNow. It exposes **394 tools** spanning ITSM, CMDB, scripting, platform development, integration, security, and AI domains, so an MCP-capable assistant can read and operate a ServiceNow instance through a single, consistent interface.

## Highlights

- **394 tools** across 37 functional domains, each with a typed input schema.
- **Resource-first naming grammar** — every tool is named `snow_<domain>_<entity>_<action>`, so all operations on one entity sit together (e.g. `snow_inc_incident_add`, `snow_inc_incident_read`, `snow_inc_incident_modify`, `snow_inc_incident_resolve`).
- **Tiered write safety** — reads are always available; writes, CMDB writes, scripting, AI, ATF, and Fluent SDK operations are each gated behind an explicit environment flag.
- **Role-based tool packages** — load only the tools a persona needs via `MCP_TOOL_PACKAGE`.
- **Multi-transport** — stdio (default), SSE, and HTTP.
- **Explained deletes** — record deletion attempts the API call and returns a categorised, human-readable reason on failure (permission/ACL, reference constraint, not found).

## Install

```bash
npm install
npm run build
```

## Configure

Copy `.env.example` to `.env` and set at least your instance and auth:

```bash
SERVICENOW_INSTANCE_URL=https://yourinstance.service-now.com
SERVICENOW_AUTH_METHOD=basic            # or: oauth
SERVICENOW_BASIC_USERNAME=...
SERVICENOW_BASIC_PASSWORD=...
```

Write operations are off by default. Enable them deliberately:

| Flag | Unlocks |
|------|---------|
| `WRITE_ENABLED=true` | Standard record writes (create/update/delete, ITSM) |
| `CMDB_WRITE_ENABLED=true` | CI create/update (also needs `WRITE_ENABLED`) |
| `SCRIPTING_ENABLED=true` | Business rules, script includes, ACLs (also needs `WRITE_ENABLED`) |
| `NOW_ASSIST_ENABLED=true` | Generative AI / Now Assist tools |
| `ATF_ENABLED=true` | Automated Test Framework execution |
| `FLUENT_ENABLED=true` | Fluent / now-sdk tools |

Other useful settings: `MCP_TOOL_PACKAGE`, `TRANSPORT` (`stdio`/`sse`/`http`), `PORT`, `SNMCP_API_KEY` (bearer token for SSE/HTTP), `LOG_LEVEL`, `MAX_RECORDS`.

## Run

```bash
npm start            # stdio transport
TRANSPORT=http PORT=3000 npm start
```

## Tool naming

| Part | Meaning | Example |
|------|---------|---------|
| `snow_` | global namespace | — |
| `<domain>` | functional area code | `inc`, `chg`, `cmdb`, `scr`, `sec`, `rpt`, `kb` |
| `<entity>` | the object acted on | `incident`, `change_request`, `record` |
| `<action>` | canonical verb | `index` (list), `read` (get), `add` (create), `modify` (update), `remove` (delete), plus `resolve`, `close`, `exec`, `query`, … |

Input-argument names follow ServiceNow field conventions (`sys_id`, `table`, `number_or_sysid`, …).

## Tool domains

ITSM (`inc`, `prb`, `chg`, `tsk`), core Table API (`core`), users/groups (`usr`), knowledge (`kb`), catalog (`cat`), CSM (`csm`), HRSD (`hr`), Virtual Agent (`va`), scripting (`scr`), security/SecOps (`sec`), ATF (`atf`), DevOps (`devops`), Fluent SDK (`fluent`), Flow Designer (`flow`), App Studio (`studio`), workspaces (`ws`), portal (`portal`), integration (`intg`), CMDB reconciliation (`cmdb`), discovery (`disco`), asset management (`itam`), deployment (`deploy`), update sets (`us`), reporting (`rpt`), performance analytics (`perf`), ML (`ml`), Now Assist (`na`/`nas`), notifications (`ntf`), mobile (`mob`), agile (`agile`), orchestration (`orch`), system properties (`cfg`).

## Develop

```bash
npm run dev          # watch mode
npm test             # vitest, includes the 394-tool parity suite
npm run type-check
npm run lint
```

## License

See [LICENSE](./LICENSE). © 2026 Cvetomir Grigorov.
