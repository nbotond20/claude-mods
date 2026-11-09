import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Card, Icon, Skeleton } from '@loam/ui-web';
import { api, fmt, SYSTEM_LABEL, type SubmitPlan, type SubmitSystemPlan, type SystemId } from './api';

const SYSTEMS: SystemId[] = ['redmine', 'netsuite'];
import { AutoEnter } from './SubmitRun';

const OPEN_KEY = 'ts-submit-preview';

const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * Read-only preview of what would be entered into Redmine and NetSuite for a week, or why
 * nothing would be. `version` changes whenever the week's report does, which refetches.
 */
/** The submission plan for a week, refetched whenever `version` changes. */
function usePlan(week: string, version: string) {
  const [plan, setPlan] = useState<SubmitPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    api<SubmitPlan>(`/api/submit/plan?week=${encodeURIComponent(week)}`).then(
      (p) => {
        if (id !== seq.current) return;
        setPlan(p);
        setError(null);
      },
      (e) => id === seq.current && setError((e as Error).message),
    );
  }, [week, version]);
  return { current: plan?.week === week ? plan : null, error };
}

function PlanBadges({ plan }: { plan: SubmitPlan | null }) {
  return (
    <span className="flex flex-wrap gap-2">
      {plan?.systems.map((s) => (
        <Badge key={s.system} variant={s.ok ? (s.plan.cells.length ? 'good' : 'neutral') : 'warn'}>
          {SYSTEM_LABEL[s.system]}: {s.ok ? (s.plan.cells.length ? `${s.plan.cells.length} ${s.plan.cells.length === 1 ? 'entry' : 'entries'}` : 'nothing to enter') : 'blocked'}
        </Badge>
      ))}
    </span>
  );
}

function PlanBody({ current, error, run = false }: { current: SubmitPlan | null; error: string | null; run?: boolean }) {
  if (error && !current) return <p className="px-5 py-4 text-13 text-danger">Could not build the preview: {error}</p>;
  if (!current)
    return (
      <div className="flex flex-col gap-2 px-5 py-4">
        <Skeleton width="50%" />
        <Skeleton width="40%" />
      </div>
    );
  return <>{current.systems.map((s) => <SystemPreview key={s.system} result={s} week={current.week} run={run} />)}</>;
}

function Footer({ exportOverride }: { exportOverride: boolean }) {
  return (
    <>
      {exportOverride && (
        <p className="flex items-center gap-1.5 px-5 py-2.5 text-12 text-ink-2">
          <Icon name="info" size={14} className="text-ink-3" /> Uses the booked hours with the configured daily target; the export's target and real-hours options do not apply here.
        </p>
      )}
      <p className="px-5 py-2.5 text-12 text-ink-3">
        Addresses, fill-only and mappings: <a href="#settings/submission" className="text-accent-strong underline-offset-2 hover:underline">Settings → Submission</a>
      </p>
    </>
  );
}

function useOpen() {
  const [open, setOpen] = useState(readOpen);
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !o;
    });
  return [open, toggle] as const;
}

function Header({ open, toggle, description, badges }: { open: boolean; toggle: () => void; description: string; badges?: ReactNode }) {
  return (
    <h2>
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} className="text-ink-3" />
        <span className="mr-auto flex flex-col">
          <span className="text-14 font-semibold">Submission</span>
          <span className="text-12 font-normal text-ink-3">{description}</span>
        </span>
        {badges}
      </button>
    </h2>
  );
}

/**
 * Read-only preview of what would be entered into Redmine and NetSuite for a week, or why
 * nothing would be. `version` changes whenever the week's report does, which refetches.
 */
export function SubmitPreview({ week, version, exportOverride = false }: { week: string; version: string; exportOverride?: boolean }) {
  const [open, toggle] = useOpen();
  const { current, error } = usePlan(week, version);
  return (
    <Card className="flex flex-col p-0">
      <Header open={open} toggle={toggle} description="Enter this week into Redmine and NetSuite automatically. You see what will be entered and confirm first." badges={<PlanBadges plan={current} />} />
      {open && (
        <div className="flex flex-col divide-y divide-line border-t border-line">
          <PlanBody current={current} error={error} run />
          <Footer exportOverride={exportOverride} />
        </div>
      )}
    </Card>
  );
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const sundayOf = (week: string) => {
  const d = new Date(`${week}T12:00:00`);
  d.setDate(d.getDate() + 6);
  return iso(d);
};

/** Mondays of every week that has a day in [from, to]. */
export function weeksOf(from: string, to: string): string[] {
  const d = new Date(`${from}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const out: string[] = [];
  for (; iso(d) <= to; d.setDate(d.getDate() + 7)) out.push(iso(d));
  return out;
}

/**
 * Submission for a month: Redmine and NetSuite take whole weeks, so each week with a day in the
 * month gets its own preview and run (one run at a time, as in the week view).
 */
export function MonthSubmission({ from, to, version, exportOverride = false }: { from: string; to: string; version: string; exportOverride?: boolean }) {
  const [open, toggle] = useOpen();
  const month = new Date(`${from}T12:00:00`).toLocaleDateString(undefined, { month: 'long' });
  return (
    <Card className="flex flex-col p-0">
      <Header open={open} toggle={toggle} description={`Enter ${month} into Redmine and NetSuite automatically, week by week. You see what will be entered and confirm first.`} />
      {open && (
        <div className="flex flex-col divide-y divide-line border-t border-line">
          {SYSTEMS.map((system) => (
            <section key={system} className="flex flex-col gap-2 px-5 py-4" aria-label={SYSTEM_LABEL[system]}>
              <h3 className="text-13 font-semibold">{SYSTEM_LABEL[system]}</h3>
              <AutoEnter system={system} from={from} to={to} scope={month} />
            </section>
          ))}
          <Footer exportOverride={exportOverride} />
        </div>
      )}
    </Card>
  );
}

function SystemPreview({ result, week, run }: { result: SubmitSystemPlan; week: string; run: boolean }) {
  return (
    <section className="flex flex-col gap-2 px-5 py-4" aria-label={SYSTEM_LABEL[result.system]}>
      <h3 className="flex items-center gap-2 text-13 font-semibold">
        {SYSTEM_LABEL[result.system]}
        <span className="font-normal text-ink-3">{result.system === 'redmine' ? 'Worktime, per day' : 'Weekly timesheet'}</span>
        {result.fillOnly && <Badge size="sm">fill only</Badge>}
      </h3>
      {!result.ok ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-12 font-medium text-ink">
            <Icon name="alert-triangle" size={14} className="text-warn" /> Nothing would be entered for this week:
          </span>
          <ul className="list-disc pl-5 text-12 leading-5 text-ink-2">
            {result.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : result.plan.cells.length === 0 ? (
        <p className="text-12 text-ink-3">No booked hours to enter.</p>
      ) : (
        <p className="text-12 text-ink-2">
          {fmt(result.plan.cells.reduce((t, c) => t + c.hours, 0))} h booked across {new Set(result.plan.cells.map((c) => c.date)).size} days. Check the site to see what is already there and what will be entered.
        </p>
      )}
      {result.ok && result.plan.notes.length > 0 && (
        <ul className="flex flex-col gap-1 text-12 text-ink-2">
          {result.plan.notes.map((n) => (
            <li key={n} className="flex items-center gap-1.5">
              <Icon name="info" size={14} className="text-warn" /> {n}
            </li>
          ))}
        </ul>
      )}
      {run && <AutoEnter system={result.system} from={week} to={sundayOf(week)} scope="this week" />}
    </section>
  );
}
