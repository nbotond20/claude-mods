import type { EventTone } from '@loam/ui-web';

/**
 * Loam's scheduler knows eight tones; the timesheet has ~20 categories. Categories without an
 * explicit tone get their own hue instead: calendar events carry it in their id (`…:h123`) and
 * the stylesheet below colours those chips. Everything else (dots, legends) uses `hueColor`.
 */

export const hueMark = (hue: number) => `:h${hue}`;

/** Solid colour for dots and stripes; readable on the surface in light and dark. */
export const hueColor = (hue: number) => `oklch(0.66 0.15 ${hue})`;

/** Approximate hues of Loam's tones, to pick the closest one where only a tone fits. */
const TONE_HUES: [EventTone, number][] = [
  ['danger', 20],
  ['accent', 40],
  ['warn', 80],
  ['good', 150],
  ['working', 185],
  ['info', 250],
  ['conflict', 300],
];

export function nearestTone(hue: number): EventTone {
  const dist = (a: number) => Math.min(Math.abs(a - hue), 360 - Math.abs(a - hue));
  return TONE_HUES.reduce((best, t) => (dist(t[1]) < dist(best[1]) ? t : best))[0];
}

/** A stable hue for any string (a repo path), spread around the wheel. */
export function hueOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

/** Chip colours per hue: soft fill, ink and edge, with dark-mode values. */
export function schedulerCss(hueList: number[]): string {
  const hues = [...new Set(hueList)];
  const chip = (h: number) => `[data-loam-scheduler] [data-occurrence-key*="${hueMark(h)}::"]`;
  return [
    // Parallel work overlaps on purpose; it is not a double booking.
    `[data-loam-scheduler] [data-conflict] svg { display: none; }`,
    // Personal and unassigned activity: muted, dashed and hatched, so it reads as "not booked".
    `[data-loam-scheduler] [data-occurrence-key^="other:"] {
      border-style: dashed;
      background-color: oklch(0.955 0.004 80);
      color: oklch(0.45 0.01 80);
      border-color: oklch(0.78 0.01 80);
      background-image: repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in oklch, currentColor 8%, transparent) 6px 7px);
    }`,
    `[data-loam-scheduler] [data-occurrence-key^="other:"] span[aria-hidden] { background-color: oklch(0.7 0.01 80); }`,
    `:root[data-mode="dark"] [data-loam-scheduler] [data-occurrence-key^="other:"] {
      background-color: oklch(0.27 0.005 80);
      color: oklch(0.78 0.01 80);
      border-color: oklch(0.45 0.01 80);
    }`,
    ...hues.map((h) => `${chip(h)} { --cat-h: ${h}; }`),
    `[data-loam-scheduler] [data-occurrence-key*=":h"] {
      background-color: oklch(0.94 0.045 var(--cat-h));
      color: oklch(0.36 0.1 var(--cat-h));
      border-color: oklch(0.8 0.08 var(--cat-h));
    }`,
    `[data-loam-scheduler] [data-occurrence-key*=":h"] span[aria-hidden] { background-color: oklch(0.62 0.15 var(--cat-h)); }`,
    `:root[data-mode="dark"] [data-loam-scheduler] [data-occurrence-key*=":h"] {
      background-color: oklch(0.34 0.06 var(--cat-h));
      color: oklch(0.92 0.05 var(--cat-h));
      border-color: oklch(0.48 0.09 var(--cat-h));
    }`,
    `:root[data-mode="dark"] [data-loam-scheduler] [data-occurrence-key*=":h"] span[aria-hidden] { background-color: oklch(0.72 0.14 var(--cat-h)); }`,
  ].join('\n');
}
