const SECRET_PATTERNS: RegExp[] = [
  /sk-(?:proj-)?[A-Za-z0-9_-]+/g,
  /\b\d{5,}:[A-Za-z0-9_-]{6,}\b/g,
  /session_string\s*=\s*[^,\s"}]+/gi,
  /api[_-]?key\s*[:=]\s*[^,\s"}]+/gi,
  /token\s*[:=]\s*[^,\s"}]+/gi,
];

const SENSITIVE_KEYS = new Set([
  'raw',
  'text',
  'displayName',
  'media',
  'mediaUrl',
  'bytes',
  'token',
  'session',
  'sessionString',
  'secret',
]);

export function redactString(input: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, '[redacted]'), input);
}

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEYS.has(key) ? '[redacted]' : redactValue(nested);
  }
  return output;
}

export function stableDigest(value: unknown): string {
  return redactString(JSON.stringify(redactValue(value)));
}

export function skeletonDigest(payload: any): string {
  const sender = payload?.sender?.id ? { id: payload.sender.id } : undefined;
  const actor = payload?.actor?.id ? { id: payload.actor.id } : undefined;
  return stableDigest({
    platform: payload?.platform,
    messageId: payload?.messageId,
    channelId: payload?.channelId,
    updateKind: payload?.updateKind,
    sender,
    actor,
  });
}
