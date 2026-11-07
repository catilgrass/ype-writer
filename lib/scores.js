// Scoring math, kept intentionally small: every published number must be
// recomputable from the rule file and the per-session scores.

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

export function round1(value) {
  return Math.round(value * 10) / 10;
}

// Models answer with numbers, numeric strings, or junk; anything non-finite is
// treated as "no score" instead of silently becoming 0.
export function toScore(value, low = 1, high = 5) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return null;
  return Math.round(clamp(number, low, high));
}

// 5 means only the audience follows it, 3 means both groups do, 1 means only
// the anti-audience does; the target picks the point on that line.
export function panderingIndex(audienceFit, antiComprehension) {
  const total = audienceFit + antiComprehension;
  if (!Number.isFinite(total) || total <= 0) return null;
  return clamp(1 + (4 * audienceFit) / total, 1, 5);
}

// Two points off the target already erases the whole contribution, which keeps
// the closeness term from masking very off-target writing.
export function closeness(measured, target) {
  if (measured === null || measured === undefined || !Number.isFinite(measured)) return null;
  return clamp(5 - 2 * Math.abs(measured - target), 0, 5);
}

// A violation of 0 is perfect rather than one step above perfect.
export function qualityFromViolation(violation) {
  if (violation === 0) return 5;
  return clamp(6 - violation, 1, 5);
}

// Missing values drop out instead of being treated as zero, so a skipped
// paragraph does not drag a rule down.
export function weightedMean(parts) {
  let total = 0;
  let weight = 0;
  for (const part of parts) {
    if (part.value === null || part.value === undefined || !Number.isFinite(part.value)) continue;
    total += part.value * part.weight;
    weight += part.weight;
  }
  return weight === 0 ? null : total / weight;
}

export function mean(values) {
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    total += value;
    count += 1;
  }
  return count === 0 ? null : total / count;
}
