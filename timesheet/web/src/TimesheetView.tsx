import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Card, EmptyState, Icon, Input, SegmentedControl, Select, Skeleton, Spinner, Switch, Tooltip, useToast } from '@loam/ui-web';
import { api, fmt, fmtMin, isOther, jobActive, OTHER_LABEL, type Block, type Job, type Meta, type OtherBlock, type RepoInfo, type Report, type ReportDay } from './api';
import { BlockDetails, repoOf, type BlockRef } from './BlockDetails';
import { hueColor } from './colors';
import { useJobs } from './jobs';
import { UnitInput } from './settings/fields';
import { useReport } from './useReport';
import { Delta } from './Delta';
import { SubmitPreview } from './SubmitPreview';
import { useShowOther, useShowRecorded } from './prefs';

type View = 'day' | 'week' | 'month';
type PasteFormat = keyof Report['paste'];

const FORMATS: { value: PasteFormat; label: string }[] = [
  { value: 'grid', label: 'Weekly grid' },
  { value: 'gridNoHeader', label: 'Weekly grid, rows only' },
  { value: 'lines', label: 'One line per entry' },
  { value: 'daily', label: 'Per day' },
];

const dateAs = (date: string, pattern: string) => {
  const [y, m, d] = date.split('-');
  return pattern.replace('YYYY', y).replace('MM', m).replace('DD', d);
};
const toDate = (d: string) => new Date(`${d}T12:00:00`);
const iso = (d: Date) => d.toLocaleDateString('sv-SE');

function shift(date: string, view: View, dir: number): string {
  const d = toDate(date);
  if (view === 'day') d.setDate(d.getDate() + dir);
  else if (view === 'week') d.setDate(d.getDate() + 7 * dir);
  else d.setMonth(d.getMonth() + dir, 1);
  return iso(d);
}

