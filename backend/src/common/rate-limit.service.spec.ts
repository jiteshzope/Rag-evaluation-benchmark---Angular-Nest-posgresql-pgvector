import { HttpException } from '@nestjs/common';
import { Request } from 'express';

import { MAX_RUNS_PER_DAY } from '../config/limits';
import { RateLimitService } from './rate-limit.service';

/** A request that looks like it came from one fixed visitor. */
const visitor = (ip = '10.0.0.1') => ({ ip, headers: {}, socket: {} }) as unknown as Request;

describe('RateLimitService', () => {
  let service: RateLimitService;

  beforeEach(() => {
    service = new RateLimitService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('counts each use against the visitor', () => {
    const req = visitor();
    service.consume(req, 'run');
    service.consume(req, 'run');

    expect(service.peek(req, 'run').used).toBe(2);
    expect(service.peek(req, 'run').remaining).toBe(MAX_RUNS_PER_DAY - 2);
  });

  it('keeps visitors independent', () => {
    service.consume(visitor('10.0.0.1'), 'run');
    expect(service.peek(visitor('10.0.0.2'), 'run').used).toBe(0);
  });

  it('throws 429 once the budget is gone', () => {
    const req = visitor();
    for (let i = 0; i < MAX_RUNS_PER_DAY; i++) service.consume(req, 'run');

    expect(() => service.consume(req, 'run')).toThrow(HttpException);
  });

  it('hands a use back on refund', () => {
    const req = visitor();
    service.consume(req, 'run');
    service.refund(req, 'run');

    expect(service.peek(req, 'run').used).toBe(0);
  });

  it('never refunds below zero', () => {
    const req = visitor();
    service.refund(req, 'run');
    service.refund(req, 'run');

    expect(service.peek(req, 'run').used).toBe(0);
  });

  describe('spendOn', () => {
    it('keeps the charge when the work succeeds', async () => {
      const req = visitor();
      const result = await service.spendOn(req, 'run', () => 'started');

      expect(result).toBe('started');
      expect(service.peek(req, 'run').used).toBe(1);
    });

    it('refunds when the work throws, and rethrows', async () => {
      const req = visitor();
      const boom = new Error('no knowledge base');

      await expect(
        service.spendOn(req, 'run', () => {
          throw boom;
        }),
      ).rejects.toThrow(boom);

      // A rejected request spends nothing, so it must cost nothing.
      expect(service.peek(req, 'run').used).toBe(0);
    });

    it('refunds when an async work rejects', async () => {
      const req = visitor();

      await expect(
        service.spendOn(req, 'upload', async () => {
          throw new Error('file too short');
        }),
      ).rejects.toThrow('file too short');

      expect(service.peek(req, 'upload').used).toBe(0);
    });

    it('does not refund a request that never got a charge', async () => {
      const req = visitor();
      for (let i = 0; i < MAX_RUNS_PER_DAY; i++) service.consume(req, 'run');

      // The 429 comes from consume, before the work runs — the counter must stay
      // at the limit rather than being decremented by a refund that never applied.
      await expect(service.spendOn(req, 'run', () => 'unreachable')).rejects.toThrow(HttpException);
      expect(service.peek(req, 'run').used).toBe(MAX_RUNS_PER_DAY);
    });
  });

  it('prefers the left-most X-Forwarded-For entry', () => {
    const proxied = {
      ip: '172.16.0.1',
      headers: { 'x-forwarded-for': '203.0.113.9, 172.16.0.1' },
      socket: {},
    } as unknown as Request;

    service.consume(proxied, 'run');

    const sameClient = {
      ip: '172.16.0.5',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      socket: {},
    } as unknown as Request;

    expect(service.peek(sameClient, 'run').used).toBe(1);
  });
});
