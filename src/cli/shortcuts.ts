/**
 * `servicenow-mcp shortcuts` — print all available commands and keyboard shortcuts
 * in a nicely formatted table.
 */
import chalk from 'chalk';

// Brand colors (matches servicenow-mcp.com — teal/navy palette)
const teal   = chalk.hex('#00D4AA');
const bright = chalk.hex('#00B899');
const dim    = chalk.gray;
const white  = chalk.bold;
const subtle = chalk.dim;
const accent = teal;
const brand  = teal;

function divider(): void {
  console.log(dim('  ' + '─'.repeat(62)));
}

function sectionHeader(title: string): void {
  console.log('');
  console.log(`  ${accent('▸')} ${white(title)}`);
  console.log('');
}

function row(left: string, right: string, leftWidth = 28): void {
  // Strip ANSI for padding calculation
  // eslint-disable-next-line no-control-regex
  const stripped = left.replace(/\x1B\[[0-9;]*m/g, '');
  const pad = Math.max(0, leftWidth - stripped.length);
  console.log(`    ${left}${' '.repeat(pad)} ${dim(right)}`);
}

export function runShortcuts(): void {
  console.log('');
  console.log(`  ${white('ServiceNow') + teal.bold(' MCP')}  ${dim('—')} ${subtle('All Commands & Shortcuts')}`);
  console.log('');
  divider();

  // ── Slash commands (type / in your AI client) ──────────────────────────────
  sectionHeader('Slash Commands  ' + dim('(type / in your AI client)'));

  const slashCommands: [string, string][] = [
    ['/morning-standup',   'Daily briefing: P1s, SLA breaches, pending changes'],
    ['/my-tickets',        'All open work items assigned to you'],
    ['/p1-alerts',         'Active Priority 1 incidents'],
    ['/my-changes',        'Pending change requests'],
    ['/knowledge-search',  'Search the knowledge base'],
    ['/create-incident',   'Guided incident creation'],
    ['/sla-breaches',      'Records currently breaching SLA'],
    ['/ci-health',         'CMDB CI health check'],
    ['/run-atf',           'Trigger an ATF test suite'],
    ['/switch-instance',   'Switch to a different ServiceNow instance'],
    ['/deploy-updateset',  'Preview and commit an Update Set'],
  ];

  for (const [cmd, desc] of slashCommands) {
    row(brand(cmd), desc);
  }

  // ── Terminal commands ───────────────────────────────────────────────────────
  sectionHeader('Terminal Commands  ' + dim('(run from your shell)'));

  const termCommands: [string, string][] = [
    ['servicenow-mcp run <capability>',   'Run an AI capability directly (BYOK)'],
    ['servicenow-mcp web',                'Open the ServiceNow MCP Toolkit web dashboard'],
    ['servicenow-mcp caps',               'List all 26 capabilities'],
    ['servicenow-mcp shortcuts',          'Show this help'],
    ['servicenow-mcp setup',              'Interactive setup wizard'],
    ['servicenow-mcp setup --add',        'Add another ServiceNow instance'],
    ['servicenow-mcp instances list',     'List all configured instances'],
    ['servicenow-mcp instances remove',   'Remove a configured instance'],
    ['servicenow-mcp auth login',         'Per-user OAuth login'],
    ['servicenow-mcp auth logout',        'Remove stored authentication token'],
    ['servicenow-mcp auth whoami',        'Show current authenticated user'],
  ];

  for (const [cmd, desc] of termCommands) {
    row(accent(cmd), desc, 36);
  }

  // ── @ Resource mentions ─────────────────────────────────────────────────────
  sectionHeader('@ Resource Mentions  ' + dim('(type @ in your AI client)'));

  const resources: [string, string][] = [
    ['@my-incidents',   'Open incidents assigned to you'],
    ['@open-changes',   'Change requests pending approval'],
    ['@sla-breaches',   'Records breaching SLA'],
    ['@instance:info',  'Current instance metadata'],
    ['@ci:{name}',      'CMDB CI lookup  (e.g. @ci:web-prod-01)'],
    ['@kb:{title}',     'KB article search  (e.g. @kb:VPN-setup)'],
  ];

  for (const [res, desc] of resources) {
    row(teal(res), desc);
  }

  // ── Keyboard shortcuts (ServiceNow MCP Toolkit web dashboard) ─────────────────────────────
  sectionHeader('Keyboard Shortcuts  ' + dim('(ServiceNow MCP Toolkit web dashboard)'));

  const keys: [string, string][] = [
    ['Ctrl+K  /  Cmd+K',    'Command palette'],
    ['Ctrl+/',              'Toggle sidebar'],
    ['Ctrl+Enter',          'Send message'],
    ['Ctrl+Shift+N',        'New conversation'],
    ['Escape',              'Close dialog / cancel'],
  ];

  for (const [key, desc] of keys) {
    row(bright(key), desc);
  }

  // ── Capability categories ───────────────────────────────────────────────────
  sectionHeader('Apex AI Capability Prefixes  ' + dim('(servicenow-mcp run <cap>)'));

  const capPrefixes: [string, string][] = [
    ['scan-{health|security|debt|upgrade|cmdb|automation}', 'Scan & Monitor (6)'],
    ['review-{code|acls|scripts|flows}',                    'Review & Audit (4)'],
    ['build-{business-rule|client-script|test-plan|app|flow|portal|uib|catalog|rest-api}', 'Build & Generate (9)'],
    ['ops-{triage|deploy|risk}',                            'Operations (3)'],
    ['docs-{app|release|runbook|script}',                   'Documentation (4)'],
  ];

  for (const [cap, label] of capPrefixes) {
    row(brand(cap), label, 56);
  }

  console.log('');
  divider();
  console.log('');
  console.log(`  ${dim('Full capability list:')} ${brand('servicenow-mcp caps')}`);
  console.log(`  ${dim('Documentation:     ')} ${accent('https://servicenow-mcp.com/docs')}`);
  console.log('');
}
