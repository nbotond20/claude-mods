import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Icon, Popover, PopoverContent, PopoverTrigger, Progress, Spinner, Tooltip } from '@loam/ui-web';
import { api, jobActive, type Job } from './api';

interface JobsState {
  jobs: Job[];
  /** Changes whenever a job finishes a day or changes status, so views know to refetch. */
  version: number;
  /** Starts fast polling right away (after a report queued new work). */
  poke: () => void;
  act: (action: 'pause' | 'resume' | 'cancel', id: string) => Promise<void>;
}

const JobsContext = createContext<JobsState>({ jobs: [], version: 0, poke: () => {}, act: async () => {} });

export const useJobs = () => useContext(JobsContext);

/** Follows background computation: every second while something runs, every few seconds otherwise. */
export function JobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [version, setVersion] = useState(0);
  const signature = useRef('');
  const timer = useRef<number | undefined>(undefined);

  const poll = useCallback(async () => {
    window.clearTimeout(timer.current);
    let next: Job[] = [];
    try {
      next = (await api<{ jobs: Job[] }>('/api/jobs')).jobs;
    } catch {
      /* server restarting; try again */
    }
    const sig = next.map((j) => `${j.id}:${j.status}:${j.done.length}`).join('|');
    if (sig !== signature.current) {
      signature.current = sig;
      setJobs(next);
      setVersion((v) => v + 1);
    }
    const busy = next.some((j) => j.status === 'running' || j.status === 'queued');
    timer.current = window.setTimeout(poll, busy ? 1000 : 5000);
  }, []);

  useEffect(() => {
    poll();
    return () => window.clearTimeout(timer.current);
  }, [poll]);

  const act = useCallback(
    async (action: 'pause' | 'resume' | 'cancel', id: string) => {
      await api(`/api/jobs/${action}`, { body: { id } });
      await poll();
    },
    [poll],
  );

  return <JobsContext.Provider value={{ jobs, version, poke: poll, act }}>{children}</JobsContext.Provider>;
}

const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How a job's dates split up right now. */
export function jobCounts(j: Job) {
  const computing = j.status === 'running' ? j.current.length : 0;
  return { total: j.dates.length, done: j.done.length, computing, waiting: j.remaining.length - computing };
}

const STATUS_LABEL: Record<Job['status'], string> = {
  queued: 'Waiting',
  running: 'Computing',
  paused: 'Paused',
  interrupted: 'Resuming',
  done: 'Done',
  failed: 'Stopped',
  cancelled: 'Discarded',
};

