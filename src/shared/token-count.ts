/**
 * Token-count text entry shared by the Provider editor and server validation.
 * Accepts plain integers plus `k`/`m` suffixes ("500k", "500K", "1m", "1M",
 * "1.5m"). Suffixes multiply; the result must be a positive safe integer.
 */
export type ParsedTokenCount =
  | { ok: true; value: number | undefined }
  | { ok: false };

const TOKEN_COUNT = /^(\d+)(\.\d+)?\s*([km])?$/i;

export function parseTokenCount(raw: string): ParsedTokenCount {
  const text = raw.trim();
  if (!text) return { ok: true, value: undefined };
  const match = TOKEN_COUNT.exec(text);
  if (!match) return { ok: false };
  const [, digits, fraction, suffixRaw] = match;
  // A fractional count is only meaningful with a unit (1.5m); "1.5" tokens is
  // not a number this field should silently round.
  if (fraction && !suffixRaw) return { ok: false };
  const suffix = suffixRaw?.toLowerCase();
  const scale = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
  // Round before validating: binary floating point makes 4.1m
  // 4100000.000000001, which must not be rejected as non-integer text.
  const value = Math.round(Number(`${digits}${fraction ?? ""}`) * scale);
  if (!Number.isSafeInteger(value) || value <= 0) return { ok: false };
  return { ok: true, value };
}
