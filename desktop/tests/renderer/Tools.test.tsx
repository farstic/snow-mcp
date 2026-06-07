import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Tools from '../../renderer/src/pages/Tools';

const SAMPLE_TOOLS = [
  {
    name: 'snow_inc_incident_read',
    description: 'Read an incident record',
    inputSchema: { properties: { number: { type: 'string' } }, required: ['number'] },
  },
  {
    name: 'snow_core_record_add',
    description: '[write] Create a new record',
    inputSchema: { properties: { table: { type: 'string' } }, required: ['table'] },
  },
];

const baseProps = {
  activeToolPackage: 'full',
  serverOnline: true,
  serverUrl: 'stdio',
  onRestart: vi.fn(),
};

describe('<Tools>', () => {
  it('loads tools on mount and renders them', async () => {
    (window.api.listTools as any).mockResolvedValueOnce(SAMPLE_TOOLS);
    render(<Tools {...baseProps} />);

    // Stable header element
    expect(await screen.findByRole('heading', { name: /tools/i })).toBeInTheDocument();
    // Tool name appears once loaded
    expect(await screen.findByText('snow_inc_incident_read')).toBeInTheDocument();
    expect(screen.getByText('snow_core_record_add')).toBeInTheDocument();
    expect(window.api.listTools).toHaveBeenCalled();
  });

  it('shows the empty state when no tools are returned', async () => {
    (window.api.listTools as any).mockResolvedValueOnce([]);
    render(<Tools {...baseProps} />);

    expect(await screen.findByText(/No tools loaded/i)).toBeInTheDocument();
  });

  it('filters the tool list via the search input', async () => {
    (window.api.listTools as any).mockResolvedValueOnce(SAMPLE_TOOLS);
    render(<Tools {...baseProps} />);

    await screen.findByText('snow_inc_incident_read');

    const search = screen.getByPlaceholderText(/search tools/i);
    fireEvent.change(search, { target: { value: 'incident' } });

    expect(screen.getByText('snow_inc_incident_read')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('snow_core_record_add')).not.toBeInTheDocument(),
    );
  });

  it('starts the server when offline and the Start Server button is clicked', async () => {
    (window.api.listTools as any).mockResolvedValueOnce(SAMPLE_TOOLS);
    const onRestart = vi.fn();
    render(<Tools {...baseProps} serverOnline={false} onRestart={onRestart} />);

    const startBtn = await screen.findByRole('button', { name: /start server/i });
    fireEvent.click(startBtn);

    await waitFor(() => expect(window.api.startServer).toHaveBeenCalled());
    await waitFor(() => expect(onRestart).toHaveBeenCalled());
  });
});
