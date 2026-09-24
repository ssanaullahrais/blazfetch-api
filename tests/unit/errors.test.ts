import { describe, expect, it } from 'vitest';
import { BlazfetchError } from '../../src/constants/errors';

describe('BlazfetchError', () => {
  it('maps UNSUPPORTED_PLATFORM to a 422 status', () => {
    const err = new BlazfetchError('UNSUPPORTED_PLATFORM', 'nope');
    expect(err.status).toBe(422);
    expect(err.code).toBe('UNSUPPORTED_PLATFORM');
  });

  it('maps PROCESS_TIMEOUT to a 504 status', () => {
    expect(new BlazfetchError('PROCESS_TIMEOUT', 'x').status).toBe(504);
  });

  it('maps LOGIN_REQUIRED to a 401 status', () => {
    expect(new BlazfetchError('LOGIN_REQUIRED', 'x').status).toBe(401);
  });
});
