import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Chat from '../../renderer/src/pages/Chat';
import { DEFAULT_SETTINGS } from '../../renderer/src/App';

// jsdom does not implement scrollIntoView; Chat calls it in an effect on mount.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const baseProps = {
  settings: DEFAULT_SETTINGS,
  serverUrl: 'stdio',
  instances: [],
};

describe('<Chat>', () => {
  it('renders the chat header and loads the tool list on mount', async () => {
    render(<Chat {...baseProps} />);

    // Stable heading text
    expect(await screen.findByText(/AI Chat/i)).toBeInTheDocument();

    // Tools are fetched on mount for the slash-command picker
    expect(window.api.listTools).toHaveBeenCalled();
  });

  it('shows the empty-state prompt when there are no messages', async () => {
    render(<Chat {...baseProps} />);

    expect(
      await screen.findByText(/Ask anything about your ServiceNow instance/i),
    ).toBeInTheDocument();
  });

  it('clicking a suggestion sends a chat request via the api', async () => {
    (window.api.sendChat as any).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Here are your incidents.' }],
      stop_reason: 'end_turn',
    });

    // callProviderApi short-circuits with an error when no API key is set,
    // so provide a key for the active (anthropic) provider.
    const settingsWithKey = {
      ...DEFAULT_SETTINGS,
      providers: {
        ...DEFAULT_SETTINGS.providers,
        anthropic: { ...DEFAULT_SETTINGS.providers.anthropic, apiKey: 'test-key' },
      },
    };

    render(<Chat {...baseProps} settings={settingsWithKey} />);

    // Suggestion buttons render in the empty state
    const suggestion = await screen.findByRole('button', {
      name: /most recent open incidents/i,
    });
    fireEvent.click(suggestion);

    // send() is async (awaits callProviderApi → api.sendChat)
    await waitFor(() => expect(window.api.sendChat).toHaveBeenCalled());
  });

  it('renders one provider button per supported provider', async () => {
    render(<Chat {...baseProps} />);

    // Provider switcher exposes a button labelled "Claude" (anthropic)
    expect(
      await screen.findByRole('button', { name: /Claude/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ChatGPT/i })).toBeInTheDocument();
  });
});
