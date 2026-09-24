/** SQLite's CURRENT_TIMESTAMP is a UTC string with no zone ("2026-01-01 12:00:00"), which `new Date()`
 *  would read as server-local time. Mark it as UTC so every driver agrees. */
export function toIso(value: Date | string | number): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
    return new Date(value.replace(' ', 'T') + 'Z').toISOString();
  }
  return new Date(value).toISOString();
}

export function toIsoOrNull(value: Date | string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : toIso(value);
}
