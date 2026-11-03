/**
 * What the wire may be missing, and what the page does about it.
 *
 * The bundle and the API are two deploys, not one. Railway serves the built
 * assets from the same service that answers `/api/pnl`, but a long-running
 * `ts-node server/index.ts` holds its modules from boot -- so a rebuilt page
 * can be talking to a server that predates the field it wants. Locally that is
 * every single time until the server is restarted.
 *
 * A missing ARRAY is the dangerous shape. A missing number reaches `signedUsd`
 * and renders as "unknown", which is honest and visible; a missing array
 * reaches `.map()` and throws, and React unmounts the tree. The result is a
 * WHITE PAGE with the real cause only in the console -- strictly worse than any
 * wrong figure, because nothing on screen says anything at all.
 *
 * This is not a silent fallback. An absent list is rendered exactly as an empty
 * one would be: the section it feeds does not appear, which is what the page
 * looked like before the field existed. No figure is defaulted and no number is
 * invented -- the only claim made is "this response carried no such list",
 * which is true.
 */

/**
 * A list the server may not know how to send yet.
 *
 * Narrow on purpose: it accepts only an array or the absence of one, so a
 * server that sends a non-array of the right name is a bug that still shows
 * up rather than being quietly flattened away.
 */
export function wireList<T>(value: readonly T[] | undefined | null): readonly T[] {
  return Array.isArray(value) ? value : [];
}
