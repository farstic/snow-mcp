import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Settings from '../../renderer/src/pages/Settings';
import { DEFAULT_SETTINGS } from '../../renderer/src/App';

function makeProps(overrides: Partial<React.ComponentProps<typeof Settings>> = {}) {
  return {
    settings: DEFAULT_SETTINGS,
    activeInstance: undefined,
    onNavigate: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('<Settings>', () => {
  it('renders the settings page with a save button and provider list', () => {
    render(<Settings {...makeProps()} />);
    // Stable heading and primary action
    expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    // At least one known AI provider card is rendered
    expect(screen.getByText(/Claude \(Anthropic\)/i)).toBeInTheDocument();
  });

  it('calls onSave when the Save Changes button is clicked', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<Settings {...props} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(props.onSave).toHaveBeenCalledTimes(1);
    // It saves the current draft, which starts from the provided settings
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ activeProvider: DEFAULT_SETTINGS.activeProvider }),
    );
  });

  it('navigates to instances when configuring a ServiceNow instance', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<Settings {...props} />);

    // Expand the collapsible ServiceNow Connection section
    await user.click(screen.getByText(/ServiceNow Connection/i));

    const configureBtn = await screen.findByRole('button', {
      name: /configure servicenow instance/i,
    });
    await user.click(configureBtn);

    expect(props.onNavigate).toHaveBeenCalledWith('instances');
  });

  it('opens an external link from the Support section', async () => {
    const user = userEvent.setup();
    render(<Settings {...makeProps()} />);

    await user.click(screen.getByRole('button', { name: /github issues/i }));

    expect(window.api.openExternal).toHaveBeenCalled();
  });
});
