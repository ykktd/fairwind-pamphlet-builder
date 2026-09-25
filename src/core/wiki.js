const PROFILE_LINE = /^\s*p[.．]\s*\d+\s+(.+?)\s*[（(]\s*(.+?)\s*[）)]\s*$/i;

export function parseWikiProfiles(text) {
  const profiles = [];
  const errors = [];
  for (const [index, raw] of String(text ?? '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(PROFILE_LINE);
    if (!match) {
      errors.push({ line: index + 1, value: raw });
      continue;
    }
    profiles.push({ name: match[1].trim(), detail: match[2].trim() });
  }
  return { profiles, errors };
}
