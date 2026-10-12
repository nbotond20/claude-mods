import { useEffect, useRef, useState } from 'react';
import { Badge, Card, Icon, Skeleton } from '@loam/ui-web';
import { api, fmt, SYSTEM_LABEL, type SubmitPlan, type SubmitSystemPlan } from './api';
import { SubmitRun } from './SubmitRun';

const OPEN_KEY = 'ts-submit-preview';

const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
};

const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * Read-only preview of what would be entered into Redmine and NetSuite for a week, or why
 * nothing would be. `version` changes whenever the week's report does, which refetches.
 */
export function SubmitPreview({ week, version, exportOverride = false }: { week: string; version: string; exportOverride?: boolean }) {
  const [open, setOpen] = useState(readOpen);
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

  const current = plan?.week === week ? plan : null;

  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !o;
    });
  };

  return (
    <Card className="flex flex-col p-0">
      <h2>
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} className="text-ink-3" />
        <span className="mr-auto flex flex-col">
          <span className="text-14 font-semibold">Submission</span>
          <span className="text-12 font-normal text-ink-3">What would be entered into Redmine and NetSuite for this week. Nothing is written until you prepare, review and confirm.</span>
        </span>
        <span className="flex flex-wrap gap-2">
          {current?.systems.map((s) => (
            <Badge key={s.system} variant={s.ok ? (s.plan.cells.length ? 'good' : 'neutral') : 'warn'}>
              {SYSTEM_LABEL[s.system]}: {s.ok ? (s.plan.cells.length ? `${s.plan.cells.length} ${s.plan.cells.length === 1 ? 'entry' : 'entries'}` : 'nothing to enter') : 'blocked'}
            </Badge>
          ))}
        </span>
      </button>
      </h2>
      {open && (
        <div className="flex flex-col divide-y divide-line border-t border-line">
          {error && !current ? (
            <p className="px-5 py-4 text-13 text-danger">Could not build the preview: {error}</p>
          ) : !current ? (
            <div className="flex flex-col gap-2 px-5 py-4">
              <Skeleton width="50%" />
              <Skeleton width="40%" />
            </div>
          ) : (
            current.systems.map((s) => <SystemPreview key={s.system} result={s} week={current.week} />)
          )}
          {exportOverride && (
            <p className="flex items-center gap-1.5 px-5 py-2.5 text-12 text-ink-2">
              <Icon name="info" size={14} className="text-ink-3" /> Uses the booked hours with the configured daily target; the export's target and real-hours options do not apply here.
            </p>
          )}
          <p className="px-5 py-2.5 text-12 text-ink-3">
            Addresses, fill-only and mappings: <a href="#settings/submission" className="text-accent-strong underline-offset-2 hover:underline">Settings → Submission</a>
          </p>
        </div>
      )}
    </Card>
  );
}

function SystemPreview({ result, week }: { result: SubmitSystemPlan; week: string }) {
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
        <div className="overflow-x-auto">
          <table className="w-full text-12">
            <thead>
              <tr className="text-left text-ink-3">
                <th className="py-1 pr-4 font-medium">Date</th>
                <th className="py-1 pr-4 font-medium">{result.system === 'redmine' ? 'Issue · activity' : 'Project · task'}</th>
                <th className="py-1 text-right font-medium">Hours</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {result.plan.cells.map((c) => (
                <tr key={`${c.date} ${c.label}`}>
                  <td className="whitespace-nowrap py-1 pr-4 tabular-nums text-ink-2">{dayLabel(c.date)}</td>
                  <td className="py-1 pr-4 text-ink">{c.label}</td>
                  <td className="py-1 text-right tabular-nums text-ink">{fmt(c.hours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <SubmitRun system={result.system} week={week} enabled={result.system === 'redmine'} />
    </section>
  );
}
