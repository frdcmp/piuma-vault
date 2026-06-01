// Ported from frontend/src/utils/dateTime.js so mobile and web format dates
// identically. Backend timestamps are UTC; we convert to the device timezone.

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Append "Z" to bare strings (e.g. "2026-04-24T14:00:00") so they're parsed
// as UTC rather than local time.
const parseUtc = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  const hasOffset = /[Z]$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s);
  const normalized = hasOffset ? s : `${s}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const formatDate = (value) => {
  const d = parseUtc(value);
  if (!d) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: TZ,
  }).formatToParts(d);
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  return `${day} ${month}, ${year}`;
};

export const formatTime = (value) => {
  const d = parseUtc(value);
  if (!d) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TZ,
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
};

export const formatDateTime = (value) => ({
  date: formatDate(value),
  time: formatTime(value),
});

export const timeAgo = (value) => {
  const d = parseUtc(value);
  if (!d) return '—';
  const diffMs = d.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return rtf.format(diffSec, 'second');
  if (abs < 3_600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3_600), 'hour');
  if (abs < 2_592_000) return rtf.format(Math.round(diffSec / 86_400), 'day');
  if (abs < 31_536_000) return rtf.format(Math.round(diffSec / 2_592_000), 'month');
  return rtf.format(Math.round(diffSec / 31_536_000), 'year');
};
