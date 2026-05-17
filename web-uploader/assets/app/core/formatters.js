export function formatErrorMessage(error, fallback = 'Unknown error') {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  return error.message || fallback;
}

export function formatCount(value, locale = undefined) {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString(locale);
}
