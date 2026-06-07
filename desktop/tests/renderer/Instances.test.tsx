import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Instances from '../../renderer/src/pages/Instances';
import type { AppInstance } from '../../renderer/src/App';

function makeInstance(overrides: Partial<AppInstance> = {}): AppInstance {
  return {
    name: 'Acme Dev',
    url: 'https://acme-dev.service-now.com',
    active: false,
    group: 'Acme',
    environment: 'dev',
    toolPackage: 'service_desk',
    writeEnabled: false,
    authMethod: 'basic',
    ...overrides,
  };
}

function makeProps(instances: AppInstance[] = [makeInstance()]) {
  return {
    instances,
    onRemove: vi.fn().mockResolvedValue(undefined),
    onSetDefault: vi.fn().mockResolvedValue(undefined),
    onTest: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    onAddInstance: vi.fn(),
  };
}

describe('<Instances>', () => {
  beforeEach(() => {
    // confirm() is used by the remove button; default to "yes"
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders without throwing and shows the page heading + instance', () => {
    const props = makeProps();
    render(<Instances {...props} />);

    expect(screen.getByRole('heading', { name: /instances/i })).toBeInTheDocument();
    // The single instance lives in an auto-expanded group, so its name shows.
    expect(screen.getByText(/Acme Dev/)).toBeInTheDocument();
  });

  it('shows the empty state when there are no instances', () => {
    const props = makeProps([]);
    render(<Instances {...props} />);

    expect(screen.getByText(/No instances configured yet/i)).toBeInTheDocument();
  });

  it('calls onAddInstance when the Add Instance button is clicked', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<Instances {...props} />);

    await user.click(screen.getByRole('button', { name: /add instance/i }));
    expect(props.onAddInstance).toHaveBeenCalled();
  });

  it('calls onSetDefault and onRemove for an inactive instance', async () => {
    const props = makeProps([makeInstance({ active: false })]);
    render(<Instances {...props} />);

    // Inactive instances expose a "Set Active" button.
    fireEvent.click(screen.getByRole('button', { name: /set active/i }));
    expect(props.onSetDefault).toHaveBeenCalledWith('Acme Dev');

    // The remove (✕) button confirms first; confirm is stubbed to true.
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    expect(props.onRemove).toHaveBeenCalledWith('Acme Dev');
  });
});
