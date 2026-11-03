/**
 * A token, as its own mark beside its symbol.
 *
 * THE SYMBOL STAYS, and that is the same rule the movement dot follows: the
 * logo is never the only signal, because a reader who does not recognise it
 * has to be able to read the row anyway. `aria-hidden` for the same reason —
 * the word beside it is already the announcement.
 *
 * A STATIC MAP, NOT `@web3icons/react`'s dynamic lookup. The dynamic one
 * takes a symbol string and resolves at runtime, which defeats tree-shaking
 * on a package that unpacks to 102MB — measured, each branded token logo is
 * a multi-path colour SVG costing ~3.3KB in the bundle against ~0.3KB for a
 * Tabler line icon, so the set has to stay bounded. These two are every
 * token this bot has ever moved. Anything else falls back to the symbol
 * alone, which is exactly what the column showed before.
 */

import { TokenSOL, TokenUSDC } from '@web3icons/react';

const MARKS: Record<string, typeof TokenSOL> = {
  SOL: TokenSOL,
  USDC: TokenUSDC,
};

export function TokenMark({ token }: { token: string }) {
  const Mark = MARKS[token];
  return (
    <span className="inline-flex items-center gap-1.5">
      {Mark && <Mark variant="branded" size={14} className="shrink-0" aria-hidden />}
      {token}
    </span>
  );
}
