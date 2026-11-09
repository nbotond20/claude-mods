import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Icon, Spinner } from '@loam/ui-web';
import { api, fmt, SYSTEM_LABEL, type CheckProgress, type CheckWeek, type CheckWeekState, type LabeledCell, type RunProgress, type SubmitRunState, type SystemId, type UnitState, type WeekState } from './api';

const POLL_MS = 1000;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plusDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d);
};
const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const weekday = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
const weekRange = (week: string) => `${short(week)} – ${short(plusDays(week, 6))}`;
const total = (cells: LabeledCell[]) => cells.reduce((s, c) => s + c.hours, 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

type Tone = 'neutral' | 'info' | 'warn' | 'good' | 'danger';

const CHECK_LABEL: Record<CheckWeekState, string> = { pending: 'waiting', reading: 'reading…', ready: 'to enter', noop: 'already entered', conflict: 'needs you', blocked: 'not entered', failed: 'could not read' };
const CHECK_TONE: Record<CheckWeekState, Tone> = { pending: 'neutral', reading: 'info', ready: 'info', noop: 'good', conflict: 'warn', blocked: 'warn', failed: 'danger' };
const WEEK_LABEL: Record<WeekState, string> = { pending: 'next', checking: 'opening…', entering: 'entering…', done: 'already entered', skipped: 'not entered', saved: 'entered and verified', failed: 'failed', aborted: 'stopped' };
const WEEK_TONE: Record<WeekState, Tone> = { pending: 'neutral', checking: 'info', entering: 'info', done: 'good', skipped: 'warn', saved: 'good', failed: 'danger', aborted: 'warn' };
const UNIT_LABEL: Record<UnitState, string> = { pending: 'next', working: 'filling in…', waiting: 'press Save in the browser (never Submit)', saved: 'saved and verified', failed: 'failed', aborted: 'stopped' };

type Step = 'idle' | 'checking' | 'review' | 'entering' | 'done' | 'problem';

/**
 * Entering a week or a month into one system, in three visible steps: Check reads what the site
 * already holds (read-only) and shows it next to the timesheet as a grid; Enter fills in exactly what
 * the grid marked as new, week by week, and verifies each save. Submit is never pressed.
 */
export function AutoEnter({ system, from, to, scope }: { system: SystemId; from: string; to: string; scope: string }) {
  const label = SYSTEM_LABEL[system];
  const [check, setCheck] = useState<CheckProgress | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [busy, setBusy] = useState<'check' | 'start' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = seq.current;
    try {
      const [c, r] = await Promise.all([api<{ check: CheckProgress | null }>(`/api/submit/check?system=${system}&from=${from}&to=${to}`), api<SubmitRunState>(`/api/submit/run?system=${system}`)]);
      if (id !== seq.current) return;
      setCheck(c.check);
      const p = r.progress;
      setProgress(p && p.from === from && p.to === to ? p : null);
    } catch {
      /* the next poll retries */
    }
  }, [system, from, to]);

  useEffect(() => {
    seq.current++;
    setCheck(null);
    setProgress(null);
    setError(null);
    load();
  }, [load]);

  const running = progress?.status === 'running' || check?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const call = async <T,>(kind: 'check' | 'start' | 'cancel', path: string, body: unknown): Promise<T | null> => {
    setBusy(kind);
    setError(null);
    const id = seq.current;
    try {
      const r = await api<T>(path, { body });
      return id === seq.current ? r : null;
    } catch (e) {
      if (id === seq.current) setError((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const runCheck = async () => {
    const r = await call<{ check: CheckProgress }>('check', '/api/submit/check', { system, from, to });
    if (r) {
      setProgress(null);
      setCheck(r.check);
    }
  };
  const start = async () => {
    if (!check?.token) return;
    const r = await call<{ progress: RunProgress }>('start', '/api/submit/start', { system, from, to, token: check.token });
    if (r) setProgress(r.progress);
  };
  const cancel = async () => {
    await call('cancel', '/api/submit/cancel', {});
    load();
  };

  // A run is newer than the check it came from when it exists for this range.
  const runIsCurrent = progress !== null && (!check || progress.startedAt >= (check.finishedAt ?? check.startedAt));
  const step: Step = runIsCurrent
    ? progress.status === 'running'
      ? 'entering'
      : progress.status === 'saved' || progress.status === 'filled' || progress.status === 'noop'
        ? 'done'
        : 'problem'
    : check?.status === 'running'
      ? 'checking'
      : check?.status === 'done'
        ? 'review'
        : check
          ? 'problem'
          : 'idle';

  const toEnter = check?.weeks.filter((w) => w.state === 'ready') ?? [];
  const hours = toEnter.reduce((s, w) => s + total(w.write), 0);

  return (
    <div className="flex flex-col gap-3">
      <Steps step={step} />
      <StatusLine step={step} label={label} check={check} progress={runIsCurrent ? progress : null} error={error} />

      <div className="flex flex-wrap items-center gap-2">
        {step === 'review' && toEnter.length > 0 && (
          <Button variant="primary" size="sm" leadingIcon="play" loading={busy === 'start'} disabled={busy !== null} onClick={start}>
            Enter {fmt(hours)} h in {label}
          </Button>
        )}
        {!running && (
          <Button variant={step === 'review' && toEnter.length > 0 ? 'outline' : 'primary'} size="sm" leadingIcon={step === 'idle' ? 'search' : 'refresh'} loading={busy === 'check'} disabled={busy !== null} onClick={runCheck}>
            {step === 'idle' ? `Check ${label}` : 'Check again'}
          </Button>
        )}
        {running && (
          <Button variant="outline" size="sm" leadingIcon="x" loading={busy === 'cancel'} onClick={cancel}>
            Cancel
          </Button>
        )}
        {step === 'idle' && <span className="text-12 text-ink-3">Reads what {label} already holds for {scope}; nothing is written.</span>}
        {step === 'review' && toEnter.length > 0 && <span className="text-12 text-ink-3">{check?.fillOnly ? 'You press Save in the browser for each week. ' : ''}Never presses Submit.</span>}
      </div>

      {check && !runIsCurrent && check.weeks.length > 0 && (
        <div className="flex flex-col gap-4">
          {check.weeks.map((w) => (
            <CheckedWeek key={w.week} week={w} from={from} to={to} label={label} />
          ))}
          <Legend />
        </div>
      )}
      {runIsCurrent && <RunWeeks progress={progress} check={check} from={from} to={to} label={label} />}
    </div>
  );
}

const STEPS: { key: Step[]; label: string }[] = [
  { key: ['checking'], label: 'Check site' },
  { key: ['review'], label: 'Review' },
  { key: ['entering'], label: 'Enter & verify' },
  { key: ['done'], label: 'Done' },
];

function Steps({ step }: { step: Step }) {
  const at = STEPS.findIndex((s) => s.key.includes(step));
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-12">
      {STEPS.map((s, i) => {
        const done = at > i;
        const current = at === i;
        return (
          <li key={s.label} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-4 bg-line-strong" aria-hidden />}
            <span className={`flex items-center gap-1.5 ${current ? 'font-semibold text-ink' : done ? 'text-ink-2' : 'text-ink-3'}`} aria-current={current ? 'step' : undefined}>
              <span className={`grid size-5 place-items-center rounded-full border text-11 tabular-nums ${current ? 'border-accent bg-accent text-accent-ink' : done ? 'border-line-strong text-ink-2' : 'border-line text-ink-3'}`}>
                {done ? <Icon name="check" size={12} /> : i + 1}
              </span>
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StatusLine({ step, label, check, progress, error }: { step: Step; label: string; check: CheckProgress | null; progress: RunProgress | null; error: string | null }) {
  let tone: Tone = 'neutral';
  let text: string;
  let sub: string | undefined;
  if (step === 'entering' && progress) {
    tone = 'info';
    text = progress.message;
    const waiting = progress.units.some((u) => u.state === 'waiting');
    if (waiting) {
      tone = 'warn';
      sub = `Press Save in the ${label} window. Never Submit.`;
    }
  } else if (step === 'checking' && check) {
    tone = check.login ? 'warn' : 'info';
    text = check.message;
    if (check.login) sub = `Log in to ${label} in the browser window that opened; the check continues by itself.`;
  } else if (step === 'review' && check) {
    const n = (s: CheckWeekState) => check.weeks.filter((w) => w.state === s).length;
    const ready = n('ready');
    tone = ready ? 'info' : 'good';
    text = ready ? `Ready: ${plural(ready, 'week')} with new hours. Look at the grid, then enter.` : n('noop') === check.weeks.length ? `Everything is already in ${label}.` : `Nothing to enter in ${label}.`;
    const issues = n('conflict') + n('blocked') + n('failed');
    if (issues) {
      tone = ready ? 'info' : 'warn';
      sub = `${plural(issues, 'week')} cannot be entered; see why below.`;
    }
  } else if (step === 'done' && progress) {
    tone = progress.status === 'saved' ? 'good' : 'neutral';
    text = progress.status === 'saved' ? `Entered and verified in ${label}. Nothing was submitted for approval.` : progress.message;
  } else if (step === 'problem') {
    tone = progress?.status === 'failed' ? 'danger' : 'warn';
    text = progress ? (progress.status === 'failed' ? `Failed: check ${label} by hand` : 'Stopped') : (check?.message ?? 'Stopped');
    sub = progress?.error ?? check?.error;
  } else {
    text = `Not checked yet.`;
  }
  const box: Record<Tone, string> = {
    neutral: 'border-line bg-surface-2/40',
    info: 'border-line bg-surface-2/40',
    good: 'border-good/40 bg-good/10',
    warn: 'border-warn/40 bg-warn/10',
    danger: 'border-danger/40 bg-danger/10',
  };
  const icon = { neutral: 'info', info: 'info', good: 'check', warn: 'alert-triangle', danger: 'alert-circle' } as const;
  const busy = step === 'checking' || step === 'entering';
  return (
    <div className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 ${box[tone]}`} aria-live="polite">
      <span className="mt-0.5 shrink-0">{busy ? <Spinner size="sm" /> : <Icon name={icon[tone]} size={16} className={tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-ink-3'} />}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-13 font-medium text-ink">{text}</span>
        {sub && <span className="break-words text-12 text-ink-2">{sub}</span>}
        {error && <span className="break-words text-12 text-danger">{error}</span>}
        {step === 'problem' && progress && progress.screenshots.length > 0 && <code className="break-all text-11 text-ink-3">{progress.screenshots[progress.screenshots.length - 1]}</code>}
      </span>
    </div>
  );
}

function CheckedWeek({ week: w, from, to, label }: { week: CheckWeek; from: string; to: string; label: string }) {
  const add = total(w.write);
  const hasCells = w.plan.length > 0 || w.site.length > 0;
  return (
    <section className="flex flex-col gap-1.5" aria-label={`Week of ${weekRange(w.week)}`}>
      <div className="flex flex-wrap items-center gap-2 text-12">
        <span className="font-semibold text-ink">{weekRange(w.week)}</span>
        <Badge size="sm" variant={CHECK_TONE[w.state]}>{w.state === 'noop' && !hasCells ? 'nothing to enter' : CHECK_LABEL[w.state]}</Badge>
        {w.state === 'ready' && <span className="text-ink-2">+{fmt(add)} h</span>}
        {w.state === 'reading' && <Spinner size="sm" />}
      </div>
      {hasCells && w.state !== 'blocked' && w.state !== 'pending' && <Grid week={w} from={from} to={to} label={label} />}
      {w.reasons.length > 0 && w.state !== 'conflict' && <Problems items={w.reasons} />}
      {Object.keys(w.held).length > 0 && <Problems title="Left as they are (the site holds other hours there):" items={Object.values(w.held).flat()} />}
    </section>
  );
}

function Problems({ title, items }: { title?: string; items: string[] }) {
  return (
    <div className="flex flex-col gap-0.5 text-12 text-ink-2">
      {title && <span className="text-ink-3">{title}</span>}
      {items.slice(0, 6).map((r) => (
        <span key={r} className="flex items-start gap-1.5 break-words">
          <Icon name="alert-triangle" size={12} className="mt-0.5 shrink-0 text-warn" /> {r}
        </span>
      ))}
      {items.length > 6 && <span className="pl-5 text-ink-3">and {items.length - 6} more</span>}
    </div>
  );
}

type CellKind = 'same' | 'new' | 'held' | 'extra' | 'off' | 'frozen' | 'outside' | 'empty';

const CELL_CLASS: Record<CellKind, string> = {
  same: 'text-ink-3',
  new: 'bg-accent/10 font-semibold text-accent-strong',
  held: 'bg-warn/10 text-ink',
  extra: 'bg-warn/10 text-ink line-through decoration-warn',
  off: 'text-ink-3',
  frozen: 'text-ink-3',
  outside: 'text-ink-3/50',
  empty: 'text-ink-3/50',
};

/** One week as a grid: rows are the site's rows, columns the days; each cell shows what is there and what is new. */
function Grid({ week: w, from, to, label }: { week: CheckWeek; from: string; to: string; label: string }) {
  const days = Array.from({ length: 7 }, (_, i) => plusDays(w.week, i));
  const rows = [...new Set([...w.plan, ...w.site].map((c) => c.label))].sort();
  const at = (cells: LabeledCell[], row: string, day: string) => cells.find((c) => c.label === row && c.date === day)?.hours;
  const off = new Set(w.off);
  const kindOf = (row: string, day: string): { kind: CellKind; text: string; title?: string } => {
    const p = at(w.plan, row, day);
    const s = at(w.site, row, day);
    if (day < from || day > to) return { kind: 'outside', text: s ? fmt(s) : '', title: 'Outside the range: not touched' };
    if (w.frozen[day]) return { kind: 'frozen', text: s ? fmt(s) : '', title: `${w.frozen[day]}: not touched` };
    if (at(w.write, row, day) !== undefined) return { kind: 'new', text: `+${fmt(p!)}`, title: 'Will be entered' };
    if (p !== undefined && s !== undefined && Math.abs(p - s) < 0.005) return { kind: 'same', text: fmt(s), title: 'Already entered' };
    if (p !== undefined && s !== undefined) return { kind: 'held', text: `${fmt(s)} → ${fmt(p)}`, title: `${label} has ${fmt(s)} h, the timesheet books ${fmt(p)} h: left as it is` };
    if (s !== undefined) return off.has(day) ? { kind: 'off', text: fmt(s), title: 'Day off: left as it is' } : { kind: 'extra', text: fmt(s), title: 'Not booked by the timesheet: left as it is' };
    if (p !== undefined) return { kind: w.held[day] ? 'held' : 'new', text: w.held[day] ? fmt(p) : `+${fmt(p)}`, title: w.held[day] ? 'Day held back' : 'Will be entered' };
    return { kind: 'empty', text: '' };
  };
  const dayTotal = (cells: LabeledCell[], day: string) => cells.filter((c) => c.date === day).reduce((s, c) => s + c.hours, 0);
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full min-w-[34rem] border-collapse text-12">
        <thead>
          <tr className="border-b border-line text-ink-3">
            <th className="px-2.5 py-1.5 text-left font-medium">{label === 'Redmine' ? 'Issue · activity' : 'Project · task'}</th>
            {days.map((d) => (
              <th key={d} className={`w-14 px-1.5 py-1.5 text-right font-medium ${d < from || d > to ? 'opacity-50' : ''}`}>
                <span className="flex flex-col items-end leading-tight">
                  <span>{weekday(d)}</span>
                  <span className="text-11 font-normal tabular-nums">{w.frozen[d] ? <Icon name="lock" size={11} /> : off.has(d) ? 'off' : w.held[d] ? <Icon name="alert-triangle" size={11} className="text-warn" /> : short(d).replace(/^\D+\s/, '')}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row}>
              <td className="max-w-[16rem] truncate px-2.5 py-1.5 text-ink" title={row}>
                {row}
              </td>
              {days.map((d) => {
                const c = kindOf(row, d);
                return (
                  <td key={d} className={`px-1.5 py-1.5 text-right tabular-nums ${CELL_CLASS[c.kind]}`} title={c.title}>
                    {c.text}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="border-t border-line-strong text-ink-2">
            <td className="px-2.5 py-1.5 font-medium">After entering</td>
            {days.map((d) => {
              const after = dayTotal(w.site, d) + dayTotal(w.write, d);
              return (
                <td key={d} className={`px-1.5 py-1.5 text-right font-medium tabular-nums ${d < from || d > to ? 'opacity-50' : ''}`}>
                  {after ? fmt(after) : ''}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Legend() {
  const item = (cls: string, text: string, sample: string) => (
    <span className="flex items-center gap-1.5">
      <span className={`rounded px-1 tabular-nums ${cls}`}>{sample}</span>
      {text}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-11 text-ink-3">
      {item(CELL_CLASS.new, 'will be entered', '+8')}
      {item(CELL_CLASS.same, 'already there', '8')}
      {item(CELL_CLASS.held, 'differs: left as it is', '2 → 8')}
      {item(CELL_CLASS.extra, 'not in the timesheet: left as it is', '2')}
      <span className="flex items-center gap-1.5">
        <Icon name="lock" size={11} /> approved or submitted: not touched
      </span>
    </div>
  );
}

function RunWeeks({ progress, check, from, to, label }: { progress: RunProgress; check: CheckProgress | null; from: string; to: string; label: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
      {progress.weeks.map((w) => {
        const checked = check?.weeks.find((c) => c.week === w.week);
        const expanded = open === w.week;
        const canExpand = !!checked && (checked.plan.length > 0 || checked.site.length > 0);
        return (
          <li key={w.week} className="flex flex-col gap-2 px-3 py-2 text-12">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">{weekRange(w.week)}</span>
              <Badge size="sm" variant={WEEK_TONE[w.state]}>{WEEK_LABEL[w.state]}</Badge>
              {w.cells.length > 0 && <span className="text-ink-2">+{fmt(total(w.cells))} h</span>}
              {(w.state === 'checking' || w.state === 'entering') && <Spinner size="sm" />}
              {canExpand && (
                <Button variant="ghost" size="xs" className="ml-auto" trailingIcon={expanded ? 'chevron-up' : 'chevron-down'} onClick={() => setOpen(expanded ? null : w.week)}>
                  Grid
                </Button>
              )}
            </div>
            {w.state === 'entering' && progress.units.length > 1 && (
              <span className="flex flex-wrap gap-x-3 gap-y-1 text-ink-2">
                {progress.units.map((u) => (
                  <span key={u.unit}>
                    {/^\d{4}-\d{2}-\d{2}$/.test(u.unit) ? short(u.unit) : 'week'}: {UNIT_LABEL[u.state]}
                  </span>
                ))}
              </span>
            )}
            {(w.state === 'failed' || w.state === 'aborted' || w.state === 'skipped') && w.detail.length > 0 && <Problems items={w.detail} />}
            {expanded && checked && <Grid week={checked} from={from} to={to} label={label} />}
          </li>
        );
      })}
    </ul>
  );
}
