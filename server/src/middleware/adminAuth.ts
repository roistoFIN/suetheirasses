import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Gates the `/api/admin/*` REST endpoints behind a single shared secret
 * (`ADMIN_TOKEN`), sent by the client as the `x-admin-token` header. There's no
 * broader auth system in this app (player identity is an unauthenticated id pair —
 * see README's session-resume trust model), so this is deliberately minimal: one
 * token, no users, no expiry. Fails closed — if `ADMIN_TOKEN` isn't configured, the
 * admin API is disabled entirely rather than silently accepting any request.
 */
export function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.ADMIN_TOKEN;
  if (!configured) {
    res.status(503).json({ error: 'Admin API disabled — ADMIN_TOKEN is not configured' });
    return;
  }

  const provided = req.header('x-admin-token');
  if (!provided || !safeCompare(provided, configured)) {
    res.status(401).json({ error: 'Invalid admin token' });
    return;
  }

  next();
}

/** Constant-time comparison — avoids leaking the token's length/prefix via response timing. */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
