import { describe, expect, it } from 'vitest';
import { classifyYtdlpFailure } from '../../src/core/ytdlp/ytdlpRunner';

describe('classifyYtdlpFailure', () => {
  it('does not mistake "webpage" for an age restriction', () => {
    const err = classifyYtdlpFailure('ERROR: [Newgrounds] 841932: Unable to download webpage: Read timed out');
    expect(err.code).toBe('PLATFORM_RATE_LIMITED');
  });

  it('detects real age restrictions', () => {
    expect(classifyYtdlpFailure('ERROR: This video is age-restricted').code).toBe('AGE_RESTRICTED');
    expect(classifyYtdlpFailure('ERROR: Sign in to confirm your age').code).toBe('LOGIN_REQUIRED');
  });

  it('does not treat words like "generate" or "average" as special cases', () => {
    expect(classifyYtdlpFailure('ERROR: could not generate average').code).toBe('EXTRACTOR_FAILED');
  });
});
