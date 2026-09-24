import { PlatformId } from '../../constants/platforms';
import { BlazfetchError } from '../../constants/errors';
import { NormalizedUrlResult } from '../../utils/url';
import { PlatformAdapter } from './types';
import { GenericYtDlpAdapter } from './GenericYtDlpAdapter';
import { YouTubeAdapter } from './YouTubeAdapter';
import { TikTokAdapter } from './TikTokAdapter';
import { InstagramAdapter } from './InstagramAdapter';
import { VimeoAdapter } from './VimeoAdapter';

const GENERIC_PLATFORMS: PlatformId[] = [
  'twitter',
  'facebook',
  'reddit',
  'soundcloud',
  'pinterest',
  'snapchat',
  'dailymotion',
  'bluesky',
  'loom',
  'newgrounds',
  'rutube',
  'streamable',
  'twitch',
  'tumblr',
];

const adapters: PlatformAdapter[] = [
  new YouTubeAdapter(),
  new TikTokAdapter(),
  new InstagramAdapter(),
  new VimeoAdapter(),
  ...GENERIC_PLATFORMS.map((platform) => new GenericYtDlpAdapter(platform)),
];

const registry = new Map<PlatformId, PlatformAdapter>(adapters.map((a) => [a.platform, a]));

export function getAdapter(normalizedUrl: NormalizedUrlResult): PlatformAdapter {
  const adapter = registry.get(normalizedUrl.platform);
  if (!adapter) {
    throw new BlazfetchError('UNSUPPORTED_PLATFORM', 'This platform is currently not supported.');
  }
  return adapter;
}
