import config from '../config';

/** HH:mm in the configured schedule timezone (default America/Chicago). */
export function currentLocalHHmm(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: config.scheduleTimezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour === '24' ? '00' : hour}:${minute}`;
}

/**
 * Returns true if `current` (HH:mm) falls inside the quiet-hours window.
 * Windows that wrap midnight (e.g. 22:00 → 07:00) are supported.
 * End is exclusive: end == current means quiet hours just ended.
 */
export function isInQuietWindow(current: string, start: string, end: string): boolean {
  if (start === end) return false;
  if (start < end) {
    return current >= start && current < end;
  }
  // Wraps midnight.
  return current >= start || current < end;
}

/**
 * Convenience wrapper: is the given user currently inside their configured
 * quiet-hours window? Both bounds must be set for the window to be active.
 */
export function isQuietNow(
  user: { quietHoursStart: string | null; quietHoursEnd: string | null },
  now: Date = new Date()
): boolean {
  if (!user.quietHoursStart || !user.quietHoursEnd) return false;
  return isInQuietWindow(currentLocalHHmm(now), user.quietHoursStart, user.quietHoursEnd);
}
