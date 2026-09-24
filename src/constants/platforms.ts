export type PlatformId =
  | 'youtube'
  | 'tiktok'
  | 'instagram'
  | 'twitter'
  | 'facebook'
  | 'vimeo'
  | 'reddit'
  | 'soundcloud'
  | 'pinterest'
  | 'snapchat'
  | 'dailymotion'
  | 'bluesky'
  | 'loom'
  | 'newgrounds'
  | 'rutube'
  | 'streamable'
  | 'twitch'
  | 'tumblr';

export interface PlatformDefinition {
  id: PlatformId;
  label: string;
  domains: string[];
}

export const PLATFORMS: PlatformDefinition[] = [
  { id: 'youtube', label: 'YouTube', domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'] },
  { id: 'tiktok', label: 'TikTok', domains: ['tiktok.com'] },
  { id: 'instagram', label: 'Instagram', domains: ['instagram.com', 'instagr.am'] },
  { id: 'twitter', label: 'X / Twitter', domains: ['x.com', 'twitter.com', 't.co'] },
  { id: 'facebook', label: 'Facebook', domains: ['facebook.com', 'fb.watch', 'fb.me'] },
  { id: 'vimeo', label: 'Vimeo', domains: ['vimeo.com'] },
  { id: 'reddit', label: 'Reddit', domains: ['reddit.com', 'redd.it'] },
  { id: 'soundcloud', label: 'SoundCloud', domains: ['soundcloud.com', 'snd.sc'] },
  {
    id: 'pinterest',
    label: 'Pinterest',
    domains: [
      'pinterest.com',
      'pinterest.ca',
      'pinterest.co.uk',
      'pinterest.de',
      'pinterest.fr',
      'pinterest.in',
      'pinterest.com.au',
      'pin.it',
    ],
  },
  { id: 'snapchat', label: 'Snapchat', domains: ['snapchat.com'] },
  { id: 'dailymotion', label: 'Dailymotion', domains: ['dailymotion.com', 'dai.ly'] },
  { id: 'bluesky', label: 'Bluesky', domains: ['bsky.app'] },
  { id: 'loom', label: 'Loom', domains: ['loom.com'] },
  { id: 'newgrounds', label: 'Newgrounds', domains: ['newgrounds.com'] },
  { id: 'rutube', label: 'Rutube', domains: ['rutube.ru'] },
  { id: 'streamable', label: 'Streamable', domains: ['streamable.com'] },
  { id: 'twitch', label: 'Twitch', domains: ['twitch.tv'] },
  { id: 'tumblr', label: 'Tumblr', domains: ['tumblr.com'] },
];

const DOMAIN_TO_PLATFORM = new Map<string, PlatformId>();
for (const platform of PLATFORMS) {
  for (const domain of platform.domains) {
    DOMAIN_TO_PLATFORM.set(domain, platform.id);
  }
}

/** Matches `hostname` against the whitelist, allowing subdomains (e.g. m.youtube.com). */
export function detectPlatformFromHostname(hostname: string): PlatformId | null {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  for (const [domain, platformId] of DOMAIN_TO_PLATFORM) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return platformId;
    }
  }
  return null;
}

export const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'si',
  'feature',
  'igsh',
  'igshid',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'ref_url',
  'spm',
  '_ga',
];
