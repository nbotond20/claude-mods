import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Select, Skeleton, useToast } from '@loam/ui-web';
import { api, SYSTEM_LABEL, type BookedPair, type DiscoverResponse, type NetsuiteCatalog, type NetsuiteTarget, type RedmineCatalog, type RedmineTarget, type SubmitCatalogResponse, type SubmitRule, type SystemId } from '../api';
import type { SectionProps } from './sections';

const NONE = '__none__';
const ANY = '*';

type Status = 'mapped' | 'wildcard' | 'unmapped' | 'broken' | 'optional' | 'incomplete';

interface RowSpec {
  key: string;
  project: string;
  category: string;
  booked: BookedPair | null;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** "#9888 Secondary Learning Platform Development (IL.NLP)" */
export const issueLabel = (i: { id: number; title: string; project: string }) => `#${i.id} ${i.title} (${i.project})`;

/**
 * Maps every (project, category) pair (configured projects × current categories, plus categories
 * of existing rules, plus one "any other category" row per project) to a row on
 * the site, chosen from what discovery read there. Edits go into the Settings draft.
 */
export function MappingEditor({ system, config, update, enabled }: SectionProps & { system: SystemId; enabled: boolean }) {
  const { toast } = useToast();
  const [catalog, setCatalog] = useState<SubmitCatalogResponse | null>(null);
  const [pairs, setPairs] = useState<BookedPair[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** First half of a target chosen (issue / project) before the second half (activity / task) */
  const [pending, setPending] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    api<SubmitCatalogResponse>(`/api/submit/catalog?system=${system}`).then((c) => live && setCatalog(c), (e) => live && setLoadError((e as Error).message));
    api<{ pairs: BookedPair[] }>('/api/submit/pairs').then((r) => live && setPairs(r.pairs), (e) => live && setLoadError((e as Error).message));
    return () => {
      live = false;
    };
  }, [system]);

  const draft = config.submit[system];
  const rules = (Array.isArray(draft.rules) ? draft.rules : []) as SubmitRule<RedmineTarget | NetsuiteTarget>[];
  const setRules = (next: SubmitRule<RedmineTarget | NetsuiteTarget>[]) => update({ submit: { ...config.submit, [system]: { ...draft, rules: next } } as typeof config.submit });
  const setRule = (project: string, category: string, target: RedmineTarget | NetsuiteTarget | null) => {
    const rest = rules.filter((r) => !(r.project === project && r.category === category));
    setRules(target ? [...rest, { project, category, target }] : rest);
  };

