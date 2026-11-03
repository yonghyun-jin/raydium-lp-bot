import { decideObservation } from '../../src/db/observationCadence';

/**
 * `position_observations` had no writer, and that absence blocked three
 * separate questions: how long a position actually earns fees, how often price
 * reverts into a range it left, and how far a hold-instead-of-close policy may
 * let price run. The transitions are what make time-in-range exact, so the
 * rules about when a row is written are the rules about whether that series
 * can be trusted at all.
 */
describe('when an observation is written', () => {
  const base = { storedInRange: true, inRange: true, valueUsd: 3000, heartbeat: false };

  it('writes a TRANSITION when the position leaves the range', () => {
    expect(decideObservation({ ...base, inRange: false })).toEqual({
      write: true,
      reason: 'transition',
    });
  });

  it('writes a TRANSITION when it comes back in', () => {
    expect(decideObservation({ ...base, storedInRange: false, inRange: true })).toEqual({
      write: true,
      reason: 'transition',
    });
  });

  it('labels a crossing that lands on a heartbeat tick a TRANSITION', () => {
    // Otherwise a crossing is silently filed as a sample and the exact time of
    // the only event this series must not miss is lost.
    expect(decideObservation({ ...base, inRange: false, heartbeat: true })).toEqual({
      write: true,
      reason: 'transition',
    });
  });

  it('writes nothing on a tick where nothing changed', () => {
    expect(decideObservation(base)).toEqual({ write: false, reason: 'no-change' });
  });

  it('writes a heartbeat when the interval is due', () => {
    expect(decideObservation({ ...base, heartbeat: true })).toEqual({
      write: true,
      reason: 'heartbeat',
    });
  });

  describe('the first sight of a position is a baseline, not a crossing', () => {
    it('writes a heartbeat when nothing is stored yet', () => {
      // `last_in_range` is null until the first reading. Calling that a
      // transition would put a range change in the series that never happened
      // -- and after every redeploy, if the state lived in memory.
      expect(decideObservation({ ...base, storedInRange: null })).toEqual({
        write: true,
        reason: 'heartbeat',
      });
    });

    it('still calls it a baseline when the position starts OUT of range', () => {
      expect(
        decideObservation({ ...base, storedInRange: null, inRange: false })
      ).toEqual({ write: true, reason: 'heartbeat' });
    });
  });

  describe('an unknown value skips the row rather than writing a zero', () => {
    for (const [name, valueUsd] of [
      ['null', null],
      ['undefined', undefined],
      ['NaN', NaN],
      ['Infinity', Infinity],
    ] as const) {
      it(`skips on ${name}`, () => {
        // `value_usd` is NOT NULL, and a 0 reads as a worthless position in the
        // one series a fee curve is computed from.
        expect(decideObservation({ ...base, inRange: false, valueUsd })).toEqual({
          write: false,
          reason: 'value-unknown',
        });
      });
    }

    it('skips even a TRANSITION it cannot value, rather than invent one', () => {
      const d = decideObservation({ ...base, inRange: false, valueUsd: null });
      expect(d.write).toBe(false);
    });
  });
});

describe('the writer is wired to the decision', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/db/position.ts'),
    'utf8'
  );

  it('recordPositionReading asks decideObservation rather than re-deriving it', () => {
    expect(source).toMatch(/decideObservation\(\{/);
    expect(source).toMatch(/storedInRange: previous\.lastInRange/);
  });

  it('reads the PREVIOUS range state before overwriting it', () => {
    // The update sets `lastInRange`, so the comparison has to happen first or
    // every tick looks like "no change".
    const readAt = source.indexOf('select: { id: true, lastInRange: true }');
    const writeAt = source.indexOf('lastInRange: reading.inRange');
    expect(readAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(readAt);
  });

  it('writes the observation with the decision\'s own reason', () => {
    expect(source).toMatch(/reason: decision\.reason/);
  });
});