function rangeTitle(view: View, at: string, report: Report | null): string {
  const d = toDate(at);
  if (view === 'day') return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (view === 'month') return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  if (!report) return 'Week';
  const [f, t] = [toDate(report.from), toDate(report.to)];
  const sameMonth = f.getMonth() === t.getMonth();
  return `${f.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${t.toLocaleDateString(undefined, sameMonth ? { day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

const dayTitle = (d: string) => toDate(d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const time = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

type DayState = 'work' | 'attention' | 'empty' | 'computing' | 'waiting' | 'paused' | 'future';

const STATES: { key: DayState; label: string; cell: string }[] = [
  { key: 'work', label: 'with work', cell: 'bg-good' },
  { key: 'attention', label: 'need attention', cell: 'bg-warn' },
  { key: 'empty', label: 'no activity', cell: 'bg-line-strong' },
  { key: 'computing', label: 'computing', cell: 'bg-accent animate-pulse' },
  { key: 'waiting', label: 'waiting', cell: 'bg-accent/30' },
  { key: 'paused', label: 'paused', cell: 'bg-ink-3/40' },
  { key: 'future', label: 'upcoming', cell: 'bg-line' },
];

/** Changes whenever the report's booked hours or computation state change. */
const reportVersion = (r: Report) => JSON.stringify([r.pending, r.days.map((d) => [d.date, d.computedAt, d.status, d.entries.map((e) => [e.project, e.category, e.hours])])]);

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (const d = toDate(from); iso(d) <= to; d.setDate(d.getDate() + 1)) out.push(iso(d));
  return out;
}

/** Where each date of the range stands: computed (and how), being computed, or waiting in a job. */
function dayStates(report: Report, jobs: Job[], today: string): { date: string; state: DayState }[] {
  const byDate = new Map(report.days.map((d) => [d.date, d]));
  const pending = new Set(report.pending);
  if (report.from > today) return [];
  return datesBetween(report.from, report.to).map((date) => {
    if (date > today) return { date, state: 'future' };
    if (pending.has(date)) {
      const job = jobs.find((j) => j.remaining.includes(date) && j.status !== 'done' && j.status !== 'cancelled');
      if (job?.status === 'running' && job.current.includes(date)) return { date, state: 'computing' };
      return { date, state: !job || jobActive(job) ? 'waiting' : 'paused' };
    }
    const day = byDate.get(date);
    if (!day) return { date, state: 'waiting' };
    if (day.status === 'partial') return { date, state: 'attention' };
    return { date, state: day.entries.length ? 'work' : 'empty' };
  });
}

function stored<T extends string>(key: string, fallback: T, allowed: readonly string[]): T {
  try {
    const v = localStorage.getItem(key);
    return v && allowed.includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export function TimesheetView({ meta }: { meta: Meta }) {
  const { toast } = useToast();
  const [view, setView] = useState<View>(() => stored('ts-view', 'week', ['day', 'week', 'month']));
  const [format, setFormat] = useState<PasteFormat>(() => stored('ts-format', 'grid', FORMATS.map((f) => f.value)));
  const [at, setAt] = useState(meta.today);
  const [target, setTarget] = useState('');
  const [real, setReal] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const dateInput = useRef<HTMLInputElement>(null);

  const { report, loading, refreshing, error, reload } = useReport({ view, at, target, real });
  const [showOther, setShowOther] = useShowOther();
  const [showRecorded, setShowRecorded] = useShowRecorded();
  const { jobs } = useJobs();
  const [details, setDetails] = useState<BlockRef | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const openBlock = (ref: BlockRef) => {
    setDetails(ref);
    setDetailsOpen(true);
  };
  const states = useMemo(() => (report ? dayStates(report, jobs, meta.today) : []), [report, jobs, meta.today]);
  const detected = useMemo(() => {
    const t = { prompts: 0, commits: 0, github: 0, meetings: 0, known: 0 };
    for (const d of report?.days ?? []) {
      if (!d.activity) continue;
      t.known++;
      t.prompts += d.activity.prompts;
      t.commits += d.activity.commits;
      t.github += d.activity.github ?? 0;
      t.meetings += d.activity.meetings;
    }
    return t;
  }, [report]);

  const totals = useMemo(() => {
    const t = { booked: 0, real: 0, capex: 0, opex: 0, days: 0, target: 0, recorded: 0 as number | undefined };
    for (const d of report?.days ?? []) {
      if (d.blocks.length) t.recorded = t.recorded === undefined || d.measuredTotal === undefined ? undefined : t.recorded + d.measuredTotal;
      t.real += d.realTotal;
      if (d.entries.length) t.days++;
      if (d.entries.length && d.target) t.target += d.target;
      for (const e of d.entries) {
        t.booked += e.hours;
        if (e.capex) t.capex += e.hours;
        else t.opex += e.hours;
      }
    }
    return t;
  }, [report]);

  const override = async (date: string, project: string, category: string, hours: string | null) => {
    try {
      await api('/api/override', { body: { date, project, category, hours } });
      await reload();
    } catch (e) {
      toast({ title: 'Could not save hours', description: (e as Error).message, severity: 'error' });
    }
  };

  const recompute = async () => {
    setRecomputing(true);
    await reload({ refresh: true });
    setRecomputing(false);
    toast({ title: 'Recomputing in the background', description: 'You can keep working; pause it from the top bar.', severity: 'info' });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report?.paste[format] ?? '');
      toast({ title: 'Copied for NetSuite', description: report?.pending.length ? `${report.pending.length} day(s) were still being computed.` : undefined, severity: report?.pending.length ? 'warning' : 'success' });
    } catch {
      toast({ title: 'Clipboard not available', description: 'Select the text and copy it manually.', severity: 'error' });
    }
  };

  const pending = new Set(report?.pending ?? []);
  const missing = (report?.pending ?? []).filter((d) => !report?.days.some((x) => x.date === d));
  const days = [...(report?.days ?? []), ...missing.map((date) => ({ date, placeholder: true as const }))].sort((a, b) => b.date.localeCompare(a.date));
  const isToday = at === meta.today || (report ? report.from <= meta.today && meta.today <= report.to : false);

  return (
    <div className="flex flex-col gap-6">
      {/* Range navigation */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => setAt(meta.today)} aria-pressed={isToday}>Today</Button>
          <Button variant="ghost" size="sm" iconOnly leadingIcon="chevron-left" aria-label={`Previous ${view}`} onClick={() => setAt(shift(at, view, -1))} />
          <Button variant="ghost" size="sm" iconOnly leadingIcon="chevron-right" aria-label={`Next ${view}`} onClick={() => setAt(shift(at, view, 1))} />
        </div>
        <label className="relative flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 hover:bg-hover">
          <h1 className="truncate text-20 font-semibold tracking-tight">{rangeTitle(view, at, report)}</h1>
          <Icon name="chevron-down" size={16} className="shrink-0 text-ink-3" />
          <input
            ref={dateInput}
            type="date"
            className="absolute inset-0 cursor-pointer opacity-0"
            value={at}
            max={meta.today}
            aria-label="Pick a date"
            onClick={() => dateInput.current?.showPicker?.()}
            onChange={(e) => e.target.value && setAt(e.target.value)}
          />
        </label>
        {refreshing && !loading && <Spinner size="sm" label="Updating" />}
        <div className="flex w-full items-center justify-between gap-2 tablet:ml-auto tablet:w-auto">
          <Tooltip content="Recompute every day in this range (runs classification again)">
            <Button variant="ghost" size="sm" leadingIcon="refresh" loading={recomputing} onClick={recompute}>Recompute</Button>
          </Tooltip>
          <SegmentedControl
            size="sm"
            className="h-ctl-sm"
            aria-label="Range"
            items={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]}
            value={view}
            onValueChange={(v) => {
              if (!v) return;
              setView(v as View);
              remember('ts-view', v);
            }}
          />
        </div>
      </div>

      {error && !report ? (
        <EmptyState variant="error" title="Could not load the timesheet" description={error} action={<Button size="sm" variant="primary" leadingIcon="refresh" onClick={() => reload()}>Try again</Button>} />
      ) : (
        <>
          {error && <Alert tone="danger" title="Could not refresh" description={error} action={<Button size="sm" variant="outline" onClick={() => reload()}>Retry</Button>} />}

          {/* Totals */}
          <Card className="flex flex-col p-0">
            <div className={`grid grid-cols-2 divide-line tablet:divide-x ${showRecorded ? 'tablet:grid-cols-5' : 'tablet:grid-cols-4'}`}>
            <Stat label="Booked" value={totals.booked} unit="h" caption={totals.target ? `of ${fmt(totals.target)} h target` : 'no target'} loading={loading} />
            <Stat
              label="Real activity"
              value={totals.real}
              unit="h"
              caption={
                <span className="flex items-center gap-2">
                  {totals.days} day{totals.days === 1 ? '' : 's'} with work <Delta real={totals.real} target={totals.target || null} />
                </span>
              }
              loading={loading}
            />
            {showRecorded && (
              <Stat
                label="Recorded"
                value={0}
                text={fmtMin(totals.recorded).replace(/ min$/, '')}
                unit={totals.recorded === undefined ? '' : 'min'}
                caption={totals.recorded === undefined ? 'some days need recomputing' : 'timestamps only, nothing assumed'}
                loading={loading}
              />
            )}
            <Stat label="CAPEX" value={totals.capex} unit="h" caption={totals.booked ? `${Math.round((totals.capex / totals.booked) * 100)}% of booked` : '—'} loading={loading} />
            <Stat label="OPEX" value={totals.opex} unit="h" caption={totals.booked ? `${Math.round((totals.opex / totals.booked) * 100)}% of booked` : '—'} loading={loading} />
            </div>
            <Coverage states={states} detected={detected} loading={loading} />
          </Card>

          {/* NetSuite export */}
          <Card className="flex flex-col p-0">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
              <div className="mr-auto">
                <h2 className="text-14 font-semibold">NetSuite export</h2>
                <p className="text-12 text-ink-3">Hours per category, ready to paste.</p>
              </div>
              <div className="flex w-full items-center gap-2 tablet:w-auto">
                <Select
                  size="sm"
                  className="min-w-0 flex-1 tablet:w-52 tablet:flex-none"
                  aria-label="Paste format"
                  items={FORMATS}
                  value={format}
                  onValueChange={(v) => {
                    setFormat(v as PasteFormat);
                    remember('ts-format', v);
                  }}
                />
                <Button variant="primary" size="sm" leadingIcon="copy" onClick={copy} disabled={loading || !report?.paste[format]}>Copy</Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface-2/50 px-5 py-2.5 text-13 text-ink-2">
              <label className={`flex items-center gap-2 ${real ? 'opacity-50' : ''}`}>
                Daily target
                <UnitInput size="xs" className="w-20" unit="h" min={0} step={0.25} placeholder={String(meta.target)} value={target} disabled={real} onChange={setTarget} aria-label="Daily target" />
              </label>
              <label className="flex items-center gap-2">
                <Switch size="sm" checked={real} onCheckedChange={setReal} aria-label="Book real hours" />
                Book real hours instead
              </label>
              {pending.size > 0 && (
                <span className="ml-auto flex items-center gap-1.5 text-12 text-ink-3">
                  <Icon name="clock" size={14} /> Includes {plural(pending.size, 'day')} not computed yet
                </span>
              )}
            </div>
            {loading ? (
              <div className="flex flex-col gap-2 p-5">
                <Skeleton width="70%" />
                <Skeleton width="55%" />
                <Skeleton width="60%" />
              </div>
            ) : report?.paste[format] ? (
              format === 'daily' ? (
                <pre style={{ tabSize: 16 }} className="max-h-96 overflow-auto px-5 py-4 font-mono text-12 leading-6 text-ink">{report.paste.daily}</pre>
              ) : (
                <ExportTables text={format === 'lines' ? report.paste.lines : report.paste.grid} totals={format !== 'lines'} showTarget={!real} days={report.days} dateFormat={meta.dateFormat} />
              )
            ) : (
              <p className="px-5 py-6 text-13 text-ink-3">{pending.size ? 'Waiting for the first days to be computed…' : 'Nothing to book in this range.'}</p>
            )}
          </Card>

          {view === 'week' && report && <SubmitPreview week={report.from} version={reportVersion(report)} exportOverride={real || target !== ''} />}

          {/* Days */}
          <section className="flex flex-col gap-3">
            <h2 className="flex items-baseline gap-2 text-14 font-semibold">
              Days
              {!loading && report && <span className="text-13 font-normal text-ink-3">{plural(report.days.filter((d) => d.entries.length).length, 'day')} with booked time</span>}
              <label className="ml-auto flex items-center gap-2 text-13 font-normal text-ink-2">
                <Switch size="sm" checked={showRecorded} onCheckedChange={setShowRecorded} aria-label="Show recorded minutes" />
                Recorded minutes
              </label>
              <label className="flex items-center gap-2 text-13 font-normal text-ink-2">
                <Switch size="sm" checked={showOther} onCheckedChange={setShowOther} aria-label="Show personal and unassigned activity" />
                Show other activity
              </label>
            </h2>
            {loading ? (
              <>
                <DaySkeleton />
                <DaySkeleton />
              </>
            ) : days.length === 0 ? (
              <p className="text-13 text-ink-3">This range is in the future.</p>
            ) : (
              days.map((d) =>
                'placeholder' in d ? <DaySkeleton key={d.date} date={d.date} /> : <DayCard key={d.date} day={d} meta={meta} repos={report?.repos ?? {}} pending={pending.has(d.date)} showOther={showOther} showRecorded={showRecorded} onOverride={override} onOpenBlock={openBlock} />,
              )
            )}
          </section>
        </>
      )}
      <BlockDetails open={detailsOpen} onClose={() => setDetailsOpen(false)} value={details} repos={report?.repos ?? {}} meta={meta} />
    </div>
  );
}

/**
 * The paste text shown as real tables. It is parsed from the exact text that is copied
 * (tab-separated, blank line between weeks), so what you see is what you paste.
 */
function ExportTables({ text, totals, showTarget, days, dateFormat }: { text: string; totals: boolean; showTarget: boolean; days: ReportDay[]; dateFormat: string }) {
  // Weekday columns are headed "Mon <date in the export's format>"; map them back to the day.
  const byHeader = new Map(days.map((d) => [dateAs(d.date, dateFormat), d]));
  const tables = text
    .split(/\n\s*\n/)
    .map((t) => t.split('\n').filter(Boolean).map((l) => l.split('\t')))
    .filter((t) => t.length > 1);
  const value = (c: string) => Number(c.replace(',', '.')) || 0;
  const isNum = (c: string) => c !== '' && !Number.isNaN(Number(c.replace(',', '.')));
  const show = (n: number, sample: string) => {
    const s = fmt(n);
    return sample.includes(',') ? s.replace('.', ',') : s;
  };
  return (
    <div className="flex max-h-[32rem] flex-col gap-4 overflow-auto p-5">
      {tables.map(([head, ...rows], t) => {
        // A day with nothing booked is still a number column.
        const numeric = head.map((_, i) => i >= 2 && rows.every((r) => !r[i] || isNum(r[i])));
        const sums = head.map((_, i) => (numeric[i] ? rows.reduce((n, r) => n + value(r[i] ?? ''), 0) : null));
        const sample = rows.flat().find((c) => c.includes(',')) ?? '.';
        return (
          <table key={t} className="w-full min-w-[44rem] whitespace-nowrap border-separate border-spacing-0 overflow-hidden rounded-md border border-line text-13">
            <thead>
              <tr>
                {head.map((h, i) => {
                  const [dow, date] = /^(\w{3}) (\S+)$/.exec(h)?.slice(1) ?? [null, null];
                  return (
                    <th key={i} scope="col" className={`border-b border-line bg-surface-2 px-3 py-2 text-12 font-medium text-ink-3 ${numeric[i] ? 'text-right' : 'text-left'}`}>
                      {dow ? (
                        <span className="flex flex-col leading-4">
                          <span className="text-ink-2">{dow}</span>
                          <span className="font-mono text-11 font-normal">{date}</span>
                        </span>
                      ) : (
                        h
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j} className="hover:bg-hover">
                  {head.map((_, i) => (
                    <td key={i} className={`border-b border-line px-3 py-2 ${numeric[i] ? 'text-right tabular-nums' : ''} ${i === head.length - 1 && totals ? 'font-semibold' : ''} ${r[i] ? '' : 'text-ink-3'}`}>
                      {r[i] || (numeric[i] ? '–' : '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="bg-surface-2/60 font-semibold">
                  <td className="px-3 py-2" colSpan={2}>
                    Total
                  </td>
                  {sums.slice(2).map((n, i) => (
                    <td key={i} className="px-3 py-2 text-right tabular-nums">
                      {n ? show(n, sample) : <span className="font-normal text-ink-3">–</span>}
                    </td>
                  ))}
                </tr>
                {showTarget && <TargetRow cols={head.slice(2).map((h) => byHeader.get(h.replace(/^\w{3} /, '')))} />}
              </tfoot>
            )}
          </table>
        );
      })}
    </div>
  );
}

/** Under the totals: each day's real hours against its target, the week's in the Total column. */
function TargetRow({ cols }: { cols: (ReportDay | undefined)[] }) {
  const counts = (d?: ReportDay): d is ReportDay => !!d?.target && d.entries.length > 0;
  const counted = cols.filter(counts);
  if (!counted.length) return null;
  const last = cols.length - 1;
  return (
    <tr className="bg-surface-2/60">
      <td className="border-t border-line px-3 py-1.5 text-12 text-ink-3" colSpan={2}>
        Real vs target
      </td>
      {cols.map((d, i) => (
        <td key={i} className="border-t border-line px-3 py-1.5 text-right">
          {counts(d) ? (
            <Delta real={d.realTotal} target={d.target} />
          ) : i === last ? (
            <Delta real={counted.reduce((n, x) => n + x.realTotal, 0)} target={counted.reduce((n, x) => n + x.target!, 0)} />
          ) : null}
        </td>
      ))}
    </tr>
  );
}

function Coverage({ states, detected, loading }: { states: { date: string; state: DayState }[]; detected: { prompts: number; commits: number; github: number; meetings: number; known: number }; loading: boolean }) {
  const count = (k: DayState) => states.filter((s) => s.state === k).length;
  const jump = (date: string) => document.getElementById(`day-${date}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
      {loading ? (
        <Skeleton height={8} />
      ) : states.length === 0 ? (
        <p className="text-12 text-ink-3">This range is in the future.</p>
      ) : (
        <div className="flex h-2 gap-0.5" role="img" aria-label={STATES.filter((s) => count(s.key)).map((s) => `${count(s.key)} ${s.label}`).join(', ')}>
          {states.map(({ date, state }) => (
            <Tooltip key={date} content={`${dayTitle(date)} · ${STATES.find((s) => s.key === state)!.label}`}>
              <button type="button" aria-label={dayTitle(date)} disabled={state === 'future'} onClick={() => jump(date)} className={`h-full min-w-0 flex-1 rounded-sm transition-colors first:rounded-l-full last:rounded-r-full hover:opacity-80 ${STATES.find((s) => s.key === state)!.cell}`} />
            </Tooltip>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-12 text-ink-2">
        {loading ? (
          <Skeleton width={260} height={12} />
        ) : (
          STATES.filter((s) => s.key !== 'future' && count(s.key) > 0).map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${s.cell}`} />
              <span className="font-medium tabular-nums text-ink">{count(s.key)}</span> {s.label}
            </span>
          ))
        )}
        {!loading && detected.known > 0 && (
          <span className="flex items-center gap-1.5 text-ink-3 tablet:ml-auto">
            Detected
            <span className="tabular-nums text-ink-2">
              {[plural(detected.prompts, 'prompt'), plural(detected.commits, 'commit'), ...(detected.github ? [plural(detected.github, 'GitHub action')] : []), plural(detected.meetings, 'meeting')].join(' · ')}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, text, unit, caption, loading }: { label: string; value: number; text?: string; unit: string; caption: ReactNode; loading: boolean }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4 [&:nth-child(n+3)]:border-t [&:nth-child(n+3)]:border-line tablet:[&:nth-child(n+3)]:border-t-0">
      <span className="text-12 font-medium text-ink-3">{label}</span>
      {loading ? (
        <Skeleton height={28} width={72} className="my-0.5" />
      ) : (
        <span className="text-24 font-semibold tabular-nums leading-8">
          {text ?? fmt(value)}
          <span className="ml-0.5 text-14 font-medium text-ink-3">{unit}</span>
        </span>
      )}
      <span className="text-12 text-ink-3">{loading ? ' ' : caption}</span>
    </div>
  );
}

function DaySkeleton({ date }: { date?: string }) {
  return (
    <Card id={date ? `day-${date}` : undefined} className="flex scroll-mt-24 flex-col gap-3 p-5" aria-busy>
      <div className="flex items-center gap-3">
        {date ? <h3 className="text-14 font-semibold">{dayTitle(date)}</h3> : <Skeleton width={160} />}
        {date && (
          <span className="flex items-center gap-1.5 text-12 text-ink-3">
            <Spinner size="sm" /> Computing
          </span>
        )}
      </div>
      <Skeleton width="100%" height={12} />
      <Skeleton width="85%" height={12} />
    </Card>
  );
}

function StatusLabel({ day, pending }: { day: ReportDay; pending: boolean }) {
  if (pending)
    return (
      <span className="flex items-center gap-1.5 text-12 text-ink-3">
        <Spinner size="sm" /> Updating
      </span>
    );
  if (day.status === 'today') return <span className="text-12 font-medium text-info">Today · in progress</span>;
  if (day.status === 'partial')
    return (
      <Tooltip content="Something needs attention (see below); the day is recomputed once it is resolved.">
        <span className="flex items-center gap-1 text-12 font-medium text-warn">
          <Icon name="alert-triangle" size={14} /> Needs attention
        </span>
      </Tooltip>
    );
  return null;
}

function GroupHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <h4 className="flex items-baseline gap-2 border-b border-line bg-surface-2/50 px-5 py-1.5 text-12 font-semibold uppercase tracking-wide text-ink-3">
      {title}
      <span className="font-normal normal-case tracking-normal">{detail}</span>
    </h4>
  );
}

/** One time block as a row: its title, categories and where it happened. Opens the details. */
function BlockRow({ block: b, repos, hues, showRecorded, onOpen }: { block: Block | OtherBlock; repos: Record<string, RepoInfo>; hues: Map<string, number | null>; showRecorded: boolean; onOpen: () => void }) {
  const names = [...new Set([...b.paths, ...(b.commits ?? []).map((c) => c.repo)].map((p) => repoOf(repos, p).name))];
  const parallel = (b.items?.length ?? 0) > 1;
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" onClick={onOpen} className="group grid w-full grid-cols-[7rem_1fr_auto] items-start gap-4 px-5 py-3 text-left text-13 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none">
        <span className="flex flex-col">
          <span className="font-mono text-12 tabular-nums">
            {time(b.start)}–{time(b.end)}
          </span>
          <span className="text-12 text-ink-3">{b.kind === 'meeting' ? 'Meeting' : b.sources.join(' + ')}</span>
          {showRecorded && <span className="text-12 tabular-nums text-ink-2">{fmtMin(b.measured)}</span>}
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="font-medium">{b.summary || (b.kind === 'meeting' ? b.texts[0] : null) || 'Work'}</span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-12 text-ink-3">
            {isOther(b) ? (
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full border border-dashed border-ink-3" />
                {OTHER_LABEL[b.kind]}
              </span>
            ) : (
              b.allocations.map((a) => {
                const h = hues.get(a.category);
                return (
                  <span key={a.category} className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-line-strong" style={h == null ? undefined : { background: hueColor(h) }} />
                    {a.category}
                    {a.fraction < 1 ? ` ${Math.round(a.fraction * 100)}%` : ''}
                  </span>
                );
              })
            )}
            {names.length > 0 && <span>{names.slice(0, 3).join(', ')}{names.length > 3 ? ` +${names.length - 3}` : ''}</span>}
            {parallel && <span>{b.items!.length} parallel sessions</span>}
          </span>
        </span>
        <Icon name="chevron-right" size={16} className="mt-0.5 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
    </li>
  );
}

function DayCard({ day, meta, repos, pending, showOther, showRecorded, onOverride, onOpenBlock }: { day: ReportDay; meta: Meta; repos: Record<string, RepoInfo>; pending: boolean; showOther: boolean; showRecorded: boolean; onOpenBlock: (ref: BlockRef) => void; onOverride: (date: string, project: string, category: string, hours: string | null) => void }) {
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const other = showOther ? day.other ?? [] : [];
  const otherHours = other.reduce((n, b) => n + b.end - b.start, 0) / 3_600_000;
  const empty = !day.blocks.length && !day.entries.length && !other.length;
  const summary = day.summary.split('\n').map((l) => l.replace(/^\s*[-•]\s*/, '').trim()).filter(Boolean);
  const SUMMARY_LIMIT = 3;
  const hues = useMemo(() => new Map(meta.categories.map((c) => [c.name, c.hue])), [meta]);
  const cols = showRecorded ? 'grid-cols-[1fr_6.5rem_4.5rem_5.5rem_2rem]' : 'grid-cols-[1fr_4.5rem_5.5rem_2rem]';

  if (empty && !day.warnings.length) {
    return (
      <div id={`day-${day.date}`} className="flex scroll-mt-24 items-center gap-3 rounded-lg border border-dashed border-line px-5 py-3 text-13">
        <span className="font-medium text-ink-2">{dayTitle(day.date)}</span>
        <span className="text-ink-3">No work activity</span>
        <span className="ml-auto">
          <StatusLabel day={day} pending={pending} />
        </span>
      </div>
    );
  }

  return (
    <Card id={`day-${day.date}`} className={`flex scroll-mt-24 flex-col p-0 transition-opacity ${pending ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-4">
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-3">
            <h3 className="text-14 font-semibold">{dayTitle(day.date)}</h3>
            <StatusLabel day={day} pending={pending} />
          </span>
          {day.activity && (
            <span className="text-12 text-ink-3">
              {[
                day.activity.prompts && plural(day.activity.prompts, 'prompt'),
                day.activity.commits && plural(day.activity.commits, 'commit'),
                day.activity.github && plural(day.activity.github, 'GitHub action'),
                day.activity.meetings && plural(day.activity.meetings, 'meeting'),
                day.activity.repos && plural(day.activity.repos, 'repo'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-baseline gap-4 text-13 tabular-nums">
          {showRecorded && day.blocks.length > 0 && (
            <span className="text-ink-3">
              recorded <span className="font-medium text-ink-2">{fmtMin(day.measuredTotal)}</span>
            </span>
          )}
          <span className="text-ink-3">
            real <span className="font-medium text-ink-2">{fmt(day.realTotal)} h</span> {day.entries.length > 0 && <Delta real={day.realTotal} target={day.target} />}
          </span>
          <span className="text-ink-3">
            booked <span className="font-semibold text-ink">{fmt(day.total)} h</span>
            {day.target === null ? '' : <span className="text-ink-3"> / {fmt(day.target)}</span>}
          </span>
        </div>
      </div>

      {day.warnings.length > 0 && (
        <div className="px-5 pt-3">
          <div role="note" className="flex gap-2.5 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-13 text-warn-on-soft">
            <Icon name="alert-triangle" size={16} className="mt-0.5 shrink-0" />
            <ul className="flex min-w-0 flex-1 flex-col gap-0.5">
              {day.warnings.map((w) => (
                <li key={w} className="break-words">{w.replace(/; run `timesheet scope`$/, '').replace(/`([^`]+)`/g, '$1')}</li>
              ))}
            </ul>
            {day.warnings.some((w) => w.includes('unclassified path')) && (
              <a href="#settings/scope" className="shrink-0 self-start font-medium underline underline-offset-2 hover:no-underline">
                Decide in settings
              </a>
            )}
          </div>
        </div>
      )}

      {day.entries.length > 0 && (
        <div className="px-5 pt-3">
          <div className={`grid items-center gap-x-3 border-b border-line pb-1.5 text-12 font-medium text-ink-3 ${cols}`}>
            <span>Task category</span>
            {showRecorded && <span className="text-right">Recorded</span>}
            <span className="text-right">Real</span>
            <span className="text-right">Booked</span>
            <span />
          </div>
          {day.entries.map((e) => (
            <div key={`${e.project}|${e.category}`} className={`grid min-h-11 items-center gap-x-3 border-b border-line text-13 last:border-b-0 ${cols}`}>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{e.category}</span>
                <span className="shrink-0 text-12 text-ink-3">
                  {e.capex ? 'CAPEX' : 'OPEX'}
                  {meta.projects.length > 1 ? ` · ${e.project}` : ''}
                </span>
              </span>
              {showRecorded && <span className="text-right tabular-nums text-ink-2">{fmtMin(e.measured)}</span>}
              <span className="text-right tabular-nums text-ink-2">{fmt(e.real)}</span>
              <Input
                type="number"
                size="xs"
                min={0}
                step={meta.rounding}
                defaultValue={e.hours}
                key={`${e.hours}-${e.overridden}`}
                className={`text-right tabular-nums ${e.overridden ? 'font-semibold text-accent-strong' : ''}`}
                aria-label={`Booked hours for ${e.category}`}
                onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()}
                onBlur={(ev) => ev.target.value !== String(e.hours) && onOverride(day.date, e.project, e.category, ev.target.value)}
              />
              <span className="flex justify-end">
                {e.overridden && (
                  <Tooltip content="Reset to computed hours">
                    <Button variant="ghost" size="xs" iconOnly leadingIcon="undo" aria-label={`Reset ${e.category}`} onClick={() => onOverride(day.date, e.project, e.category, null)} />
                  </Tooltip>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {summary.length > 0 && (
        <div className="px-5 pt-3">
          <ul className="flex flex-col gap-1 text-13 text-ink-2">
            {(summaryOpen ? summary : summary.slice(0, SUMMARY_LIMIT)).map((line, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />
                <span className={summaryOpen ? '' : 'line-clamp-2'}>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-2 flex items-center gap-1 border-t border-line px-3 py-1.5">
        {summary.length > SUMMARY_LIMIT || summary.some((l) => l.length > 160) ? (
          <Button variant="ghost" size="xs" onClick={() => setSummaryOpen(!summaryOpen)}>
            {summaryOpen ? 'Shorter summary' : 'Full summary'}
          </Button>
        ) : null}
        {day.blocks.length + other.length > 0 && (
          <Button variant="ghost" size="xs" trailingIcon={blocksOpen ? 'chevron-up' : 'chevron-down'} onClick={() => setBlocksOpen(!blocksOpen)}>
            {[day.blocks.length && plural(day.blocks.length, 'time block'), other.length && `${fmt(otherHours)} h other`].filter(Boolean).join(' · ')}
          </Button>
        )}
      </div>

      {blocksOpen && (
        <div className="flex flex-col border-t border-line">
          {day.blocks.length > 0 && other.length > 0 && <GroupHeading title="Work" detail={`${fmt(day.realTotal)} h real${showRecorded ? ` · ${fmtMin(day.measuredTotal)} recorded` : ''}`} />}
          {day.blocks.length > 0 && (
            <ul className="flex flex-col">
              {day.blocks.map((b) => (
                <BlockRow key={b.id} block={b} repos={repos} hues={hues} showRecorded={showRecorded} onOpen={() => onOpenBlock({ date: day.date, block: b })} />
              ))}
            </ul>
          )}
          {other.length > 0 && (
            <>
              <GroupHeading title="Other" detail={`${fmt(otherHours)} h · personal and unassigned, not booked`} />
              <ul className="flex flex-col">
                {other.map((b) => (
                  <BlockRow key={`o${b.id}`} block={b} repos={repos} hues={hues} showRecorded={showRecorded} onOpen={() => onOpenBlock({ date: day.date, block: b })} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
