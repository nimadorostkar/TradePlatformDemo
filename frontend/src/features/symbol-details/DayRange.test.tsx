import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DayRange } from './SymbolDetailsWidget';

/**
 * The meter is read at a glance, so what it claims has to be right at a glance:
 * the fill and the marker must agree with each other and with the number they
 * came from, and neither may appear when there is no position to state.
 */
describe('DayRange', () => {
  it('fills to the price and points at the same spot', () => {
    render(<DayRange low="1.16681" high="1.17107" position={25.4} />);
    expect(screen.getByTestId('day-range-fill')).toHaveStyle({ width: '25.4%' });
    expect(screen.getByTestId('day-range-marker')).toHaveStyle({ left: '25.4%' });
  });

  it('states the bounds and the position to a screen reader', () => {
    render(<DayRange low="1.16681" high="1.17107" position={25.4} />);
    expect(
      screen.getByLabelText("Day's range 1.16681 to 1.17107, price 25% up the range"),
    ).toBeInTheDocument();
  });

  // A price sitting exactly on the low is a real reading, not a missing one:
  // the empty track IS the statement, and the marker still marks the spot.
  it('keeps the marker at the low when the price is the low', () => {
    render(<DayRange low="1.16681" high="1.17107" position={0} />);
    expect(screen.getByTestId('day-range-fill')).toHaveStyle({ width: '0%' });
    expect(screen.getByTestId('day-range-marker')).toHaveStyle({ left: '0%' });
  });

  // A day with no width has no position inside it. Drawing a fill here would
  // invent a location the data does not have.
  it('draws a bare track when the day has no span', () => {
    render(<DayRange low="1.16779" high="1.16779" position={null} />);
    expect(screen.queryByTestId('day-range-fill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('day-range-marker')).not.toBeInTheDocument();
    expect(screen.getByLabelText("Day's range 1.16779 to 1.16779")).toBeInTheDocument();
  });
});
