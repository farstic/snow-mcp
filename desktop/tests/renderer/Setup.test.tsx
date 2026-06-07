import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Setup from '../../renderer/src/pages/Setup';

function renderSetup(overrides: Partial<React.ComponentProps<typeof Setup>> = {}) {
  const props = {
    onComplete: vi.fn(),
    onClose: vi.fn(),
    existingGroups: [] as string[],
    ...overrides,
  };
  render(<Setup {...props} />);
  return props;
}

describe('<Setup>', () => {
  it('renders the welcome step with a get-started action', () => {
    renderSetup();
    expect(screen.getByText(/Welcome to/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument();
  });

  it('advances to the instance step when getting started', async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(screen.getByRole('button', { name: /get started/i }));
    // The URL step shows the instance heading and its short-name field.
    expect(await screen.findByText(/ServiceNow Instance/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/yourcompany/i)).toBeInTheDocument();
  });

  it('invokes onClose when the welcome cancel button is clicked', async () => {
    const user = userEvent.setup();
    const props = renderSetup();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(props.onClose).toHaveBeenCalled();
  });
});
