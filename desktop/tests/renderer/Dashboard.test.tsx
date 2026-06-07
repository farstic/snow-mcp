import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dashboard from '../../renderer/src/pages/Dashboard';
import type { AppInstance } from '../../renderer/src/App';

function makeProps(overrides: Partial<React.ComponentProps<typeof Dashboard>> = {}) {
  return {
    instances: [] as AppInstance[],
    serverOnline: false,
    appVersion: '1.0.0',
    serverUrl: 'stdio',
    onRefresh: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
}

const sampleInstance: AppInstance = {
  name: 'Dev PDI',
  url: 'https://dev12345.service-now.com',
  active: true,
  group: 'default',
  environment: 'dev',
  toolPackage: 'service_desk',
  writeEnabled: true,
  authMethod: 'basic',
};

describe('<Dashboard>', () => {
  it('renders the header and the empty-instances state without throwing', () => {
    render(<Dashboard {...makeProps()} />);
    expect(screen.getByRole('heading', { name: /Dashboard/i })).toBeInTheDocument();
    expect(screen.getByText(/No instances configured/i)).toBeInTheDocument();
  });

  it('invokes onRefresh when the refresh control is clicked', async () => {
    const props = makeProps();
    render(<Dashboard {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    expect(props.onRefresh).toHaveBeenCalled();
  });

  it('navigates via the quick action buttons', async () => {
    const props = makeProps();
    render(<Dashboard {...props} />);
    await userEvent.click(screen.getByRole('button', { name: /Start Chat/i }));
    await userEvent.click(screen.getByRole('button', { name: /Browse Tools/i }));
    expect(props.onNavigate).toHaveBeenCalledWith('chat');
    expect(props.onNavigate).toHaveBeenCalledWith('tools');
  });

  it('starts the server via the api when offline and the start button is clicked', async () => {
    (window.api.startServer as any).mockResolvedValueOnce({ success: true });
    render(<Dashboard {...makeProps({ serverOnline: false })} />);
    // Multiple buttons contain "Start" (e.g. "Start Chat"); the server control's
    // accessible name is exactly the play-glyph "Start" button.
    const startBtns = screen.getAllByRole('button', { name: /Start/i });
    const serverStartBtn = startBtns.find(b => !/chat/i.test(b.textContent ?? ''));
    expect(serverStartBtn).toBeTruthy();
    fireEvent.click(serverStartBtn!);
    expect(window.api.startServer).toHaveBeenCalled();
  });

  it('renders a configured instance row', () => {
    render(<Dashboard {...makeProps({ instances: [sampleInstance] })} />);
    // The name/url appear in both a stat card and the instance row, so assert
    // they are present at least once rather than requiring a unique match.
    expect(screen.getAllByText(sampleInstance.name).length).toBeGreaterThan(0);
    expect(screen.getAllByText(sampleInstance.url).length).toBeGreaterThan(0);
  });
});
