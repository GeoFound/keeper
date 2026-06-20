import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

export function isoNow(): string {
  return new Date().toISOString();
}
