/**
 * A distinct hue (0–360) per category for the calendar, spread by the golden angle so
 * neighbours in the list never look alike. Categories with an explicit tone keep it (null).
 * No Node imports: the web UI uses this too.
 */
export function categoryHues(categories: { name: string; tone?: string }[]): Map<string, number | null> {
  return new Map(categories.map((c, i) => [c.name, c.tone ? null : Math.round((25 + i * 137.508) % 360)]));
}