  const rows = useMemo(() => {
    const categories = new Set(config.categories.map((c) => c.name));
    const byProject = new Map<string, Map<string, BookedPair | null>>();
    const add = (project: string, category: string, pair: BookedPair | null) => {
      if (!config.projects.includes(project) || (category !== ANY && !categories.has(category))) return;
      const m = byProject.get(project) ?? new Map<string, BookedPair | null>();
      if (!m.has(category) || pair) m.set(category, pair ?? m.get(category) ?? null);
      byProject.set(project, m);
    };
    for (const p of pairs ?? []) add(p.project, p.category, p);
    for (const r of rules) add(r.project, r.category, null);
    // Every current category of every project, not only the ones booked lately: a category booked
    // for the first time must not block a week for want of a mapping nobody could set.
    const today = new Date().toISOString().slice(0, 10);
    for (const project of config.projects) for (const c of config.categories) if (!c.validTo || c.validTo >= today) add(project, c.name, null);
    const out: RowSpec[] = [];
    for (const project of config.projects) {
      const m = byProject.get(project);
      if (!m) continue;
      for (const [category, booked] of [...m].filter(([c]) => c !== ANY).sort(([a], [b]) => a.localeCompare(b))) out.push({ key: `${project}\u0000${category}`, project, category, booked });
      out.push({ key: `${project}\u0000${ANY}`, project, category: ANY, booked: null });
    }
    return out;
  }, [pairs, rules, config.projects, config.categories]);

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api<DiscoverResponse>('/api/submit/discover', { body: { system } });
      if (r.state === 'login') toast({ title: `Log in to ${SYSTEM_LABEL[system]} first`, description: r.reason, severity: 'error' });
      else {
        setCatalog({ system, catalog: r.catalog, discoveredAt: r.discoveredAt });
        toast({ title: `Read ${SYSTEM_LABEL[system]}`, severity: 'success' });
      }
    } catch (e) {
      toast({ title: 'Refresh from site', description: (e as Error).message, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const data = catalog?.catalog ?? null;
  const unmapped = rows.filter((r) => r.category !== ANY && !rules.some((x) => x.project === r.project && (x.category === r.category || x.category === ANY))).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <span className="text-13 font-medium text-ink">Mapping</span>
          <p className="text-12 text-ink-3">
            {!enabled
              ? 'Available after the NetSuite adapter is enabled.'
              : catalog?.discoveredAt
                ? `Read from ${SYSTEM_LABEL[system]} ${when(catalog.discoveredAt)}. Unmapped hours block the week.`
                : `Log in above, then read your ${system === 'redmine' ? 'Worktime issues and activities' : 'projects and tasks'} from the site.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {enabled && unmapped > 0 && data !== null && <Badge variant="warn">{unmapped} unmapped</Badge>}
          <Button variant="outline" size="sm" leadingIcon="refresh" disabled={!enabled || !draft.url.trim()} loading={busy} onClick={refresh}>
            Refresh from site
          </Button>
        </div>
      </div>
      {loadError && <p className="text-12 text-danger">Could not load the mapping data: {loadError}</p>}
      {!enabled || (catalog && !data) ? (
        rules.length > 0 && <p className="text-12 text-ink-3">{rules.length} rule{rules.length === 1 ? '' : 's'} in the settings (editable in Advanced → raw JSON).</p>
      ) : !catalog || !pairs ? (
        <Skeleton width="60%" height={14} />
      ) : rows.length === 0 ? (
        <p className="text-12 text-ink-3">Add a project in Settings → Projects first.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-12">
            <thead>
              <tr className="border-b border-line text-left text-ink-3">
                <th className="px-3 py-1.5 font-medium">Project · category</th>
                <th className="px-3 py-1.5 text-right font-medium">8 weeks</th>
                <th className="px-3 py-1.5 font-medium">{system === 'redmine' ? 'Issue · activity' : 'Project · task'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => {
                const rule = rules.find((r) => r.project === row.project && r.category === row.category);
                const star = row.category !== ANY && rules.some((r) => r.project === row.project && r.category === ANY);
                const props = { row, rule, star, pending: pending[row.key], setPending: (v: string | null) => setPending((p) => { const n = { ...p }; if (v === null) delete n[row.key]; else n[row.key] = v; return n; }), setRule: (t: RedmineTarget | NetsuiteTarget | null) => setRule(row.project, row.category, t) };
                return system === 'redmine' ? <RedmineRow key={row.key} {...props} catalog={data as RedmineCatalog} /> : <NetsuiteRow key={row.key} {...props} catalog={data as NetsuiteCatalog} />;
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface RowProps {
  row: RowSpec;
  rule: SubmitRule<RedmineTarget | NetsuiteTarget> | undefined;
  star: boolean;
  pending: string | undefined;
  setPending: (v: string | null) => void;
  setRule: (t: RedmineTarget | NetsuiteTarget | null) => void;
}

function statusOf(row: RowSpec, mapped: boolean, broken: boolean, star: boolean, pending: boolean): Status {
  if (broken) return 'broken';
  if (mapped) return 'mapped';
  if (pending) return 'incomplete';
  if (row.category === ANY) return 'optional';
  return star ? 'wildcard' : 'unmapped';
}

function Shell({ row, status, children }: { row: RowSpec; status: Status; children: ReactNode }) {
  const tint = status === 'unmapped' || status === 'incomplete' ? 'bg-warn/10' : status === 'broken' ? 'bg-danger/10' : '';
  return (
    <tr className={tint}>
      <td className="px-3 py-1.5 align-middle">
        <span className="text-ink">{row.project}</span>
        <span className="text-ink-3"> · </span>
        <span className={row.category === ANY ? 'italic text-ink-2' : 'text-ink'}>{row.category === ANY ? 'any other category' : row.category}</span>
        {status === 'unmapped' && <Badge size="sm" variant="warn" className="ml-2">unmapped</Badge>}
        {status === 'incomplete' && <Badge size="sm" variant="warn" className="ml-2">incomplete</Badge>}
        {status === 'broken' && <Badge size="sm" variant="danger" className="ml-2">no longer on the site</Badge>}
        {status === 'wildcard' && <span className="ml-2 text-ink-3">via any other category</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-ink-3">{row.booked ? `${row.booked.hours} h` : '—'}</td>
      <td className="px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </td>
    </tr>
  );
}

function RedmineRow({ row, rule, star, pending, setPending, setRule, catalog }: RowProps & { catalog: RedmineCatalog }) {
  const target = rule?.target as RedmineTarget | undefined;
  const issueId = pending ?? (target ? String(target.issueId) : NONE);
  const issue = catalog.issues.find((i) => String(i.id) === issueId);
  const broken = !!target && !catalog.issues.some((i) => i.id === target.issueId && i.activities.includes(target.activity));
  const items = [{ value: NONE, label: 'Not mapped' }, ...catalog.issues.map((i) => ({ value: String(i.id), label: issueLabel(i) }))];
  if (target && !catalog.issues.some((i) => i.id === target.issueId)) items.push({ value: String(target.issueId), label: `#${target.issueId} (no longer listed)` });
  const activities = issue?.activities ?? (target ? [target.activity] : []);
  return (
    <Shell row={row} status={statusOf(row, !!rule, broken, star, pending !== undefined)}>
      <Select
        size="xs"
        className="w-72"
        aria-label={`${row.project} ${row.category} issue`}
        value={issueId}
        items={items}
        onValueChange={(v) => {
          if (v === NONE) {
            setPending(null);
            setRule(null);
            return;
          }
          const next = catalog.issues.find((i) => String(i.id) === v);
          if (target && next?.activities.includes(target.activity)) {
            setPending(null);
            setRule({ issueId: next.id, activity: target.activity });
          } else {
            setRule(null);
            setPending(v);
          }
        }}
      />
      <Select
        size="xs"
        className="w-48"
        aria-label={`${row.project} ${row.category} activity`}
        placeholder="Activity…"
        disabled={issueId === NONE || activities.length === 0}
        value={pending === undefined && target ? target.activity : ''}
        items={activities.map((a) => ({ value: a, label: a }))}
        onValueChange={(v) => {
          const id = Number(issueId);
          if (!Number.isInteger(id) || id <= 0) return;
          setPending(null);
          setRule({ issueId: id, activity: v });
        }}
      />
    </Shell>
  );
}

function NetsuiteRow({ row, rule, star, pending, setPending, setRule, catalog }: RowProps & { catalog: NetsuiteCatalog }) {
  const target = rule?.target as NetsuiteTarget | undefined;
  const project = pending ?? target?.project ?? NONE;
  const entry = catalog.projects.find((p) => p.name === project);
  const broken = !!target && !catalog.projects.some((p) => p.name === target.project && p.tasks.includes(target.task));
  const items = [{ value: NONE, label: 'Not mapped' }, ...catalog.projects.map((p) => ({ value: p.name, label: p.name }))];
  if (target && !catalog.projects.some((p) => p.name === target.project)) items.push({ value: target.project, label: `${target.project} (no longer listed)` });
  const tasks = entry?.tasks ?? (target ? [target.task] : []);
  return (
    <Shell row={row} status={statusOf(row, !!rule, broken, star, pending !== undefined)}>
      <Select
        size="xs"
        className="w-72"
        aria-label={`${row.project} ${row.category} NetSuite project`}
        value={project}
        items={items}
        onValueChange={(v) => {
          if (v === NONE) {
            setPending(null);
            setRule(null);
            return;
          }
          const next = catalog.projects.find((p) => p.name === v);
          if (target && next?.tasks.includes(target.task)) {
            setPending(null);
            setRule({ project: v, task: target.task });
          } else {
            setRule(null);
            setPending(v);
          }
        }}
      />
      <Select
        size="xs"
        className="w-48"
        aria-label={`${row.project} ${row.category} task`}
        placeholder="Task…"
        disabled={project === NONE || tasks.length === 0}
        value={pending === undefined && target ? target.task : ''}
        items={tasks.map((t) => ({ value: t, label: t }))}
        onValueChange={(v) => {
          if (project === NONE) return;
          setPending(null);
          setRule({ project, task: v });
        }}
      />
    </Shell>
  );
}
