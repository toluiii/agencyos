import { createHash, randomBytes, timingSafeEqual } from 'crypto';
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('hex');
export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a); const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
export function slugify(input: string) {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'org';
}
/**
 * Development conveniences (reset links in API responses, relaxed origin checks) require NODE_ENV
 * to be *explicitly* development or test. The config schema defaults NODE_ENV to development, so a
 * production deployment that forgot to set it would otherwise silently enable them.
 */
export const isExplicitDevelopmentEnv = () => process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
