const encoder = new TextEncoder();
const DAY_MS = 24 * 60 * 60 * 1000;

export async function secretsMatch(provided, expected) {
  if (!expected || typeof provided !== 'string' || provided.length > 1024) return false;
  const [left, right] = await Promise.all([provided, expected].map(value =>
    crypto.subtle.digest('SHA-256', encoder.encode(value))));
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(left, right);
  // Node's Web Crypto does not expose Cloudflare's timingSafeEqual.
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function sessionKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || !env.DASHBOARD_PASSWORD) return null;
  return crypto.subtle.importKey('raw', encoder.encode(`${env.SESSION_SECRET}\n${env.DASHBOARD_PASSWORD}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSession(env) {
  const key = await sessionKey(env);
  if (!key) return null;
  const payload = `${Date.now() + DAY_MS}.${crypto.randomUUID()}`;
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const hex = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${payload}.${hex}`;
}

export async function validSession(token, env) {
  const parts = token.match(/^(\d{13}\.[a-f0-9-]{36})\.([a-f0-9]{64})$/);
  if (!parts || Number(parts[1].split('.')[0]) <= Date.now()) return false;
  const key = await sessionKey(env);
  if (!key) return false;
  const signature = Uint8Array.from(parts[2].match(/../g), byte => parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(parts[1]));
}
