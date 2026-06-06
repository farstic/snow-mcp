# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org).

## [1.0.0] — 2026

Initial release of ServiceNow MCP Toolkit.

- 394 tools across 37 ServiceNow domains, exposed over the Model Context Protocol.
- Resource-first tool naming grammar: `snow_<domain>_<entity>_<action>`.
- Tiered write safety gates: `WRITE_ENABLED`, `CMDB_WRITE_ENABLED`, `SCRIPTING_ENABLED`,
  `NOW_ASSIST_ENABLED`, `ATF_ENABLED`, `FLUENT_ENABLED`.
- Role-based tool packages via `MCP_TOOL_PACKAGE`.
- Transports: stdio, SSE, HTTP.
- Categorised, explained record deletion (permission/ACL, reference constraint, not found).
