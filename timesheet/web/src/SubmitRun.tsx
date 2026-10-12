import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icon, Spinner } from '@loam/ui-web';
import { api, fmt, SYSTEM_LABEL, type LabeledCell, type PrepareResult, type RunProgress, type SubmitRunState, type SystemId, type UnitState } from './api';

const POLL_MS = 1000;

const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const UNIT_LABEL: Record<UnitState, string> = { pending: 'waiting', working: 'working…', waiting: 'press Update in the browser', saved: 'saved and checked', failed: 'failed', aborted: 'stopped' };
const UNIT_TONE: Record<UnitState, 'neutral' | 'info' | 'warn' | 'good' | 'danger'> = { pending: 'neutral', working: 'info', waiting: 'warn', saved: 'good', failed: 'danger', aborted: 'warn' };

/**
 * Prepare → review → confirm → live progress for one system and week. Nothing is written before
 * the confirmation, and the server re-reads the site and refuses if anything changed since.
 */
export function SubmitRun({ system, week, enabled }: { system: SystemId; week: string; enabled: boolean }) {
  const label = SYSTEM_LABEL[system];
  const [prep, setPrep] = useState<PrepareResult | null>(null);
  const [busy, setBusy] = useState<'prepare' | 'execute' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = seq.current;
    try {
      const r = await api<SubmitRunState>(`/api/submit/run?system=${system}&week=${week}`);
      if (id === seq.current) setProgress(r.progress);
    } catch {
      /* the next poll retries */
    }
  }, [system, week]);

  useEffect(() => {
    seq.current++;
    setPrep(null);
    setProgress(null);
    setError(null);
    load();
  }, [load]);

  const running = progress?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const call = async <T,>(kind: 'prepare' | 'execute' | 'cancel', path: string, body: unknown): Promise<T | null> => {
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

  const prepare = async () => {
    const r = await call<PrepareResult>('prepare', '/api/submit/prepare', { system, week });
    if (r) {
      setPrep(r);
      setProgress(null);
    }
  };

  const execute = async () => {
    if (prep?.state !== 'ready') return;
    setConfirm(false);
    const r = await call<{ progress: RunProgress }>('execute', '/api/submit/execute', { system, week, fingerprint: prep.fingerprint });
    if (r) {
      setPrep(null);
      setProgress(r.progress);
    }
  };

  const cancel = async () => {
    const r = await call<{ progress: RunProgress | null }>('cancel', '/api/submit/cancel', {});
    if (r?.progress) setProgress(r.progress);
  };

  const ready = prep?.state === 'ready' ? prep : null;
  const action = ready?.fillOnly ? `Fill in ${label} (you press Update)` : `Enter and save in ${label}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" leadingIcon="refresh" disabled={!enabled || running || busy !== null} loading={busy === 'prepare'} onClick={prepare}>
          {prep ? 'Prepare again' : 'Prepare'}
        </Button>
        <span className="text-12 text-ink-3">{!enabled ? `${label} automation not enabled yet` : running ? 'A submission is running.' : `Compares the plan with what ${label} holds. Nothing is written yet.`}</span>
      </div>
      {error && <p className="text-12 text-danger">{error}</p>}
      {prep && !running && <PrepareView prep={prep} label={label} />}
      {ready && !running && (
        <div>
          <Button variant="primary" size="sm" leadingIcon="play" loading={busy === 'execute'} disabled={busy !== null} onClick={() => setConfirm(true)}>
            {action}
          </Button>
        </div>
      )}
      {progress && <ProgressView progress={progress} label={label} onCancel={cancel} cancelling={busy === 'cancel'} />}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{action}?</DialogTitle>
            <DialogDescription>
              {ready?.fillOnly
                ? `Timesheet fills in each day below in the ${label} window and waits for you to press Update there; each day is checked after you save it.`
                : `Timesheet fills in each day below, presses Update, and checks the result. It stops at the first problem.`}{' '}
              {label} is read again first: if anything changed since this review, nothing is written.
            </DialogDescription>
          </DialogHeader>
          {ready && <CellTable cells={ready.write} label={label} />}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="primary" size="sm" leadingIcon="check" onClick={execute}>{ready?.fillOnly ? 'Fill in' : 'Enter and save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Reasons({ tone, title, items }: { tone: 'warn' | 'danger'; title: string; items: string[] }) {
  return (
    <div className={`flex flex-col gap-1.5 rounded-md border px-3 py-2.5 ${tone === 'danger' ? 'border-danger/40 bg-danger/10' : 'border-warn/40 bg-warn/10'}`}>
      <span className="flex items-center gap-1.5 text-12 font-medium text-ink">
        <Icon name={tone === 'danger' ? 'alert-circle' : 'alert-triangle'} size={14} className={tone === 'danger' ? 'text-danger' : 'text-warn'} /> {title}
      </span>
      <ul className="list-disc pl-5 text-12 leading-5 text-ink-2">
        {items.map((r) => (
          <li key={r} className="break-words">{r}</li>
        ))}
      </ul>
    </div>
  );
}

function PrepareView({ prep, label }: { prep: PrepareResult; label: string }) {
  switch (prep.state) {
    case 'login':
      return <Alert tone="warn" title={`Log in to ${label}`} description={`${prep.reason}. The browser window is open: log in there, then Prepare again.`} />;
    case 'blocked':
      return <Reasons tone="warn" title="Nothing can be entered for this week:" items={prep.reasons} />;
    case 'aborted':
      return <Reasons tone="danger" title={`Stopped while reading ${label}; nothing written:`} items={[prep.reason, ...prep.screenshots.map((s) => `Screenshot: ${s}`)]} />;
    case 'conflict':
      return <Reasons tone="warn" title={`${label} already holds other values; nothing will be written for this week:`} items={prep.reasons} />;
    case 'noop':
      return (
        <p className="flex items-center gap-1.5 text-12 text-ink-2">
          <Icon name="check-circle" size={14} className="text-good" /> Everything is already in {label}.
        </p>
      );
    case 'ready': {
      const writing = new Set(prep.write.map((c) => `${c.date} ${c.label}`));
      const there = prep.plan.filter((c) => !writing.has(`${c.date} ${c.label}`));
      return (
        <div className="flex flex-col gap-2">
          <span className="text-12 font-medium text-ink">To write ({prep.write.length})</span>
          <CellTable cells={prep.write} label={label} />
          {there.length > 0 && (
            <>
              <span className="text-12 font-medium text-ink">Already in {label} ({there.length})</span>
              <CellTable cells={there} label={label} muted />
            </>
          )}
          {prep.notes.map((n) => (
            <p key={n} className="flex items-center gap-1.5 text-12 text-ink-2">
              <Icon name="info" size={14} className="text-warn" /> {n}
            </p>
          ))}
        </div>
      );
    }
  }
}

function CellTable({ cells, label, muted = false }: { cells: LabeledCell[]; label: string; muted?: boolean }) {
  return (
    <div className="max-h-72 overflow-auto rounded-md border border-line">
      <table className={`w-full text-12 ${muted ? 'text-ink-3' : 'text-ink'}`}>
        <thead>
          <tr className="border-b border-line text-left text-ink-3">
            <th className="px-3 py-1 font-medium">Date</th>
            <th className="px-3 py-1 font-medium">{label === 'Redmine' ? 'Issue · activity' : 'Project · task'}</th>
            <th className="px-3 py-1 text-right font-medium">Hours</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {cells.map((c) => (
            <tr key={`${c.date} ${c.label}`}>
              <td className="whitespace-nowrap px-3 py-1 tabular-nums">{dayLabel(c.date)}</td>
              <td className="px-3 py-1">{c.label}</td>
              <td className="px-3 py-1 text-right tabular-nums">{fmt(c.hours)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProgressView({ progress, label, onCancel, cancelling }: { progress: RunProgress; label: string; onCancel: () => void; cancelling: boolean }) {
  const running = progress.status === 'running';
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line px-3 py-2.5" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        {running && <Spinner size="sm" />}
        <span className="text-12 font-medium text-ink">{progress.message}</span>
        {running && (
          <Button variant="outline" size="xs" leadingIcon="x" className="ml-auto" loading={cancelling} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {progress.units.length > 0 && (
        <ul className="flex flex-col gap-1 text-12">
          {progress.units.map((u) => (
            <li key={u.unit} className="flex flex-wrap items-center gap-2">
              <span className="w-28 tabular-nums text-ink-2">{/^\d{4}-\d{2}-\d{2}$/.test(u.unit) ? dayLabel(u.unit) : u.unit}</span>
              <Badge size="sm" variant={UNIT_TONE[u.state]}>{UNIT_LABEL[u.state]}</Badge>
              <span className="text-ink-3">{u.cells.map((c) => `${c.label} ${fmt(c.hours)} h`).join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
      {progress.status === 'saved' && <Alert tone="good" title={`Entered in ${label}`} description={`Every day was ${progress.fillOnly ? 'saved by you' : 'saved'} and checked against the plan.`} />}
      {progress.status === 'aborted' && <Alert tone="warn" title="Stopped" description={<Detail text={progress.error} shots={progress.screenshots} />} />}
      {progress.status === 'failed' && <Alert tone="danger" title={`Failed: check ${label} by hand`} description={<Detail text={progress.error} shots={progress.screenshots} />} />}
    </div>
  );
}

function Detail({ text, shots }: { text?: string; shots: string[] }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="break-words">{text}</span>
      {shots.map((s) => (
        <code key={s} className="break-all text-12">{s}</code>
      ))}
    </span>
  );
}
