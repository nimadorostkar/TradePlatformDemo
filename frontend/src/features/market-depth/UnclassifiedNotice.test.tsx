import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UnclassifiedNotice } from './MarketDepthWidget';

/**
 * The footer is the only place the ladder admits it is incomplete, and it is
 * read by someone deciding whether to trust the levels above it.
 *
 * It used to say entries "could not be classified as bid or ask" — a sentence
 * about our parser, in our vocabulary, that never stated what happened to the
 * market data. It is worth pinning both that the new wording says who did what,
 * and that the notice stays absent when there is nothing to admit: a footer
 * that appears on a healthy book is a false alarm on every symbol.
 */
describe('UnclassifiedNotice', () => {
  it('names the server as the one that omitted the side', () => {
    render(<UnclassifiedNotice count={1} />);
    expect(
      screen.getByText(
        'The trading server sent 1 price level without saying whether it was a buy or a sell, so it is left out of the ladder above.',
      ),
    ).toBeInTheDocument();
  });

  it('agrees in number for more than one level', () => {
    render(<UnclassifiedNotice count={3} />);
    expect(
      screen.getByText(
        'The trading server sent 3 price levels without saying whether they were buys or sells, so they are left out of the ladder above.',
      ),
    ).toBeInTheDocument();
  });

  // A gateway too old to count them reports null, which is "no claim either
  // way" — not a claim that some were dropped.
  it.each([[0], [null]])('says nothing when there is nothing to admit (%s)', (count) => {
    const { container } = render(<UnclassifiedNotice count={count} />);
    expect(container).toBeEmptyDOMElement();
  });
});
