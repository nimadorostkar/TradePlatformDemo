import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountPicker } from './AccountPicker';
import type { AccountOption } from '@/integrations/gateway/mappers/to-domain';

const account = (login: string, name: string, overrides: Partial<AccountOption> = {}) =>
  ({
    login,
    name,
    typeId: 1,
    server: 'Opogroup-Server1',
    currency: 'USD',
    readOnly: false,
    enabled: true,
    suffix: '',
    ...overrides,
  }) as AccountOption;

// The shape that made the bare <select> unusable: many accounts, named only by
// their type and number.
const options = [
  account('600140221', 'ECN Pro 600140221'),
  account('600140222', 'ECN Pro 600140222', { readOnly: true }),
  account('123456815', 'Standard 123456815'),
  account('113458011', 'Standard High Leverage 113458011', { currency: 'EUR' }),
  account('183456790', 'Social 183456790'),
];

function setup(onSelect = vi.fn()) {
  render(
    <AccountPicker
      options={options}
      activeLogin="123456815"
      disabled={false}
      onSelect={onSelect}
    />,
  );
  return { onSelect, user: userEvent.setup() };
}

describe('AccountPicker', () => {
  it('shows the active account without opening anything', () => {
    setup();
    expect(screen.getByLabelText('Select trading account')).toHaveTextContent('Standard 123456815');
  });

  it('filters by account number', async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText('Select trading account'));
    await user.type(screen.getByLabelText('Search accounts'), '18345');

    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getAllByRole('option')).toHaveLength(1);
    expect(within(listbox).getByRole('option')).toHaveTextContent('183456790');
  });

  it('filters by type and by currency', async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText('Select trading account'));
    const search = screen.getByLabelText('Search accounts');

    await user.type(search, 'ecn');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2);

    await user.clear(search);
    await user.type(search, 'eur');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
  });

  it('groups the list by account type', async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText('Select trading account'));

    expect(screen.getByRole('group', { name: 'ECN Pro' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Standard' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Social' })).toBeInTheDocument();
  });

  it('marks a read-only account so it is recognisable before it is chosen', async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText('Select trading account'));

    const readOnly = screen.getByRole('option', { name: /600140222/ });
    expect(within(readOnly).getByText('Read-only')).toBeInTheDocument();
  });

  it('selects with the keyboard alone', async () => {
    const { user, onSelect } = setup();
    await user.click(screen.getByLabelText('Select trading account'));
    await user.type(screen.getByLabelText('Search accounts'), '600140221');
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('600140221');
  });

  it('does not re-switch to the account already in use', async () => {
    // The list opens on the current account, so Enter must be a no-op rather
    // than a 45-second switch to where the trader already is.
    const { user, onSelect } = setup();
    await user.click(screen.getByLabelText('Select trading account'));
    await user.keyboard('{Enter}');

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes on Escape without selecting', async () => {
    const { user, onSelect } = setup();
    const button = screen.getByLabelText('Select trading account');
    await user.click(button);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
  });

  it('says so when a search matches nothing', async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText('Select trading account'));
    await user.type(screen.getByLabelText('Search accounts'), 'zzzz');

    expect(screen.getByText('No matching accounts')).toBeInTheDocument();
  });

  it('cannot be opened while a switch is in flight', async () => {
    render(<AccountPicker options={options} activeLogin="123456815" disabled onSelect={vi.fn()} />);
    expect(screen.getByLabelText('Select trading account')).toBeDisabled();
  });
});
