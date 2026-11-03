/**
 * One fetch, two outcomes, and a failure already classified.
 *
 * Shared by both endpoints so neither can drift into reporting a failure
 * differently from the other, and written as a returned outcome rather than a
 * thrown error because the three failure shapes are not interchangeable --
 * collapsing them into one `catch` is what produced a single heading for all of
 * them. A 200 that is not JSON goes to `transportFailure` on purpose: the
 * request landed on the SPA catch-all instead of the API, so the API was not
 * reached.
 *
 * In `lib/` rather than beside the components because it is the one piece of
 * the shell with no JSX in it, and the root Jest suite cannot import a module
 * that has any.
 */

import { httpFailure, transportFailure, type Failure } from '@/lib/failure';

export async function read<T>(
  endpoint: string,
  subject: string
): Promise<{ data: T } | { failure: Failure }> {
  let response: Response;

  try {
    response = await fetch(endpoint);
  } catch (error) {
    return { failure: transportFailure(endpoint, error) };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return { failure: httpFailure(subject, response.status, body) };
  }

  try {
    return { data: (await response.json()) as T };
  } catch (error) {
    return { failure: transportFailure(endpoint, error) };
  }
}