/** Compact status of background computation for the app header; opens a breakdown per job. */
export function JobIndicator() {
  const { jobs, act } = useJobs();
  const [busy, setBusy] = useState<string | null>(null);
  const open = jobs.filter((j) => j.remaining.length && j.status !== 'done' && j.status !== 'cancelled');
  if (!open.length) return null;

  const counts = open.map(jobCounts);
  const total = counts.reduce((n, c) => n + c.total, 0);
  const done = counts.reduce((n, c) => n + c.done, 0);
  const computing = counts.reduce((n, c) => n + c.computing, 0);
  const running = open.find((j) => j.status === 'running');
  const paused = open.filter((j) => j.status === 'paused');
  const failed = open.find((j) => j.status === 'failed');
  const control = (action: 'pause' | 'resume' | 'cancel', ids: string[], key: string = action) => async () => {
    setBusy(key);
    try {
      for (const id of ids) await act(action, id);
    } finally {
      setBusy(null);
    }
  };

  let label: string;
  let shortLabel: string;
  let button: ReactNode = null;
  const tone = failed && !running ? 'danger' : paused.length && !running && !open.some(jobActive) ? 'warn' : 'accent';
  if (failed && !running) {
    label = 'Computation stopped';
    shortLabel = 'Stopped';
    button = <Button size="sm" variant="outline" leadingIcon="refresh" loading={busy === 'resume'} onClick={control('resume', [failed.id])}>Retry</Button>;
  } else if (running || open.some(jobActive)) {
    shortLabel = running ? 'Computing' : 'Waiting';
    label = running?.elsewhere ? 'Computing in another window' : computing ? `Computing ${plural(computing, 'day')}` : running ? 'Reading activity…' : 'Waiting to compute';
    const ids = open.filter((j) => jobActive(j) && !j.elsewhere).map((j) => j.id);
    if (ids.length) button = <Button size="sm" variant="ghost" leadingIcon="pause" loading={busy === 'pause'} onClick={control('pause', ids)}>Pause</Button>;
  } else {
    label = 'Paused';
    shortLabel = 'Paused';
    button = <Button size="sm" variant="outline" leadingIcon="play" loading={busy === 'resume'} onClick={control('resume', paused.map((j) => j.id))}>Resume</Button>;
  }

  return (
    <div className="flex min-w-0 items-center gap-2" role="status" aria-live="polite">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`${label}, ${done} of ${total} days done. Show details`}>
            {running && !failed && <Spinner size="sm" />}
            {tone === 'danger' && <Icon name="alert-triangle" size={16} className="text-danger" />}
            <span className="flex w-32 min-w-0 flex-col gap-1.5 tablet:w-44">
              <span className="flex items-baseline justify-between gap-2 text-12 leading-4">
                <span className={`truncate ${tone === 'danger' ? 'text-danger' : 'text-ink-2'}`}>
                  <span className="tablet:hidden">{shortLabel}</span>
                  <span className="hidden tablet:inline">{label}</span>
                </span>
                <span className="shrink-0 tabular-nums text-ink-3">
                  {done}/{total}
                </span>
              </span>
              <Progress size="sm" value={total ? (done / total) * 100 : 0} tone={tone} aria-label="Progress" />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-2rem)] p-0">
          <div className="border-b border-line px-4 py-3">
            <p className="text-13 font-semibold">Background computation</p>
            <p className="text-12 text-ink-3">Finished days are saved one by one, so pausing or closing loses nothing.</p>
          </div>
          <ul className="flex max-h-[60vh] flex-col divide-y divide-line overflow-auto">
            {open.map((j, i) => {
              const c = counts[i];
              const pct = c.total ? (c.done / c.total) * 100 : 0;
              return (
                <li key={j.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-13 font-medium">
                      {j.from === j.to ? short(j.from) : `${short(j.from)} – ${short(j.to)}`}
                      {j.refresh && <span className="font-normal text-ink-3"> · recompute</span>}
                    </span>
                    <span className={`ml-auto text-12 ${j.status === 'failed' ? 'text-danger' : j.status === 'paused' ? 'text-warn' : 'text-ink-3'}`}>{j.elsewhere ? 'In another window' : STATUS_LABEL[j.status]}</span>
                  </div>
                  <Progress size="sm" value={pct} tone={j.status === 'failed' ? 'danger' : j.status === 'paused' ? 'warn' : 'accent'} aria-label={`${c.done} of ${c.total} days done`} />
                  <p className="flex flex-wrap gap-x-3 text-12 text-ink-3">
                    <span><span className="font-medium tabular-nums text-ink">{c.done}</span> of {c.total} done</span>
                    {c.computing > 0 && <span><span className="font-medium tabular-nums text-ink">{c.computing}</span> computing</span>}
                    {c.waiting > 0 && <span><span className="font-medium tabular-nums text-ink">{c.waiting}</span> waiting</span>}
                  </p>
                  {j.status === 'running' && j.current.length > 0 && <p className="text-12 text-ink-3">Now: {j.current.map(short).join(', ')}</p>}
                  {j.error && <p className="text-12 text-danger">{j.error}</p>}
                  {!j.elsewhere && (
                    <div className="flex justify-end gap-1">
                      {jobActive(j) && <Button size="xs" variant="ghost" leadingIcon="pause" loading={busy === `pause:${j.id}`} onClick={control('pause', [j.id], `pause:${j.id}`)}>Pause</Button>}
                      {(j.status === 'paused' || j.status === 'failed') && (
                        <Button size="xs" variant="outline" leadingIcon="play" loading={busy === `resume:${j.id}`} onClick={control('resume', [j.id], `resume:${j.id}`)}>{j.status === 'failed' ? 'Retry' : 'Resume'}</Button>
                      )}
                      <Tooltip content="Stop for good. Finished days are kept; the rest are computed when you next open them.">
                        <Button size="xs" variant="ghost" leadingIcon="x" loading={busy === `cancel:${j.id}`} onClick={control('cancel', [j.id], `cancel:${j.id}`)}>Discard</Button>
                      </Tooltip>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
      {button}
    </div>
  );
}
