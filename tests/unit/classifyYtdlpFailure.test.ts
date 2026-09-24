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

  it('reports DRM-protected media clearly', () => {
    expect(classifyYtdlpFailure('ERROR: This format is DRM protected').code).toBe('FORMAT_UNAVAILABLE');
  });

  it('maps a 404 to MEDIA_NOT_FOUND, not a rate limit', () => {
    expect(classifyYtdlpFailure('ERROR: [facebook] x: Unable to download webpage: HTTP Error 404: Not Found').code).toBe('MEDIA_NOT_FOUND');
  });

  it('recognises deleted, removed and never-existing media as MEDIA_NOT_FOUND', () => {
    for (const message of [
      'ERROR: [youtube] aaaaaaaaaaa: This video is unavailable',
      'ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader',
      'ERROR: [youtube] x: This video is no longer available because the YouTube account associated with this video has been terminated.',
      'ERROR: [twitter] 1: No video could be found in this tweet',
      'ERROR: [vimeo] 1: This video does not exist',
    ]) {
      expect(classifyYtdlpFailure(message).code, message).toBe('MEDIA_NOT_FOUND');
    }
  });

  it('still tells restrictions apart from removal', () => {
    expect(classifyYtdlpFailure('ERROR: This video is not available in your country').code).toBe('GEO_RESTRICTED');
    expect(classifyYtdlpFailure('ERROR: This video is private').code).toBe('PRIVATE_MEDIA');
    expect(classifyYtdlpFailure('ERROR: Sign in to confirm your age').code).toBe('LOGIN_REQUIRED');
    expect(classifyYtdlpFailure('ERROR: this content is age restricted').code).toBe('AGE_RESTRICTED');
    expect(classifyYtdlpFailure('ERROR: could not generate average').code).toBe('EXTRACTOR_FAILED');
  });
});
