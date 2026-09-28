/**
 * A Content-Disposition value that cannot be bent by the file name: control characters, quotes and backslashes are
 * removed from the plain name, and the real (possibly non-ASCII) name travels in the RFC 5987 `filename*` field.
 */
export function attachmentHeader(filename: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping control characters, not a typo
  const clean = filename.replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim() || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
