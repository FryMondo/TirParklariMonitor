import { parseResponse } from './model.js';
export class HttpError extends Error { constructor(message: string, public status = 0, public retryAfterMs = 0, public temporary = false, public certificateError = false) { super(message); } }
const certificateCodes = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','CERT_UNTRUSTED','CERT_REVOKED','ERR_TLS_CERT_ALTNAME_INVALID']);
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Math.min(Number.MAX_SAFE_INTEGER, Number(value)*1000);
  const date = Date.parse(value); return Number.isNaN(date) ? 0 : Math.max(0,date-now);
}
export async function fetchDate(date: string, timeoutMs: number, signal: AbortSignal, client: typeof fetch = fetch) {
  let response: Response;
  try { response = await client(`https://tirparklari.com.tr/api/v1/randevu/musaitlik/hamzabeyli?gun=${date}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), headers: { accept:'application/json' } }); }
  catch (e) {
    if (signal.aborted) throw e;
    const cause = e instanceof Error ? e.cause : undefined;
    const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : undefined;
    const timeout = e instanceof Error && e.name === 'TimeoutError';
    const detail = timeout ? 'таймаут запиту' : code ? `код ${code}` : 'подробиці відсутні';
    const certificateError = code !== undefined && certificateCodes.has(code);
    throw new HttpError(`Мережева помилка (${detail})`,0,0,!certificateError,certificateError);
  }
  if (!response.ok) throw new HttpError(`HTTP ${response.status}`,response.status,retryAfter(response.headers.get('retry-after')), response.status >= 500);
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) throw new HttpError('Відповідь не є JSON; можливий захист сайту',403);
  let raw: unknown;
  try { raw = await response.json(); } catch { throw new HttpError('Некоректний JSON'); }
  return parseResponse(raw, date);
}
