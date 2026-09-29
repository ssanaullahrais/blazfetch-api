import { env } from '../../config/env';

/** Shared by metadata, prepared downloads and stdout streams. */
export function withYtdlpRuntime(args: string[]): string[] {
  return [
    '--js-runtimes', `node:${process.execPath}`,
    ...(env.YTDLP_REMOTE_EJS_ENABLED ? ['--remote-components', 'ejs:github'] : []),
    ...(env.YTDLP_PROXY_URL ? ['--proxy', env.YTDLP_PROXY_URL] : []),
    ...args,
  ];
}

/** ffmpeg honors the standard lower-case proxy variables for HTTP(S) inputs. */
export function ffmpegProxyEnvironment(): NodeJS.ProcessEnv | undefined {
  if (!env.YTDLP_PROXY_URL) return undefined;
  return {
    ...process.env,
    http_proxy: env.YTDLP_PROXY_URL,
    https_proxy: env.YTDLP_PROXY_URL,
    no_proxy: '127.0.0.1,localhost',
  };
}
