export function readLastJsonLine(stdout = '') {
  const line = String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((entry) => {
      const trimmed = entry.trim();
      return trimmed.startsWith('{') || trimmed.startsWith('RESULT:{');
    });

  if (!line) return null;

  const trimmed = line.trim();
  const jsonText = trimmed.startsWith('RESULT:{')
    ? trimmed.slice('RESULT:'.length)
    : trimmed;

  return JSON.parse(jsonText);
}
