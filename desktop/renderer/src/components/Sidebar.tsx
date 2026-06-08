import React from 'react';
import type { Page, ThemeMode } from '../App.js';
import { useTheme } from '../App.js';

interface Props {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  instanceName?: string;
  instanceCount: number;
  serverOnline: boolean;
}

// SVG nav icons (Feather-style, 18×18) — inherit row color via currentColor
const NAV_ICONS: Record<Page, React.ReactNode> = {
  dashboard: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  ),
  chat: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
    </svg>
  ),
  tools: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>
    </svg>
  ),
  instances: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
    </svg>
  ),
  logs: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
  ),
  settings: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  ),
};

const NAV: { id: Page; label: string; live?: boolean }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'chat',      label: 'AI Chat', live: true },
  { id: 'tools',     label: 'Tools' },
  { id: 'instances', label: 'Instances' },
  { id: 'logs',      label: 'Audit Log' },
  { id: 'settings',  label: 'Settings' },
];

// MONOLITH square monogram — ink block + cobalt lower-right quadrant + paper inset notch
function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ flexShrink: 0, display: 'block' }}>
      <rect x="1" y="1" width="30" height="30" fill="var(--ink)" />
      <rect x="16" y="16" width="15" height="15" fill="var(--accent)" />
      <rect x="6.5" y="6.5" width="9" height="9" fill="var(--paper-2)" />
      <rect x="1" y="1" width="30" height="30" fill="none" stroke="var(--paper)" strokeWidth="1.5" />
    </svg>
  );
}

export default function Sidebar({ currentPage, onNavigate, instanceName, instanceCount, serverOnline }: Props): React.ReactElement {
  const { mode, setMode } = useTheme();

  return (
    <aside style={{
      width: 'var(--rail)', flexShrink: 0, background: 'var(--paper)',
      borderRight: 'var(--bw-2) solid var(--ink)', display: 'flex', flexDirection: 'column',
    }}>
      {/* macOS traffic-light drag spacer */}
      <div style={{ height: 'var(--titlebar)', flexShrink: 0, WebkitAppRegion: 'drag' } as React.CSSProperties} />

      {/* Brand block — inverted ink */}
      <div style={{
        background: 'var(--ink)', color: 'var(--paper)', padding: '16px 18px',
        display: 'flex', alignItems: 'center', gap: 12, borderBottom: 'var(--bw-2) solid var(--ink)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}>
        <LogoMark size={32} />
        <div style={{ lineHeight: 1.1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14, letterSpacing: '0.02em' }}>SERVICENOW</div>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14, color: 'var(--accent)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            MCP{instanceName ? ` / ${instanceName}` : ''}
          </div>
        </div>
      </div>

      {/* Numbered nav */}
      <nav style={{ flex: 1, overflowY: 'auto' }}>
        {NAV.map((item, i) => {
          const active = currentPage === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '15px 18px', textAlign: 'left',
                border: 'none', borderBottom: 'var(--bw) solid var(--line-soft)', cursor: 'pointer',
                backgroundColor: active ? 'var(--accent)' : 'transparent',
                color: active ? 'var(--accent-ink)' : 'var(--ink)',
                transition: 'color .1s',
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.backgroundColor = 'var(--paper-3)'; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, width: 20, color: active ? 'var(--accent-ink)' : 'var(--ink-3)' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span style={{ display: 'flex', flexShrink: 0 }}>{NAV_ICONS[item.id]}</span>
              <span style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {item.label}
              </span>
              {item.live && <span style={{ width: 7, height: 7, background: active ? 'var(--accent-ink)' : 'var(--accent)' }} />}
            </button>
          );
        })}
      </nav>

      {/* Footer: status + LIGHT/DARK toggle */}
      <div style={{ borderTop: 'var(--bw-2) solid var(--ink)' }}>
        <div style={{ padding: '12px 18px', borderBottom: 'var(--bw) solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 9, height: 9, flexShrink: 0, background: serverOnline ? 'var(--ok)' : 'var(--ink-3)' }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-2)' }}>
            {serverOnline ? `Server online${instanceCount > 0 ? ` / ${instanceCount} inst` : ''}` : 'Server offline'}
          </span>
        </div>
        <div style={{ display: 'flex' }}>
          {(['light', 'dark'] as ThemeMode[]).map((m, i) => {
            const on = mode === m;
            return (
              <button key={m} onClick={() => setMode(m)} style={{
                flex: 1, padding: '11px 0', border: 'none',
                borderRight: i === 0 ? 'var(--bw) solid var(--line-soft)' : 'none',
                fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', cursor: 'pointer',
                background: on ? 'var(--ink)' : 'transparent', color: on ? 'var(--paper)' : 'var(--ink-3)',
              }}>{m}</button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
