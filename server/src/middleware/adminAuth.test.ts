import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requireAdminToken } from './adminAuth';
import type { Request, Response, NextFunction } from 'express';

function makeReq(headerValue: string | undefined): Request {
  return { header: (name: string) => (name === 'x-admin-token' ? headerValue : undefined) } as unknown as Request;
}

function makeRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('requireAdminToken', () => {
  const originalToken = process.env.ADMIN_TOKEN;
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = originalToken;
  });

  it('fails closed with 503 when ADMIN_TOKEN is not configured, even with a header supplied', () => {
    delete process.env.ADMIN_TOKEN;
    const req = makeReq('anything');
    const res = makeRes();

    requireAdminToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 401 when no header is supplied', () => {
    process.env.ADMIN_TOKEN = 'secret-token';
    const req = makeReq(undefined);
    const res = makeRes();

    requireAdminToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the header does not match', () => {
    process.env.ADMIN_TOKEN = 'secret-token';
    const req = makeReq('wrong-token');
    const res = makeRes();

    requireAdminToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the header is a different length than the configured token', () => {
    // Exercises the length-mismatch branch of the constant-time compare directly,
    // since timingSafeEqual throws on mismatched buffer lengths if not guarded.
    process.env.ADMIN_TOKEN = 'secret-token';
    const req = makeReq('short');
    const res = makeRes();

    requireAdminToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the header matches the configured token', () => {
    process.env.ADMIN_TOKEN = 'secret-token';
    const req = makeReq('secret-token');
    const res = makeRes();

    requireAdminToken(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
