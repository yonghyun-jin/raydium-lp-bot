/**
 * Who may read the P&L.
 *
 * This service gets a public Railway domain and shows how much money the
 * operator has. It therefore FAILS CLOSED in the same sense the money path
 * does: a missing password is not "auth disabled for convenience", it is a
 * refusal to start. The alternative -- defaulting to open when a variable is
 * unset -- is how a deploy silently publishes a wallet's history.
 */

import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';

export interface Credentials {
  user: string;
  password: string;
}

/**
 * Read the credentials, or explain exactly what is missing.
 *
 * Returns a reason rather than throwing so the caller decides what a failure
 * means -- the server turns it into a refusal to listen.
 */
export function readCredentials(env: NodeJS.ProcessEnv): Credentials | { error: string } {
  const password = env.DASHBOARD_PASSWORD;

  if (!password) {
    return {
      error:
        'DASHBOARD_PASSWORD is not set. This service exposes wallet P&L on a ' +
        'public domain, so it refuses to start without one rather than ' +
        'defaulting to open.',
    };
  }

  if (password.length < 16) {
    return {
      error: `DASHBOARD_PASSWORD is ${password.length} characters. Use at least 16 -- this endpoint is reachable from the internet.`,
    };
  }

  return { user: env.DASHBOARD_USER || 'operator', password };
}

/** Constant-time compare that does not leak length through early return. */
function matches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so the timing does not distinguish "wrong
    // length" from "wrong value".
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * HTTP Basic, because a browser can do it with no login page and no session
 * store. There is one operator; anything more is machinery without a user.
 */
export function basicAuth(credentials: Credentials) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');

    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const user = decoded.slice(0, separator);
      const password = decoded.slice(separator + 1);

      if (matches(user, credentials.user) && matches(password, credentials.password)) {
        next();
        return;
      }
    }

    res
      .set('WWW-Authenticate', 'Basic realm="lp-dashboard", charset="UTF-8"')
      .status(401)
      .send('Authentication required.');
  };
}
