import { CLASSIFIER_CWD, expandHome } from './config.ts';
import type { Config } from './config.ts';

/** `system`: temp dirs and the classifier's own sessions, which are not even personal activity. */
export type Resolution = { kind: 'work'; project: string } | { kind: 'personal'; system?: true } | { kind: 'unknown' };

interface CompiledRule {
  regex: RegExp;
  specificity: number;
  resolution: Resolution;
}

/** Glob → regex. `dir/**` matches dir itself and everything below it; `*` matches one path segment. */
export function globToRegex(glob: string): RegExp {
  let p = expandHome(glob).replace(/\/+$/, '');
  const recursive = p.endsWith('/**');
  if (recursive) p = p.slice(0, -3);
  const body = p
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}${recursive ? '(/.*)?' : ''}$`);
}

function specificity(glob: string): number {
  return expandHome(glob).replace(/\*.*$/, '').length;
}

export class Scope {
  private rules: CompiledRule[];

  constructor(config: Config) {
    const rules: CompiledRule[] = [
      ...config.scope.work.map((r) => ({
        regex: globToRegex(r.path),
        specificity: specificity(r.path),
        resolution: { kind: 'work', project: r.project ?? config.defaultProject } as Resolution,
      })),
      ...config.scope.personal.map((p) => ({
        regex: globToRegex(p),
        specificity: specificity(p),
        resolution: { kind: 'personal' } as Resolution,
      })),
      // The classifier's own sessions and temp/scratch dirs never count.
      ...[CLASSIFIER_CWD + '/**', expandHome('~/.timesheet/classifier/**'), '/private/tmp/**', '/tmp/**', '/private/var/folders/**'].map((g) => ({
        regex: globToRegex(g),
        specificity: Infinity,
        resolution: { kind: 'personal', system: true } as Resolution,
      })),
    ];
    // Most specific rule wins; on equal specificity personal beats work.
    this.rules = rules.sort(
      (a, b) => b.specificity - a.specificity || (a.resolution.kind === 'personal' ? -1 : 1) - (b.resolution.kind === 'personal' ? -1 : 1),
    );
  }

  resolve(path: string | undefined): Resolution {
    if (!path) return { kind: 'unknown' };
    const clean = path.replace(/\/+$/, '');
    for (const r of this.rules) if (r.regex.test(clean)) return r.resolution;
    return { kind: 'unknown' };
  }
}

export function resolutionKey(r: Resolution): string {
  return r.kind === 'work' ? `work:${r.project}` : r.kind;
}
