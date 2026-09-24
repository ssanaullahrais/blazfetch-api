import { describe, expect, it } from 'vitest';
import { issuePass, passIsValid } from '../../src/services/turnstileService';

describe('turnstile pass', () => {
  it('is valid for the visitor it was issued to, until it expires', () => {
    const now = Date.now();
    const { value } = issuePass('guest-1', now);
    expect(passIsValid(value, 'guest-1', now + 1000)).toBe(true);
    expect(passIsValid(value, 'guest-1', now + 3_600_000)).toBe(false);
  });

  it('rejects another visitor, a tampered value and empty input', () => {
    const { value } = issuePass('guest-1');
    expect(passIsValid(value, 'guest-2')).toBe(false);
    expect(passIsValid(value.replace(/.$/, 'x'), 'guest-1')).toBe(false);
    expect(passIsValid(`9999999999.guest-1.${value.split('.').pop()}`, 'guest-1')).toBe(false);
    expect(passIsValid(undefined, 'guest-1')).toBe(false);
    expect(passIsValid(value, undefined)).toBe(false);
  });
});
