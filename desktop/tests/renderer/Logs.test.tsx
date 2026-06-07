import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Logs from '../../renderer/src/pages/Logs';

describe('<Logs>', () => {
  it('loads audit entries on mount and shows the empty state when there are none', async () => {
    (window.api.getAuditLogs as any).mockResolvedValueOnce([]);
    render(<Logs />);
    expect(await screen.findByText(/No audit log entries found/i)).toBeInTheDocument();
    expect(window.api.getAuditLogs).toHaveBeenCalled();
  });

  it('renders rows from audit entries under the Audit Log header', async () => {
    (window.api.getAuditLogs as any).mockResolvedValueOnce([
      { ts: new Date('2026-01-01T10:00:00Z').toISOString(), event: 'tool', tool: 'snow_inc_incident_read', instance: 'dev', success: true },
    ]);
    render(<Logs />);
    expect(await screen.findByText('snow_inc_incident_read')).toBeInTheDocument();
    expect(screen.getByText('Audit Log')).toBeInTheDocument();
  });
});
