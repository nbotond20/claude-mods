import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icon,
  Input,
  Select,
  Skeleton,
  Spinner,
  Switch,
  Textarea,
  useToast,
  type IconName,
} from '@loam/ui-web';
import { api, type AuthStatus, type Config, type GithubStatus } from '../api';
import { hueColor } from '../colors';
import { categoryHues } from '../../../src/core/palette.ts';
import { GITHUB_PERMISSIONS, GITHUB_TOKEN_DAYS, githubTokenUrl, type PermissionGroup } from '../../../src/core/github-token.ts';
import type { Category, CategoryRole } from '../../../src/core/config.ts';
import { mergeCategories, parseCategoryList } from '../../../src/core/category-list.ts';
import { Block, CONTROL_W, Group, ListRow, NumberRow, Row, Status, SwitchRow, UnitInput } from './fields';

export interface SectionProps {
  config: Config;
  update: (patch: Partial<Config>) => void;
}

export interface Detected {
  claudeDirs: { dir: string; sessions: number; prompts: number; included: boolean }[];
  opencode: boolean;
  gitEmail: string;
  claudeCommands: string[];
}

let detectRequest: Promise<Detected> | null = null;

/** What exists on this machine (profiles, OpenCode, Claude commands). Slow to scan, so loaded once and lazily. */
export function useDetected(): { detected: Detected | null; error: string | null } {
  const [detected, setDetected] = useState<Detected | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    detectRequest ??= api<Detected>('/api/detect');
    let live = true;
    detectRequest.then(
      (d) => live && setDetected(d),
      (e) => {
        detectRequest = null;
        if (live) setError((e as Error).message);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return { detected, error };
}

const TONES = ['accent', 'info', 'good', 'warn', 'danger', 'conflict', 'working', 'waiting'];
const TONE_BG: Record<string, string> = {
  accent: 'bg-accent',
  info: 'bg-info',
  good: 'bg-good',
  warn: 'bg-warn',
  danger: 'bg-danger',
  conflict: 'bg-st-conflict',
  working: 'bg-st-working',
  waiting: 'bg-st-waiting',
};
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY', 'YYYY.MM.DD'];
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');

// ---------- projects ----------

export function ProjectsSection({ config, update }: SectionProps) {
  const renameProject = (from: string, to: string) =>
    update({
      projects: config.projects.map((p) => (p === from ? to : p)),
      defaultProject: config.defaultProject === from ? to : config.defaultProject,
      scope: { ...config.scope, work: config.scope.work.map((r) => (r.project === from ? { ...r, project: to } : r)) },
      calendar: { ...config.calendar, project: config.calendar.project === from ? to : config.calendar.project },
    });
  const remove = (p: string) =>
    update({ projects: config.projects.filter((x) => x !== p), defaultProject: config.defaultProject === p ? config.projects.find((x) => x !== p)! : config.defaultProject });
  return (
    <Group
      title="NetSuite projects"
      count={config.projects.length}
      description="The projects you book time on. Work paths and meetings map to one of these; the default is used when nothing else says otherwise."
      actions={<Button size="sm" variant="outline" leadingIcon="plus" onClick={() => update({ projects: [...config.projects, `Project ${config.projects.length + 1}`] })}>Add project</Button>}
    >
      {config.projects.map((p, i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-3">
          <Input size="sm" defaultValue={p} key={p} onBlur={(e) => e.target.value.trim() && e.target.value !== p && renameProject(p, e.target.value.trim())} aria-label="Project name" className="max-w-[24rem]" />
          {config.defaultProject === p ? (
            <Status tone="good">Default</Status>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => update({ defaultProject: p })}>Make default</Button>
          )}
          <span className="ml-auto">
            {config.projects.length > 1 && <Button size="sm" variant="ghost" iconOnly leadingIcon="trash" aria-label={`Remove ${p}`} onClick={() => remove(p)} />}
          </span>
        </div>
      ))}
    </Group>
  );
}

// ---------- hours ----------

export function HoursSection({ config, update }: SectionProps) {
  const setWeekday = (i: number, mode: string, value?: number) => {
    const next = { ...config.weekdayTargets };
    if (mode === 'default') delete next[String(i)];
    else next[String(i)] = mode === 'real' ? null : (value ?? config.target);
    update({ weekdayTargets: next });
  };
  return (
    <>
      <Group title="Daily hours" description="Booked hours are real activity scaled to the daily target, rounded, with the remainder spread so each day adds up exactly. Days without activity stay at 0.">
        <NumberRow label="Daily target" hint="Hours booked on a normal working day." value={config.target} step={0.25} unit="h" onChange={(target) => update({ target })} />
      </Group>
      <Group title="Per weekday" description="Weekends default to real hours, so nothing is scaled up.">
        {WEEKDAYS.map((name, idx) => {
          const i = (idx + 1) % 7; // Monday first; stored as JS day numbers (0 = Sunday)
          const key = String(i);
          const mode = !(key in config.weekdayTargets) ? 'default' : config.weekdayTargets[key] === null ? 'real' : 'custom';
          return (
            <Row key={name} label={name}>
              {mode === 'custom' && <UnitInput className="w-24" unit="h" step={0.25} min={0} value={config.weekdayTargets[key] ?? 0} onChange={(v) => setWeekday(i, 'custom', Number(v))} aria-label={`${name} target`} />}
              <Select
                size="sm"
                className={CONTROL_W}
                aria-label={`${name} hours`}
                value={mode}
                onValueChange={(v) => setWeekday(i, v)}
                items={[{ value: 'default', label: `Daily target · ${config.target} h` }, { value: 'real', label: 'Real hours' }, { value: 'custom', label: 'Custom target' }]}
              />
            </Row>
          );
        })}
      </Group>
    </>
  );
}

export function ExportSection({ config, update }: SectionProps) {
  return (
    <Group title="Export format" description="How numbers and dates look in the text you paste into NetSuite.">
      <Row label="Rounding" hint="Booked hours are rounded to this step.">
        <Select size="sm" className={CONTROL_W} aria-label="Rounding" value={String(config.rounding)} onValueChange={(v) => update({ rounding: Number(v) })} items={['0.1', '0.25', '0.5', '1'].map((v) => ({ value: v, label: `${v} h` }))} />
      </Row>
      <Row label="Decimal separator" hint="Match what NetSuite expects in your locale.">
        <Select size="sm" className={CONTROL_W} aria-label="Decimal separator" items={[{ value: '.', label: 'Point (7.5)' }, { value: ',', label: 'Comma (7,5)' }]} value={config.decimalSeparator} onValueChange={(v) => update({ decimalSeparator: v as '.' | ',' })} />
      </Row>
      <Row label="Date format" hint="Used by the one-line-per-entry format.">
        <Select
          size="sm"
          className={CONTROL_W}
          aria-label="Date format"
          value={DATE_FORMATS.includes(config.dateFormat) ? config.dateFormat : 'custom'}
          onValueChange={(v) => v !== 'custom' && update({ dateFormat: v })}
          items={[...DATE_FORMATS.map((f) => ({ value: f, label: f })), ...(DATE_FORMATS.includes(config.dateFormat) ? [] : [{ value: 'custom', label: config.dateFormat }])]}
        />
      </Row>
    </Group>
  );
}

// ---------- sources ----------

export function SourcesSection({ config, update, detected }: SectionProps & { detected: Detected | null }) {
  return (
    <>
      <Group title="AI coding sessions" count={detected ? `${detected.claudeDirs.length} profile${detected.claudeDirs.length === 1 ? '' : 's'} · ${detected.claudeDirs.reduce((n, d) => n + d.sessions, 0).toLocaleString()} sessions · ${detected.claudeDirs.reduce((n, d) => n + d.prompts, 0).toLocaleString()} prompts` : undefined} description="Every message in a session counts as activity, including time spent waiting for the assistant.">
        <Block>
          <div className="mb-2 grid grid-cols-[1fr_5rem_6rem_7rem] gap-3 text-12 font-medium text-ink-3">
            <span>Claude Code profile</span>
            <span className="text-right">Sessions</span>
            <span className="text-right">Prompts</span>
            <span className="text-right">Status</span>
          </div>
          {!detected ? (
            <div className="flex flex-col gap-2 py-1">
              <Skeleton height={14} />
              <Skeleton height={14} width="80%" />
            </div>
          ) : detected.claudeDirs.length === 0 ? (
            <p className="py-2 text-13 text-ink-3">No Claude Code profile found on this machine.</p>
          ) : (
            detected.claudeDirs.map((d) => (
              <div key={d.dir} className="grid min-h-9 grid-cols-[1fr_5rem_6rem_7rem] items-center gap-3 border-t border-line text-13">
                <span className="truncate font-mono text-12">{tilde(d.dir).replace(/\/projects$/, '')}</span>
                <span className="text-right tabular-nums text-ink-2">{d.sessions.toLocaleString()}</span>
                <span className="text-right tabular-nums text-ink-2">{d.prompts.toLocaleString()}</span>
                <span className="text-right">{d.included ? <Status tone="good">Included</Status> : <Status tone="warn">Not included</Status>}</span>
              </div>
            ))
          )}
          <div className="grid min-h-9 grid-cols-[1fr_7rem] items-center gap-3 border-t border-line text-13">
            <span>OpenCode</span>
            <span className="text-right">{!detected ? <Skeleton height={12} width={60} className="ml-auto" /> : detected.opencode ? <Status tone="good">Found</Status> : <Status tone="neutral">Not installed</Status>}</span>
          </div>
        </Block>
        <ListRow label="Claude Code project folders" hint={<>Globs allowed. <code>~/.claude*/projects</code> covers every profile. No folders turns Claude Code off.</>} value={config.claudeDirs} onChange={(claudeDirs) => update({ claudeDirs })} placeholder="~/.claude*/projects" addLabel="Add folder" />
        <SwitchRow
          label="Use prompt history for older days"
          hint="Claude Code deletes old transcripts but keeps every prompt in history.jsonl. Those sessions count from their prompts; reply time is estimated."
          checked={config.claudeHistory}
          onChange={(claudeHistory) => update({ claudeHistory })}
        />
        <NumberRow label="Time credited per history-only prompt" hint="Reply time for sessions known only from history." value={config.historyTailMinutes} unit="min" disabled={!config.claudeHistory} onChange={(historyTailMinutes) => update({ historyTailMinutes })} />
        <ListRow label="OpenCode data folders" hint="Contains opencode.db or storage/. No folders turns OpenCode off." value={config.opencodeDirs.map(tilde)} onChange={(opencodeDirs) => update({ opencodeDirs })} placeholder="~/.local/share/opencode" addLabel="Add folder" />
      </Group>

      <Group title="Git" description="Commits in work repos count as activity, with lead-in time before each commit.">
        <ListRow
          label="Author emails"
          hint={`Commits by these authors count. With none, each repo's user.email is used${detected?.gitEmail ? ` (global: ${detected.gitEmail})` : ''}.`}
          value={config.authorEmails}
          onChange={(authorEmails) => update({ authorEmails })}
          placeholder="you@company.com"
          addLabel="Add email"
          mono={false}
        />
      </Group>
    </>
  );
}

export function TrackingSection({ config, update }: SectionProps) {
  return (
    <Group title="Time blocks" description="How individual activity moments become blocks of working time.">
      <NumberRow label="Gap that ends a block" hint="A longer pause starts a new block." value={config.gapMinutes} unit="min" onChange={(gapMinutes) => update({ gapMinutes })} />
      <NumberRow label="Idle after" hint="Assistant work this long after your last prompt ran unattended and is not counted; quiet stretches longer than this are not real time." value={config.idleMinutes} unit="min" onChange={(idleMinutes) => update({ idleMinutes })} />
      <NumberRow label="Lead-in per prompt" hint="Reading and typing before a prompt was sent." value={config.promptLeadMinutes} unit="min" onChange={(promptLeadMinutes) => update({ promptLeadMinutes })} />
      <NumberRow label="Lead-in per commit" hint="Work credited before a commit." value={config.commitLeadMinutes} unit="min" onChange={(commitLeadMinutes) => update({ commitLeadMinutes })} />
      <NumberRow label="Minimum block" hint="Shorter blocks are padded to this length." value={config.minBlockMinutes} unit="min" onChange={(minBlockMinutes) => update({ minBlockMinutes })} />
    </Group>
  );
}

// ---------- scope ----------

export function ScopeSection({ config, update }: SectionProps) {
  const [unknown, setUnknown] = useState<{ path: string; sessions: number }[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  // Judged against the unsaved draft, so classifying a row removes it immediately.
  useEffect(() => {
    let live = true;
    api<{ paths: { path: string; sessions: number }[] }>('/api/paths', { body: { days: 60, config } }).then(
      (r) => {
        if (!live) return;
        setUnknown(r.paths);
        setScanError(null);
      },
      (e) => live && setScanError((e as Error).message),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.scope]);
  const work = config.scope.work;
  const setWork = (next: typeof work) => update({ scope: { ...config.scope, work: next } });
  // Decided rows leave the list right away; the rescan that follows confirms it.
  const drop = (p: string) => setUnknown((u) => u && u.filter((x) => x.path !== p && !x.path.startsWith(`${p}/`)));
  const addWork = (p: string, project = config.defaultProject) => {
    drop(p);
    setWork([...work, { path: `${tilde(p)}/**`, project }]);
  };
  const addPersonal = (p: string) => {
    drop(p);
    update({ scope: { ...config.scope, personal: [...config.scope.personal, `${tilde(p)}/**`] } });
  };
  // Repos grouped by their parent folder when there are several, so a whole folder can be decided at once.
  const byParent = new Map<string, { path: string; sessions: number }[]>();
  for (const u of unknown ?? []) {
    const parent = u.path.split('/').slice(0, -1).join('/');
    byParent.set(parent, [...(byParent.get(parent) ?? []), u]);
  }
  const spans = (items: { sessions: number }[]) => items.reduce((n, u) => n + u.sessions, 0);
  const sorted = [...byParent].sort((a, b) => spans(b[1]) - spans(a[1]));
  const decisions = [
    ...config.projects.map((p) => ({ value: `work:${p}`, label: config.projects.length > 1 ? `Work · ${p}` : 'Work' })),
    { value: 'personal', label: 'Personal' },
  ];
  const decide = (p: string, label: string, placeholder = 'Decide…') => (
    <Select
      size="sm"
      className="w-36 shrink-0"
      value=""
      placeholder={placeholder}
      aria-label={`Decide ${label}`}
      items={decisions}
      onValueChange={(v) => (v === 'personal' ? addPersonal(p) : addWork(p, v.slice(5)))}
    />
  );
  const leaf = (u: { path: string; sessions: number }, name: string, nested: boolean) => (
    <div key={u.path} className={`flex min-h-12 items-center gap-3 py-2 pr-5 ${nested ? 'pl-9' : 'pl-5'}`}>
      <span className="min-w-0 flex-1 truncate font-mono text-12" title={tilde(u.path)}>{name}</span>
      <span className="w-20 shrink-0 text-right text-12 tabular-nums text-ink-3">{u.sessions} span{u.sessions === 1 ? '' : 's'}</span>
      {decide(u.path, tilde(u.path))}
    </div>
  );

  return (
    <>
      <Group
        title="Work paths"
        count={work.length}
        description={<>Only activity inside these folders is booked. Globs: <code>dir/**</code> is the folder and everything in it. The most specific rule wins.</>}
        actions={<Button size="sm" variant="outline" leadingIcon="plus" onClick={() => setWork([...work, { path: '', project: config.defaultProject }])}>Add path</Button>}
      >
        {work.length === 0 && <Block className="text-13 text-ink-3">No work paths yet, so nothing is booked. Add one, or mark folders below.</Block>}
        {work.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 px-5 py-3">
            <Input
              size="sm"
              wrapperClassName="min-w-64 flex-1"
              className="font-mono text-12"
              placeholder="~/work/**"
              defaultValue={r.path}
              key={r.path}
              onBlur={(e) => setWork(work.map((x, j) => (j === i ? { ...x, path: e.target.value.trim() } : x)))}
              aria-label="Work path glob"
              error={!r.path}
            />
            {config.projects.length > 1 && (
              <Select size="sm" className="w-48" value={r.project ?? config.defaultProject} onValueChange={(project) => setWork(work.map((x, j) => (j === i ? { ...x, project } : x)))} items={config.projects.map((p) => ({ value: p, label: p }))} aria-label="Project" />
            )}
            <Button size="sm" variant="ghost" iconOnly leadingIcon="trash" aria-label="Remove path" onClick={() => setWork(work.filter((_, j) => j !== i))} />
          </div>
        ))}
      </Group>

      <Group title="Personal paths" count={config.scope.personal.length} description="Never counted, even inside a work path.">
        <ListRow label="Folders" hint={<>Globs, e.g. <code>~/private/**</code>.</>} value={config.scope.personal} onChange={(personal) => update({ scope: { ...config.scope, personal } })} placeholder="~/private/**" addLabel="Add path" />
      </Group>

      <Group
        title="Not yet decided"
        count={unknown ? `${unknown.length} folder${unknown.length === 1 ? '' : 's'} · ${unknown.reduce((n, u) => n + u.sessions, 0)} spans` : undefined}
        description="Folders with AI sessions in the last 60 days that no rule covers. Their time is not booked and the day is flagged until you decide.">
        {scanError ? (
          <Block>
            <Alert tone="danger" title="Could not scan sessions" description={scanError} />
          </Block>
        ) : unknown === null ? (
          <Block className="flex items-center gap-2 text-13 text-ink-3">
            <Spinner size="sm" /> Scanning sessions…
          </Block>
        ) : unknown.length === 0 ? (
          <Block className="text-13 text-ink-3">Every folder is covered by a rule.</Block>
        ) : (
          sorted.map(([parent, items]) =>
            items.length === 1 ? (
              leaf(items[0], tilde(items[0].path), false)
            ) : (
              <div key={parent} className="flex flex-col divide-y divide-line">
                <div className="flex min-h-12 items-center gap-3 bg-surface-2/60 px-5 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-12 font-semibold">{tilde(parent)}/</span>
                  <span className="w-20 shrink-0 text-right text-12 tabular-nums text-ink-3">{items.length} folders</span>
                  {decide(parent, `all of ${tilde(parent)}`, 'Decide all…')}
                </div>
                {items.map((u) => leaf(u, u.path.slice(parent.length + 1), true))}
              </div>
            ),
          )
        )}
      </Group>
    </>
  );
}

// ---------- github ----------

const PERMISSION_GROUPS: { id: PermissionGroup; title: string; icon: IconName }[] = [
  { id: 'delivery', title: 'Releases & deployments', icon: 'branch' },
  { id: 'collaboration', title: 'Issues & pull requests', icon: 'users' },
  { id: 'required', title: 'Always required', icon: 'shield' },
];

/** One numbered step, joined to the next by a line. */
function Step({ n, title, done = false, last = false, children }: { n: number; title: string; done?: boolean; last?: boolean; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_1fr] gap-x-4">
      <div className="flex flex-col items-center">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-full text-12 font-semibold tabular-nums ${done ? 'bg-good-soft text-good-on-soft' : 'bg-accent-soft text-accent-on-soft'}`}
          aria-hidden
        >
          {done ? <Icon name="check" size={14} /> : n}
        </span>
        {!last && <span className="my-1.5 w-px flex-1 bg-line" aria-hidden />}
      </div>
      <div className={`flex min-w-0 flex-col gap-3 pt-1 ${last ? '' : 'pb-7'}`}>
        <h4 className="text-14 font-medium text-ink">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h4>
        {children}
      </div>
    </li>
  );
}

function Panel({ tone, icon, title, children }: { tone: 'good' | 'warn'; icon: IconName; title: string; children: ReactNode }) {
  const color = tone === 'good' ? 'text-good-on-soft bg-good-soft' : 'text-warn-on-soft bg-warn-soft';
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3.5">
      <span className="flex items-center gap-2 text-13 font-medium text-ink">
        <span className={`flex size-6 items-center justify-center rounded-md ${color}`}>
          <Icon name={icon} size={13} />
        </span>
        {title}
      </span>
      {children}
    </div>
  );
}

export function GithubSection({ config, update }: SectionProps) {
  const { toast } = useToast();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const labelField = useId();
  const tokenField = useId();
  const gh = config.github;
  const owner = label.trim();
  const set = (patch: Partial<Config['github']>) => update({ github: { ...gh, ...patch } });

  const refresh = () =>
    api<GithubStatus>('/api/github').then(
      (s) => {
        setStatus(s);
        setLoadError(null);
      },
      (e) => setLoadError((e as Error).message),
    );
  useEffect(() => {
    refresh();
  }, []);

  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await fn();
      toast({ title: success, severity: 'success' });
      await refresh();
    } catch (e) {
      toast({ title: 'GitHub', description: (e as Error).message, severity: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const addToken = () =>
    run(
      'add',
      async () => {
        await api('/api/github/token', { body: { label, token } });
        setToken('');
        setLabel('');
        if (!gh.enabled) set({ enabled: true });
      },
      'Token stored securely',
    );

  const sourceHint = status?.source === 'env' ? 'From TIMESHEET_GITHUB_TOKEN.' : status?.source === 'gh' ? 'Using the gh CLI login until you add a token.' : undefined;

  return (
    <>
      <Group title="Tokens" description={<>Read-only fine-grained tokens, one per account or organization. Stored in {status?.backend ?? 'the OS keychain'}, never in the config file.</>}>
        {loadError && (
          <Block>
            <Alert tone="danger" title="Could not read the GitHub status" description={loadError} action={<Button size="sm" variant="outline" onClick={refresh}>Retry</Button>} />
          </Block>
        )}
        {!status && !loadError && (
          <Block>
            <Skeleton width={160} height={14} />
          </Block>
        )}
        {status && !status.tokens.length && (
          <Row label="Connection">
            <Status tone="neutral">Not set up</Status>
          </Row>
        )}
        {status?.tokens.map((t) => (
          <Row key={t.label} label={t.label} hint={t.login ? `Acts as ${t.login}.` : sourceHint}>
            <Status tone="good">Connected</Status>
            {status.source === 'stored' && (
              <Button variant="outline" size="sm" leadingIcon="trash" loading={busy === `rm:${t.label}`} onClick={() => window.confirm(`Remove the token "${t.label}"?`) && run(`rm:${t.label}`, () => api('/api/github/remove', { body: { label: t.label } }), 'Token removed')}>Remove</Button>
            )}
          </Row>
        ))}
      </Group>

      {status && status.source !== 'env' && (
        <Group title="Add a token" description="One read-only token for each GitHub account or organization you work in. Takes about a minute.">
          <Block>
            <ol className="flex flex-col">
              <Step n={1} title="Who is it for?" done={!!owner}>
                <label className="flex max-w-sm flex-col gap-1.5" htmlFor={labelField}>
                  <Input id={labelField} size="sm" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="acme" autoComplete="off" spellCheck={false} aria-describedby={`${labelField}-hint`} />
                  <span id={`${labelField}-hint`} className="text-12 text-ink-3">
                    The organization name, or your username for personal repos.
                  </span>
                </label>
              </Step>

              <Step n={2} title="Create it on GitHub">
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant={owner ? 'primary' : 'outline'} size="sm" trailingIcon="external-link" onClick={() => window.open(githubTokenUrl(owner || undefined), '_blank', 'noopener')}>
                      Create token on GitHub{owner ? ` for ${owner}` : ''}
                    </Button>
                    <span className="text-12 text-ink-3">Opens GitHub with almost everything filled in.</span>
                  </div>

                  <div className="grid gap-3 tablet:grid-cols-2">
                    <Panel tone="good" icon="check-circle" title="Filled in by the link">
                      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-12">
                        <dt className="text-ink-3">Name</dt>
                        <dd className="font-mono text-ink">timesheet{owner ? ` ${owner}` : ''}</dd>
                        <dt className="text-ink-3">Resource owner</dt>
                        <dd className={owner ? 'font-mono text-ink' : 'italic text-ink-3'}>{owner || 'pick it on GitHub'}</dd>
                        <dt className="text-ink-3">Expiration</dt>
                        <dd className="text-ink">{GITHUB_TOKEN_DAYS} days</dd>
                        <dt className="text-ink-3">Permissions</dt>
                        <dd className="text-ink">{GITHUB_PERMISSIONS.length}, all read-only</dd>
                      </dl>
                    </Panel>
                    <Panel tone="warn" icon="mouse-pointer-2" title="Set by hand">
                      <div className="flex flex-col gap-2 text-12">
                        <span className="text-ink-2">
                          Repository access → <b className="text-ink">All repositories</b>
                        </span>
                        <span className="text-ink-3">GitHub does not let a link choose this. With fewer repos, activity in the others is missed.</span>
                      </div>
                    </Panel>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-12 font-medium text-ink-2">Repository permissions it asks for</span>
                    <div className="grid items-start gap-3 desktop:grid-cols-3">
                      {PERMISSION_GROUPS.map((g) => (
                        <div key={g.id} className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-3.5">
                          <span className="flex items-center gap-2 text-13 font-medium text-ink">
                            <Icon name={g.icon} size={15} className="text-accent-strong" />
                            {g.title}
                          </span>
                          <ul className="flex flex-col gap-2">
                            {GITHUB_PERMISSIONS.filter((p) => p.group === g.id).map((p) => (
                              <li key={p.param} className="flex flex-col gap-0.5">
                                <span className="flex items-center justify-between gap-2 text-13 text-ink">
                                  {p.name}
                                  <Badge variant="neutral" size="sm">Read-only</Badge>
                                </span>
                                <span className="text-12 leading-snug text-ink-3">{p.why}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </Step>

              <Step n={3} title="Paste it here" last>
                <div className="flex max-w-xl flex-col gap-3">
                  <div className="flex flex-col gap-2 tablet:flex-row">
                    <Input id={tokenField} size="sm" type="password" className="flex-1" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" aria-label="Token" />
                    <Button variant="primary" size="sm" leadingIcon="lock" loading={busy === 'add'} disabled={!owner || !token.trim()} onClick={addToken}>Check and store</Button>
                  </div>
                  <span className="flex items-start gap-1.5 text-12 text-ink-3">
                    <Icon name="info" size={13} className="mt-0.5 shrink-0" />
                    <span>
                      The token is checked against GitHub, then saved in {status.backend}. An organization may have to approve it before it can read org repos.
                    </span>
                  </span>
                </div>
              </Step>
            </ol>
          </Block>
        </Group>
      )}

      <Group title="Tracking" description="Issues and PRs you open, reviews and comments, releases you publish, workflows you run by hand and deployments you approve count as work. Each is placed in its repo, so work scope applies as usual.">
        <SwitchRow label="Use GitHub" hint="Turn off to ignore GitHub entirely." checked={gh.enabled} onChange={(enabled) => set({ enabled })} />
        <NumberRow label="Time per action" hint="Credited before each action, like the lead-in before a commit." disabled={!gh.enabled} value={gh.leadMinutes} unit="min" step={5} onChange={(leadMinutes) => set({ leadMinutes })} />
        <ListRow
          label="Extra repos"
          hint={<>Repos you have not cloned but act in, e.g. where you approve platform deployments. <code>owner/name</code>, or <code>owner/*</code> for every recently pushed repo. Repos without a clone are matched by work scope rules like <code>github.com/owner/**</code>.</>}
          disabled={!gh.enabled}
          value={gh.repos}
          onChange={(repos) => set({ repos })}
          placeholder="acme/platform"
          addLabel="Add repo"
        />
      </Group>
    </>
  );
}

// ---------- calendar ----------

export function CalendarSection({ config, update }: SectionProps) {
  const { toast } = useToast();
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<{ id: string; summary: string; primary: boolean }[] | null>(null);
  const [calError, setCalError] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [clientJson, setClientJson] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const idField = useId();
  const secretField = useId();

  const refresh = () =>
    api<AuthStatus>('/api/auth').then(
      (a) => {
        setAuth(a);
        setAuthError(null);
      },
      (e) => setAuthError((e as Error).message),
    );
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    if (!auth?.connected) return;
    setCalError(null);
    api<{ calendars: NonNullable<typeof calendars> }>('/api/calendars').then(
      (r) => setCalendars(r.calendars),
      (e) => setCalError((e as Error).message),
    );
  }, [auth?.connected]);

  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try {
      await fn();
      toast({ title: success, severity: 'success' });
      await refresh();
    } catch (e) {
      toast({ title: 'Google Calendar', description: (e as Error).message, severity: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const saveClient = () =>
    run(
      'client',
      async () => {
        await api('/api/auth/client', { body: clientJson.trim() ? { json: clientJson } : { clientId, clientSecret } });
        setClientJson('');
        setClientSecret('');
      },
      'OAuth client stored securely',
    );

  const ids = new Set(config.calendar.calendarIds);
  const setCal = (patch: Partial<Config['calendar']>) => update({ calendar: { ...config.calendar, ...patch } });
  const status = !auth ? null : auth.connected ? <Status tone="good">Connected</Status> : auth.hasClient ? <Status tone="warn">Not connected</Status> : <Status tone="neutral">Not set up</Status>;

  return (
    <>
      <Group title="Google account" description={<>Credentials are stored in {auth?.backend ?? 'the OS keychain'}, never in the config file.</>}>
        {authError && (
          <Block>
            <Alert tone="danger" title="Could not read the connection status" description={authError} action={<Button size="sm" variant="outline" onClick={refresh}>Retry</Button>} />
          </Block>
        )}
        <Row label="Connection" hint={auth?.connected ? 'Meetings are read with read-only calendar access.' : auth?.hasClient ? 'Sign in once in your browser.' : 'Add an OAuth client first (below).'}>
          {!auth ? <Skeleton width={90} height={14} /> : status}
          {auth?.hasClient && !auth.connected && (
            <Button variant="primary" size="sm" leadingIcon="link" loading={busy === 'connect'} onClick={() => run('connect', () => api('/api/auth/connect', { body: {} }), 'Connected to Google Calendar')}>Connect</Button>
          )}
          {auth?.connected && (
            <Button variant="outline" size="sm" loading={busy === 'disconnect'} onClick={() => run('disconnect', () => api('/api/auth/disconnect', { body: {} }), 'Disconnected')}>Disconnect</Button>
          )}
        </Row>
        {auth?.hasClient && (
          <Row label="OAuth client" hint="Remove it to switch to a different Google Cloud client.">
            <Button variant="outline" size="sm" leadingIcon="trash" loading={busy === 'forget'} onClick={() => window.confirm('Remove the OAuth client and sign out? You will need the client ID and secret again to reconnect.') && run('forget', () => api('/api/auth/disconnect', { body: { forgetClient: true } }), 'OAuth client removed')}>Remove client</Button>
          </Row>
        )}
        {auth && !auth.hasClient && (
          <Block className="flex flex-col gap-4">
            <ol className="list-decimal space-y-1 pl-5 text-13 text-ink-2">
              <li>
                In console.cloud.google.com, open your project and enable the <b>Google Calendar API</b>.
              </li>
              <li>
                Under Google Auth Platform, set the audience (Internal for Workspace, or External with yourself as test user) and add the <code>calendar.readonly</code> scope.
              </li>
              <li>
                Create a client of type <b>Desktop app</b> and download its JSON.
              </li>
            </ol>
            <Textarea rows={3} className="font-mono text-12" value={clientJson} onChange={(e) => setClientJson(e.target.value)} placeholder='Paste the downloaded JSON: {"installed":{"client_id":"…","client_secret":"…"}}' spellCheck={false} aria-label="Client JSON" />
            <div className="grid gap-3 tablet:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-12 font-medium text-ink-2" htmlFor={idField}>
                Or enter the client ID
                <Input id={idField} size="sm" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="….apps.googleusercontent.com" autoComplete="off" spellCheck={false} />
              </label>
              <label className="flex flex-col gap-1.5 text-12 font-medium text-ink-2" htmlFor={secretField}>
                and client secret
                <Input id={secretField} size="sm" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
              </label>
            </div>
            <div>
              <Button variant="primary" size="sm" leadingIcon="lock" loading={busy === 'client'} disabled={!clientJson.trim() && !(clientId && clientSecret)} onClick={saveClient}>Store in keychain</Button>
            </div>
          </Block>
        )}
      </Group>

      <Group title="Meetings" description="Meetings with other attendees count as work; choose which replies count below. An out-of-office of 4 hours or more stops normalization for that day.">
        <SwitchRow label="Use Google Calendar" hint="Turn off to ignore meetings entirely." checked={config.calendar.enabled} onChange={(enabled) => setCal({ enabled })} />
        {config.projects.length > 1 && (
          <Row label="Book meetings to" disabled={!config.calendar.enabled}>
            <Select size="sm" className={CONTROL_W} disabled={!config.calendar.enabled} aria-label="Meeting project" value={config.calendar.project ?? config.defaultProject} onValueChange={(project) => setCal({ project })} items={config.projects.map((p) => ({ value: p, label: p }))} />
          </Row>
        )}
        <SwitchRow label="Count tentative meetings" disabled={!config.calendar.enabled} checked={config.calendar.includeTentative} onChange={(includeTentative) => setCal({ includeTentative })} />
        <SwitchRow label="Count unanswered invitations" hint="Meetings you never replied to." disabled={!config.calendar.enabled} checked={config.calendar.includeUnanswered} onChange={(includeUnanswered) => setCal({ includeUnanswered })} />
        <SwitchRow label="Count declined meetings" hint="For meetings you joined after declining." disabled={!config.calendar.enabled} checked={config.calendar.includeDeclined} onChange={(includeDeclined) => setCal({ includeDeclined })} />
        <SwitchRow label="Skip events without attendees" hint="Focus time and reminders." disabled={!config.calendar.enabled} checked={config.calendar.skipWithoutAttendees} onChange={(skipWithoutAttendees) => setCal({ skipWithoutAttendees })} />
        <NumberRow label="Ignore meetings longer than" hint="Day-long holds and conferences. 0 counts every length." disabled={!config.calendar.enabled} value={config.calendar.maxMeetingHours} unit="h" step={0.5} onChange={(maxMeetingHours) => setCal({ maxMeetingHours })} />
      </Group>

      <Group
        title="Calendars"
        count={calendars ? `${calendars.filter((c) => ids.has(c.id) || (c.primary && ids.has('primary'))).length} of ${calendars.length} counted` : undefined}
        description="Which calendars count as work."
      >
        {calError && (
          <Block>
            <Alert tone="danger" title="Could not list calendars" description={calError} />
          </Block>
        )}
        {auth?.connected && !calendars && !calError && (
          <Block className="flex items-center gap-2 text-13 text-ink-3">
            <Spinner size="sm" /> Loading calendars…
          </Block>
        )}
        {calendars?.map((c) => {
          const on = ids.has(c.id) || (c.primary && ids.has('primary'));
          const others = config.calendar.calendarIds.filter((x) => x !== c.id && !(c.primary && x === 'primary'));
          return <SwitchRow key={c.id} label={c.primary ? `${c.summary} (primary)` : c.summary} disabled={!config.calendar.enabled} checked={on} onChange={(v) => setCal({ calendarIds: v ? [...others, c.id] : others })} />;
        })}
        {!auth?.connected && <ListRow label="Calendar IDs" hint="primary is your main calendar. Connect to pick from a list." value={config.calendar.calendarIds} onChange={(calendarIds) => setCal({ calendarIds })} placeholder="primary" addLabel="Add calendar" />}
      </Group>
    </>
  );
}

// ---------- classification ----------

const MODELS = ['haiku', 'sonnet', 'opus'];

export function ClassifierSection({ config, update, detected }: SectionProps & { detected: Detected | null }) {
  const c = config.classifier;
  const set = (patch: Partial<Config['classifier']>) => update({ classifier: { ...c, ...patch } });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const known = detected?.claudeCommands ?? [];
  const [custom, setCustom] = useState(false);
  const isCustom = custom || (!!detected && !known.includes(c.command));
  const commandItems = [...new Set([...known, ...(detected ? [] : [c.command])])].map((x) => ({ value: x, label: x }));

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api<{ ok: boolean; seconds: number; error?: string; reply?: string }>('/api/classifier/test', { body: { classifier: c } });
      setResult(r.ok ? { ok: true, text: `Answered in ${r.seconds.toFixed(1)} s using ${c.model}.` } : { ok: false, text: r.error ?? `Unexpected reply: ${r.reply}` });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <Group title="Claude" description="One headless Claude call per day assigns task categories and writes the daily summary. Its own sessions never count as work. Without it, meetings and other work are booked under the categories with the Meetings and Work roles.">
        <SwitchRow label="Classify with Claude" checked={c.enabled} onChange={(enabled) => set({ enabled })} />
        <Row label="Claude command" disabled={!c.enabled} hint="Profile wrappers (shell functions such as claude-work) run through your shell with their own login.">
          {!detected ? (
            <Skeleton width={224} height={32} />
          ) : (
            <Select
              size="sm"
              className={CONTROL_W}
              aria-label="Claude command"
              value={isCustom ? '__custom' : c.command}
              onValueChange={(v) => {
                setResult(null);
                if (v === '__custom') setCustom(true);
                else {
                  setCustom(false);
                  set({ command: v });
                }
              }}
              items={[...commandItems, { value: '__custom', label: 'Other command…' }]}
            />
          )}
          <Button size="sm" variant="outline" loading={testing} disabled={!c.command} onClick={test}>Test</Button>
        </Row>
        {isCustom && (
          <Row label="Command to run" disabled={!c.enabled} hint="Anything that accepts Claude Code's -p flags.">
            <Input size="sm" className="w-72 font-mono text-12" value={c.command} onChange={(e) => set({ command: e.target.value })} placeholder="claude" autoComplete="off" spellCheck={false} aria-label="Command to run" />
          </Row>
        )}
        {result && (
          <Block>
            <Alert tone={result.ok ? 'good' : 'danger'} title={result.ok ? `"${c.command}" works` : `"${c.command}" did not work`} description={result.text} dismissible onDismiss={() => setResult(null)} />
          </Block>
        )}
        <Row label="Model" hint="Sonnet is a good balance; Haiku is fastest, Opus most careful." disabled={!c.enabled}>
          <Select
            size="sm"
            className={CONTROL_W}
            aria-label="Model"
            value={c.model}
            onValueChange={(model) => set({ model })}
            items={[
              { value: 'haiku', label: 'Haiku' },
              { value: 'sonnet', label: 'Sonnet' },
              { value: 'opus', label: 'Opus' },
              ...(MODELS.includes(c.model) ? [] : [{ value: c.model, label: c.model }]),
            ]}
          />
        </Row>
      </Group>
      <Group title="Runs" description="Each day is classified in its own Claude call.">
        <NumberRow label="Timeout per day" hint="A day that takes longer is retried later." disabled={!c.enabled} value={c.timeoutSeconds} min={10} unit="s" onChange={(timeoutSeconds) => set({ timeoutSeconds })} />
        <NumberRow label="Days in parallel" disabled={!c.enabled} hint="More is faster but starts more Claude processes at once." value={c.concurrency} min={1} max={8} onChange={(concurrency) => set({ concurrency })} />
      </Group>
      <Group title="Guidance" description="Added to the prompt, for example how your team tells two similar categories apart.">
        <Block className={c.enabled ? '' : 'opacity-50'}>
          <Textarea rows={3} value={c.notes ?? ''} onChange={(e) => set({ notes: e.target.value || undefined })} placeholder="Code review counts as feature work." aria-label="Extra guidance" />
        </Block>
      </Group>
    </>
  );
}

// ---------- categories ----------

function CategoryDot({ tone, hue }: { tone?: string; hue: number | null }) {
  return hue === null ? <span className={`size-2.5 shrink-0 rounded-full ${TONE_BG[tone ?? ''] ?? 'bg-line-strong'}`} /> : <span className="size-2.5 shrink-0 rounded-full" style={{ background: hueColor(hue) }} />;
}

const EMPTY: Category = { name: '', subtask: '', description: '', capex: false };

const ROLES: { value: CategoryRole; label: string; hint: string }[] = [
  { value: 'work', label: 'Work (default)', hint: 'Default for work blocks; coding time taken from other categories lands here.' },
  { value: 'meeting', label: 'Meetings (default)', hint: 'Default for calendar meetings.' },
  { value: 'fallback', label: 'Fallback', hint: 'Work that fits nowhere else.' },
  { value: 'no-code', label: 'No code', hint: 'Analysis, planning, meetings: never claims time in which code was written.' },
  { value: 'deploy', label: 'Release', hint: 'Capped at the minutes its releases, approvals and deploy runs take.' },
  { value: 'incident', label: 'Incident', hint: 'Only with a sign of a production problem in prompts, commits or branches.' },
];
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]));

function CategoryDialog({ category, open, onClose, onSave, onDelete, names }: { category: Category | null; open: boolean; onClose: () => void; onSave: (c: Category) => void; onDelete?: () => void; names: string[] }) {
  const [draft, setDraft] = useState<Category>(category ?? EMPTY);
  useEffect(() => setDraft(category ?? EMPTY), [category, open]);
  const set = (patch: Partial<Category>) => setDraft((d) => ({ ...d, ...patch }));
  const duplicate = draft.name.trim() !== (category?.name ?? '') && names.includes(draft.name.trim());
  const field = 'flex flex-col gap-1.5 text-12 font-medium text-ink-2';
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{category ? 'Edit category' : 'New category'}</DialogTitle>
          <DialogDescription>Names must match your company's task list exactly.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 tablet:grid-cols-2">
            <label className={field}>
              Name
              <Input size="sm" value={draft.name} onChange={(e) => set({ name: e.target.value })} error={!draft.name.trim() || duplicate} autoFocus />
              {duplicate && <span className="text-danger">Another category has this name.</span>}
            </label>
            <label className={field}>
              Subtask
              <Input size="sm" value={draft.subtask} onChange={(e) => set({ subtask: e.target.value })} />
            </label>
          </div>
          <label className={field}>
            Description
            <Textarea rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
          </label>
          <div className="grid gap-4 tablet:grid-cols-2">
            <label className={field}>
              Valid from
              <Input size="sm" type="date" value={draft.validFrom ?? ''} onChange={(e) => set({ validFrom: e.target.value || undefined })} />
            </label>
            <label className={field}>
              Valid until
              <Input size="sm" type="date" value={draft.validTo ?? ''} onChange={(e) => set({ validTo: e.target.value || undefined })} />
            </label>
          </div>
          <div className="grid gap-4 tablet:grid-cols-2">
            <div className={field}>
              Accounting
              <Select size="sm" aria-label="Accounting" items={[{ value: 'capex', label: 'CAPEX · capitalized' }, { value: 'opex', label: 'OPEX · operating' }]} value={draft.capex ? 'capex' : 'opex'} onValueChange={(v) => set({ capex: v === 'capex' })} />
            </div>
            <div className={field}>
              Rule
              <Select size="sm" aria-label="Rule" value={draft.role ?? 'none'} onValueChange={(v) => set({ role: v === 'none' ? undefined : (v as CategoryRole) })} items={[{ value: 'none', label: 'None' }, ...ROLES]} />
              <span className="font-normal text-ink-3">{ROLES.find((r) => r.value === draft.role)?.hint ?? 'Classified by its description only.'}</span>
            </div>
            <div className={field}>
              Calendar color
              <Select size="sm" aria-label="Color" value={draft.tone ?? 'auto'} onValueChange={(v) => set({ tone: v === 'auto' ? undefined : v })} items={[{ value: 'auto', label: 'Own colour (automatic)' }, ...TONES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))]} />
            </div>
          </div>
          <label className="flex items-center justify-between gap-4 rounded-md border border-line px-3 py-2.5">
            <span>
              <span className="block text-13 font-medium">Suggested by classification</span>
              <span className="block text-12 text-ink-3">Off keeps it for manual booking only.</span>
            </span>
            <Switch checked={draft.classify !== false} onCheckedChange={(on) => set({ classify: on ? undefined : false })} aria-label="Suggested by classification" />
          </label>
        </div>
        <DialogFooter>
          {onDelete && (
            <Button variant="ghost" size="sm" leadingIcon="trash" className="mr-auto text-danger" onClick={onDelete}>Delete</Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!draft.name.trim() || duplicate} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
            {category ? 'Apply' : 'Add category'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CategoriesSection({ config, update, autoTones = {} }: SectionProps & { autoTones?: Record<string, string> }) {
  const cats = config.categories;
  const hues = categoryHues(cats);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [pasting, setPasting] = useState(false);
  const save = (c: Category) => {
    if (editing === 'new') update({ categories: [...cats, c] });
    else if (typeof editing === 'number') {
      update({ categories: cats.map((x, j) => (j === editing ? c : x)) });
    }
    setEditing(null);
  };
  const validity = (c: Category) => (c.validFrom && c.validTo ? `${c.validFrom} → ${c.validTo}` : c.validFrom ? `from ${c.validFrom}` : c.validTo ? `until ${c.validTo}` : '');
  const row = (c: Category, i: number) => (
    <button key={i} type="button" onClick={() => setEditing(i)} className="group flex min-h-12 w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none">
      <CategoryDot tone={c.tone ?? autoTones[c.name]} hue={hues.get(c.name) ?? null} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-13 font-medium">{c.name}</span>
        {c.subtask && <span className="truncate text-12 text-ink-3">{c.subtask}</span>}
      </span>
      <span className="hidden text-right text-12 text-ink-3 tablet:block">
        {[c.role ? ROLE_LABEL[c.role] : '', validity(c), c.classify === false ? 'manual only' : ''].filter(Boolean).join(' · ')}
      </span>
      <Icon name="chevron-right" size={16} className="shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
  const indexed = cats.map((c, i) => [c, i] as const);
  const capex = indexed.filter(([c]) => c.capex);
  const opex = indexed.filter(([c]) => !c.capex);
  const actions = (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" leadingIcon="clipboard" onClick={() => setPasting(true)}>Paste a list</Button>
      <Button size="sm" variant="outline" leadingIcon="plus" onClick={() => setEditing('new')}>Add category</Button>
    </div>
  );
  return (
    <>
      {cats.length ? (
        <>
          <Group title="CAPEX" count={capex.length} description="Capitalized: building or substantially improving an asset. Validity dates retire old tasks." actions={actions}>
            {capex.length ? capex.map(([c, i]) => row(c, i)) : <Block className="text-13 text-ink-3">No CAPEX categories.</Block>}
          </Group>
          <Group title="OPEX" count={opex.length} description="Operating: running, supporting and maintaining what exists.">
            {opex.length ? opex.map(([c, i]) => row(c, i)) : <Block className="text-13 text-ink-3">No OPEX categories.</Block>}
          </Group>
        </>
      ) : (
        <Group title="Task categories" description="Task categories come from your company's time tracking. Paste your task list, or add categories one by one." actions={actions}>
          <Block className="text-13 text-ink-3">No categories yet. Until you add some, every hour is booked as Uncategorized and Claude only writes summaries.</Block>
        </Group>
      )}
      <CategoryDialog
        open={editing !== null}
        category={typeof editing === 'number' ? cats[editing] : null}
        names={cats.map((c) => c.name)}
        onClose={() => setEditing(null)}
        onSave={save}
        onDelete={typeof editing === 'number' ? () => (update({ categories: cats.filter((_, j) => j !== editing) }), setEditing(null)) : undefined}
      />
      <PasteCategoriesDialog
        open={pasting}
        current={cats}
        onClose={() => setPasting(false)}
        onApply={(categories) => (update({ categories }), setPasting(false))}
      />
    </>
  );
}

function PasteCategoriesDialog({ open, current, onClose, onApply }: { open: boolean; current: Category[]; onClose: () => void; onApply: (c: Category[]) => void }) {
  const [text, setText] = useState('');
  useEffect(() => setText(''), [open]);
  let parsed: Category[] = [];
  let error = '';
  try {
    parsed = text.trim() ? parseCategoryList(text) : [];
  } catch (e) {
    error = (e as Error).message;
  }
  const added = mergeCategories(current, parsed).length - current.length;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Paste a task list</DialogTitle>
          <DialogDescription>One category per line, or rows copied from a spreadsheet: name, subtask, description, CAPEX/OPEX. Only the name is needed; set rules and accounting afterwards.</DialogDescription>
        </DialogHeader>
        <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Feature Build\tNew functionality\tFeatures, screens, endpoints\tCAPEX\nPolish\tSmall changes\tTweaks to existing features\tOPEX\nMeetings'} aria-label="Task list" autoFocus />
        <span className={`text-12 ${error ? 'text-danger' : 'text-ink-3'}`}>
          {error || (parsed.length ? `${parsed.length} categor${parsed.length === 1 ? 'y' : 'ies'} found${current.length ? `, ${added} new` : ''}.` : 'Nothing pasted yet.')}
        </span>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          {current.length > 0 && (
            <Button variant="outline" size="sm" disabled={!added} onClick={() => onApply(mergeCategories(current, parsed))}>Add new ones</Button>
          )}
          <Button variant="primary" size="sm" disabled={!parsed.length} onClick={() => onApply(parsed)}>
            {current.length ? 'Replace all' : 'Use this list'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- advanced ----------

export function RawJsonSection({ config, replace, path }: { config: Config; replace: (c: Config) => void; path?: string }) {
  const [text, setText] = useState(() => JSON.stringify(config, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(JSON.stringify(config, null, 2)), [config]);
  const changed = text !== JSON.stringify(config, null, 2);
  return (
    <Group
      title="Raw configuration"
      description={<>Every option as JSON{path ? <> (stored in <code>{path}</code>)</> : null}. Apply, then save.</>}
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={!changed}
          onClick={() => {
            try {
              replace(JSON.parse(text));
              setError(null);
            } catch (e) {
              setError(`Invalid JSON: ${(e as Error).message}`);
            }
          }}
        >
          Apply JSON
        </Button>
      }
    >
      {error && (
        <Block>
          <Alert tone="danger" title={error} />
        </Block>
      )}
      <Textarea rows={24} className="rounded-none border-0 font-mono text-12 focus-visible:ring-0" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Configuration JSON" />
    </Group>
  );
}
