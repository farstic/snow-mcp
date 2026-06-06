# Now Assist / AI Integration Guide (Latest Release)

This guide covers the 10 Now Assist and AI tools available when `NOW_ASSIST_ENABLED=true`. These tools use ServiceNow's latest release AI APIs.

## Prerequisites

1. ServiceNow latest release instance
2. Now Assist license activated on the instance
3. `NOW_ASSIST_ENABLED=true` in your environment

```env
NOW_ASSIST_ENABLED=true
```

## Available Tools

### Natural Language Query (NLQ)

`snow_na_nlq_query` translates plain English questions into ServiceNow queries and returns results.

```
# Ask the AI assistant:
How many P1 incidents were opened this week?
→ Uses snow_na_nlq_query internally, returns structured results
```

API: `POST /api/sn_nl_text_to_value/text_query`

### AI Search

`snow_na_ai_query` performs semantic search across knowledge base, catalog, incidents, and other sources.

```
snow_na_ai_query: "how to reset VPN access" across KB and catalog
→ Returns semantically ranked results
```

API: `GET /api/now/snow_na_ai_query/search`

### Generate Summary

`snow_na_summary_generate` creates an AI-written summary of any record.

```
Summarize incident INC0001234
→ AI generates natural language summary of the incident history, impact, and current status
```

API: `POST /api/sn_assist/skill/invoke` (summarization skill)

### Suggest Resolution

`snow_na_resolution_suggest` analyzes an incident and recommends resolution steps based on similar past incidents.

```
Suggest resolution for incident INC0001234
→ Returns recommendation with confidence score and similar incidents
```

### Categorize Incident (Predictive Intelligence)

`snow_na_incident_categorize` uses the Predictive Intelligence engine to predict category, assignment group, and priority.

```
Categorize: "Outlook won't open emails since Windows update"
→ {category: "Email", assignment_group: "Desktop Support", priority: 3, confidence: 0.89}
```

API: `POST /api/sn_ml/solution/{id}/predict` (LightGBM algorithm)

### Agentic Playbooks

`snow_na_agentic_playbook_trigger` invokes a Now Assist Agentic Playbook — context-aware AI agents that can take multi-step actions.

```
snow_na_agentic_playbook_trigger: playbook_sys_id="<sys_id>", context={incident_sys_id: "..."}
```

API: `POST /api/sn_assist/playbook/trigger`

This is a latest release feature. Agentic Playbooks allow Now Assist to autonomously handle workflows like incident triage, change advisory, and HR case management.

### Microsoft Copilot 365 Integration

`snow_na_ms_copilot_topics_read` lists Virtual Agent topics exposed to Microsoft Copilot 365 via the Custom Engine Agent bridge.

### Virtual Agent Streaming

`get_virtual_agent_stream` gets streaming Virtual Agent responses using the ServiceNow Streaming API.

### Predictive Intelligence Models

`snow_na_pi_models_read` lists available Predictive Intelligence solutions/models on your instance.

## Configuration Example

```env
# .env for Now Assist developer
SERVICENOW_INSTANCE_URL=https://yourinstance.service-now.com
SERVICENOW_AUTH_METHOD=oauth
SERVICENOW_OAUTH_CLIENT_ID=your_client_id
SERVICENOW_OAUTH_CLIENT_SECRET=your_client_secret
SERVICENOW_OAUTH_USERNAME=your_username
SERVICENOW_OAUTH_PASSWORD=your_password

NOW_ASSIST_ENABLED=true
MCP_TOOL_PACKAGE=ai_developer
```

## Latest API References

| API | Endpoint | Purpose |
|-----|----------|---------|
| Now Assist Skills | `POST /api/sn_assist/skill/invoke` | Generative AI skills |
| Agentic Playbooks | `POST /api/sn_assist/playbook/trigger` | Multi-step AI agents  |
| AI Search | `GET /api/now/snow_na_ai_query/search` | Semantic search |
| Predictive Intelligence | `POST /api/sn_ml/solution/{id}/predict` | Classification / prediction |
| NLQ | `POST /api/sn_nl_text_to_value/text_query` | Natural language queries |
| MS Copilot Bridge | `/api/sn_assist/copilot/topics` | Copilot 365 integration  |
| VA Streaming | `/api/sn_cs/stream` | Streaming VA responses  |

## Notes

- Predictive Intelligence models must be trained on your instance before use
- Agentic Playbooks require Now Assist Pro license on the latest release
- AI Search indexes are updated asynchronously — newly created records may not appear immediately
- `snow_na_summary_generate` and `snow_na_resolution_suggest` may be rate-limited depending on your Now Assist subscription tier
