/**
 * The bundle must survive an API older than itself.
 *
 * `dashboard/web/src/App.tsx` builds a Map from `data.unrealised`. When the
 * page was rebuilt against a server still holding its boot-time modules, that
 * field was absent, `.map()` threw, React unmounted, and the dashboard went
 * WHITE -- no figure, no error, nothing but a console trace. A missing number
 * had been fine all along (it reaches `signedUsd` and prints "unknown"); a
 * missing ARRAY was the shape that took the page down.
 *
 * These live in the root suite because the root tsconfig has no JSX, so
 * anything it must test has to be a plain `.ts` module -- which is why the
 * tolerance was lifted out of the component at all.
 */

import { wireList } from '../../dashboard/web/src/lib/wire';

describe('a list the server may not know how to send', () => {
  it('passes a real list through untouched', () => {
    const marks = [{ operationId: 'op_a' }, { operationId: 'op_b' }];

    expect(wireList(marks)).toBe(marks);
  });

  it('turns an absent list into an empty one, so .map() cannot throw', () => {
    // Exactly the shape a server that predates the field sends.
    const stale = { completed: [], ledger: [] } as { unrealised?: unknown[] };

    expect(wireList(stale.unrealised as undefined)).toEqual([]);
    expect(() => wireList(stale.unrealised as undefined).map((m) => m)).not.toThrow();
  });

  it('treats null the same as absent -- JSON has both and they mean the same here', () => {
    expect(wireList(null)).toEqual([]);
  });

  /**
   * Narrow on purpose. A server that sends the right NAME carrying the wrong
   * SHAPE is a bug, and flattening it to [] would hide it behind a section
   * that simply never renders. Empty is the only thing this may invent.
   */
  it('does not invent entries, and empty stays empty', () => {
    expect(wireList([])).toEqual([]);
    expect(wireList(undefined)).toHaveLength(0);
  });
});
