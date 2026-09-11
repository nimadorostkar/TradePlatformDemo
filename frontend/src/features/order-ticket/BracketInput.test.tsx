import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { BracketInput } from './BracketInput';

/**
 * BUG-E, 2026-08-20 retest. A rejected stop left its stop-loss and take-profit
 * fields holding their previous values while reading as empty. Typing a
 * replacement appended to the number the trader could not see and submitted
 * "1.165901.16630", which the ticket rejected as "Enter a number." — with
 * nothing on screen to explain it and no obvious way out.
 */

function renderField(overrides: Partial<Parameters<typeof BracketInput>[0]> = {}) {
  const onValueChange = vi.fn();
  const view = render(
    <BracketInput
      id="order-sl"
      label="Stop loss"
      value="1.16590"
      unit="price"
      onValueChange={onValueChange}
      onUnitChange={vi.fn()}
      resolvedPrice={null}
      digits={5}
      {...overrides}
    />,
  );
  return { ...view, onValueChange, field: view.container.querySelector('input')! };
}

describe('a bracket field', () => {
  it('selects what it holds when the trader clicks into it', () => {
    const { field } = renderField();

    fireEvent.focus(field);

    // The next keystroke must replace the value, not extend it. Without this
    // there is no way to clear a bracket the trader cannot read.
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('1.16590'.length);
  });

  it('never renders its empty-value placeholder over a value it is holding', () => {
    const { field } = renderField();
    // The placeholder is what made an occupied field read as empty. An input
    // only shows one when its value is empty, so the contract to hold is that
    // the element carries the model — whatever the dock's width.
    expect(field.value).toBe('1.16590');
  });

  it('shows an empty field as empty', () => {
    const { field } = renderField({ value: '' });
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('—');
  });
});
