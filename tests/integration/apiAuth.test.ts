import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env.LOG_LEVEL = 'silent'; });
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { PLATFORMS } from '../../src/constants/platforms';

const key = 'test-only-api-key-not-a-production-secret';
let server: http.Server;
let base: string;
const original = { enabled: env.API_AUTH_ENABLED, key: env.API_AUTH_KEY };
beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => { env.API_AUTH_ENABLED = true; env.API_AUTH_KEY = key; });
afterAll(async () => {
  env.API_AUTH_ENABLED = original.enabled;
  env.API_AUTH_KEY = original.key;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('optional server-to-server API protection', () => {
  it('rejects missing and invalid credentials for every registered platform before extraction', async () => {
    for (const platform of PLATFORMS) {
      for (const headers of [{}, { 'X-API-Key': 'invalid-test-key' }]) {
        const response = await fetch(`${base}/api/v1/fetch`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ url: `https://${platform.domains[0]}/test` }),
        });
        expect(response.status, platform.id).toBe(401);
        expect((await response.json()).error.code).toBe('API_AUTH_REQUIRED');
      }
    }
  });
  it('leaves minimal health public and protects readiness', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/health/ready`)).status).toBe(401);
  });
  it('rejects missing, wrong and oversized keys with the same response', async () => {
    for (const supplied of [undefined, 'wrong', 'x'.repeat(257)]) {
      const response = await fetch(`${base}/api/v1/platforms`, { headers: supplied ? { 'X-API-Key': supplied } : {} });
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('API_AUTH_REQUIRED');
    }
  });
  it('accepts a correct header and remains backward compatible when disabled', async () => {
    expect((await fetch(`${base}/api/v1/platforms`, { headers: { 'X-API-Key': key } })).status).toBe(200);
    env.API_AUTH_ENABLED = false;
    expect((await fetch(`${base}/api/v1/platforms`)).status).toBe(200);
  });
  it('never treats query parameters or cookies as API credentials', async () => {
    expect((await fetch(`${base}/api/v1/platforms?apiKey=${key}`, { headers: { cookie: `X-API-Key=${key}` } })).status).toBe(401);
  });
  it('gates streaming, prepared jobs, bulk jobs, stats, config and verification centrally', async () => {
    for (const [method, route] of [
      ['GET', '/stream'], ['POST', '/fetch'], ['POST', '/download'], ['GET', '/jobs/example/download'],
      ['POST', '/playlist/download'], ['DELETE', '/playlist/downloads/example'],
      ['GET', '/stats/events'], ['GET', '/config'], ['POST', '/turnstile/verify'], ['GET', '/media/example'],
    ]) {
      expect((await fetch(`${base}/api/v1${route}`, { method })).status, route).toBe(401);
    }
    // A native browser GET reaches the existing stream validation once the trusted proxy supplies the key.
    expect((await fetch(`${base}/api/v1/stream`, { headers: { 'X-API-Key': key } })).status).toBe(400);
  });
  it('fails startup when enabled with no key, a short key, whitespace or an invalid flag', () => {
    for (const [enabled, value] of [['true', ''], ['true', 'short'], ['true', `${key} `], ['yes', key]]) {
      const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '-e', "import './src/config/env'"], {
        env: { ...process.env, VITEST: '1', API_AUTH_ENABLED: enabled, API_AUTH_KEY: value }, encoding: 'utf8', windowsHide: true,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(key);
    }
  });
  it('redacts the configured credential from request-header logs', () => {
    const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '-e', "import { logger } from './src/lib/logger'; logger.info({ req: { headers: { 'x-api-key': process.env.API_AUTH_KEY } } });"], {
      env: { ...process.env, VITEST: '1', APP_ENV: 'test', LOG_LEVEL: 'info', API_AUTH_ENABLED: 'true', API_AUTH_KEY: key }, encoding: 'utf8', windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stdout).not.toContain(key);
  });
});
