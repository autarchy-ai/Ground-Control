// One validator for every host-configured subprocess deadline (issues #1518, #1720).
//
// A deadline read from the environment is host configuration, not repository
// policy. A zero, negative, malformed, or excessive value falls back to the
// finite default rather than disabling or effectively removing the cap, so no
// configuration can make a bounded call unbounded.
export function parseBoundedTimeoutMs(raw, { min, max, default: fallback }) {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}
