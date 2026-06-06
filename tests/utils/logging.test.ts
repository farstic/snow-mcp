import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../src/utils/logging.js';

describe('logger — LOG_LEVEL gating + REDACT_SENSITIVE_DATA', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
    delete process.env.LOG_LEVEL;
    delete process.env.REDACT_SENSITIVE_DATA;
  });

  it('suppresses messages above the configured level (LOG_LEVEL=error)', () => {
    process.env.LOG_LEVEL = 'error';
    logger.info('hello');
    logger.debug('dbg');
    logger.warn('warn');
    expect(spy).not.toHaveBeenCalled();
    logger.error('boom');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emits debug when LOG_LEVEL=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    logger.debug('dbg');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('defaults to info (debug hidden, info shown) when LOG_LEVEL is unset', () => {
    logger.debug('hidden');
    expect(spy).not.toHaveBeenCalled();
    logger.info('shown');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('redacts sensitive keys (deep) when REDACT_SENSITIVE_DATA=true', () => {
    process.env.LOG_LEVEL = 'info';
    process.env.REDACT_SENSITIVE_DATA = 'true';
    logger.info('auth', { username: 'amy', password: 'p@ss', nested: { api_key: 'k', ok: 1 } });
    expect(spy.mock.calls[0][1]).toEqual({
      username: 'amy',
      password: '***',
      nested: { api_key: '***', ok: 1 },
    });
  });

  it('leaves data untouched when REDACT_SENSITIVE_DATA is unset', () => {
    process.env.LOG_LEVEL = 'info';
    logger.info('auth', { password: 'p@ss' });
    expect(spy.mock.calls[0][1]).toEqual({ password: 'p@ss' });
  });
});
