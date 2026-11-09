import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Alert, Button, Input, Skeleton, useToast } from '@loam/ui-web';
import { api, SYSTEM_LABEL, type SubmitStatus, type SystemId } from '../api';
import { Block, Group, Row, Status, SwitchRow } from './fields';
import { MappingEditor } from './MappingEditor';
import type { SectionProps } from './sections';

const SYSTEMS: { id: SystemId; title: string; description: string; urlHint: string; placeholder: string }[] = [
  {
    id: 'redmine',
    title: 'Redmine',
    description: 'Worktime, per day',
    urlHint: 'The Worktime page, e.g. https://redmine.example.com/work_time/index',
    placeholder: 'https://…/work_time/index',
  },
  {
    id: 'netsuite',
    title: 'NetSuite',
    description: 'Weekly timesheet',
    urlHint: "Your account's start URL.",
    placeholder: 'https://…netsuite.com/…',
  },
];

const POLL_MS = 2000;

/** Keeps the submission status fresh while the page is shown (and the tab is visible). */
function useSubmitStatus() {
  const [status, setStatus] = useState<SubmitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(
    () =>
      api<SubmitStatus>('/api/submit').then(
        (s) => {
          setStatus(s);
          setError(null);
        },
        (e) => setError((e as Error).message),
      ),
    [],
  );
  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return { status, setStatus, error, refresh };
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function SubmissionSection({ config, update }: SectionProps) {
  const { toast } = useToast();
  const { status, setStatus, error, refresh } = useSubmitStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [labels, setLabels] = useState<Record<SystemId, string>>({ redmine: '', netsuite: '' });
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);

  const run = async (key: string, path: string, body: unknown, success?: string) => {
    setBusy(key);
    try {
      const s = await api<SubmitStatus>(path, { body });
      if (mounted.current) setStatus(s);
      if (success) toast({ title: success, severity: 'success' });
      return true;
    } catch (e) {
      toast({ title: 'Submission browser', description: (e as Error).message, severity: 'error' });
      refresh();
      return false;
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const open = status?.browser.open ?? false;

  return (
    <>
      {status && !status.chrome ? (
        <Alert tone="danger" title="Google Chrome not found" description="Submission drives your installed Google Chrome. Install it from google.com/chrome, then come back here." />
      ) : (
        <Alert
          tone="info"
          title="A separate Chrome window, with its own profile"
          description={
            <>
              Timesheet opens Google Chrome with a profile used only for submission{status ? <> (<code className="text-12">{status.profile}</code>)</> : null}. You log in yourself, including SSO and MFA. Only the login session is kept, never passwords.
            </>
          }
        />
      )}

      {error && !status && <Alert tone="danger" title="Could not read the submission status" description={error} action={<Button size="sm" variant="outline" onClick={refresh}>Retry</Button>} />}

      <Group title="Browser">
        <Row label="Status" hint={open ? 'Close it here or in Chrome when you are done.' : 'Opens when you log in to one of the systems below.'}>
          {!status ? <Skeleton width={90} height={14} /> : open ? <Status tone="good">Open</Status> : <Status tone="neutral">Closed</Status>}
          <Button variant="outline" size="sm" leadingIcon="x" disabled={!open} loading={busy === 'close'} onClick={() => run('close', '/api/submit/close', {}, 'Browser closed')}>Close browser</Button>
        </Row>
      </Group>

      {SYSTEMS.map((sys) => (
        <SystemGroup
          key={sys.id}
          sys={sys}
          config={config}
          update={update}
          status={status}
          busy={busy}
          label={labels[sys.id]}
          setLabel={(v) => setLabels((l) => ({ ...l, [sys.id]: v }))}
          onOpen={() => run(`open:${sys.id}`, '/api/submit/open', { system: sys.id })}
          onCapture={async () => {
            if (await run(`capture:${sys.id}`, '/api/submit/capture', { system: sys.id, label: labels[sys.id].trim() }, 'Page captured')) setLabels((l) => ({ ...l, [sys.id]: '' }));
          }}
        />
      ))}
    </>
  );
}

function SystemGroup({
  sys,
  config,
  update,
  status,
  busy,
  label,
  setLabel,
  onOpen,
  onCapture,
}: SectionProps & {
  sys: (typeof SYSTEMS)[number];
  status: SubmitStatus | null;
  busy: string | null;
  label: string;
  setLabel: (v: string) => void;
  onOpen: () => void;
  onCapture: () => void;
}) {
  const urlField = useId();
  const labelField = useId();
  const draft = config.submit[sys.id];
  const saved = status?.systems[sys.id];
  const set = (patch: Partial<typeof draft>) => update({ submit: { ...config.submit, [sys.id]: { ...draft, ...patch } } as typeof config.submit });
  const urlSaved = !!saved?.url && saved.url === draft.url.trim();
  const browserOpen = status?.browser.open ?? false;

  const openHint = !draft.url.trim()
    ? 'Enter the address above and save first.'
    : !urlSaved
      ? 'Save the settings first: the browser opens the saved address.'
      : `Opens ${SYSTEM_LABEL[sys.id]} in the submission window. Log in there; the session is kept for next time.`;

  return (
    <Group title={sys.title} description={sys.description}>
      <Row label="Address" hint={sys.urlHint} htmlFor={urlField}>
        <Input id={urlField} size="sm" type="url" className="w-full font-mono text-12 tablet:w-96" wrapperClassName="w-full tablet:w-auto" value={draft.url} placeholder={sys.placeholder} spellCheck={false} autoComplete="off" onChange={(e) => set({ url: e.target.value.trim() })} />
      </Row>
      <SwitchRow label="Fill only" hint="Fill in and check the values, but leave Update/Save to you." checked={draft.fillOnly} onChange={(v) => set({ fillOnly: v })} />
      <Row label="Log in" hint={openHint}>
        <Button variant={urlSaved && !browserOpen ? 'primary' : 'outline'} size="sm" leadingIcon="external-link" disabled={!urlSaved || status?.chrome === false} loading={busy === `open:${sys.id}`} onClick={onOpen}>Open & log in</Button>
      </Row>
      <Row label="Capture this page" hint={browserOpen ? 'Saves a sanitized copy and a screenshot of the page shown in the submission window.' : 'Open the browser first.'} htmlFor={labelField} disabled={!browserOpen}>
        <Input id={labelField} size="sm" className="w-40" value={label} placeholder="e.g. worktime" maxLength={80} disabled={!browserOpen} spellCheck={false} autoComplete="off" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && browserOpen && onCapture()} />
        <Button variant="outline" size="sm" leadingIcon="camera" disabled={!browserOpen} loading={busy === `capture:${sys.id}`} onClick={onCapture}>Capture</Button>
      </Row>
      <Block>
        <MappingEditor system={sys.id} config={config} update={update} enabled />
      </Block>
      <Block>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="text-13 font-medium text-ink">Recent captures</span>
            {saved && <code className="text-12 text-ink-3">{saved.folder}</code>}
          </div>
          {!saved ? (
            <Skeleton width={200} height={14} />
          ) : saved.captures.length === 0 ? (
            <p className="text-12 text-ink-3">None yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
              {saved.captures.map((c) => (
                <li key={c.file} className="flex items-center justify-between gap-4 px-3 py-1.5 text-12">
                  <span className="min-w-0 truncate font-mono text-ink-2" title={c.png ? `${c.file} + ${c.png}` : c.file}>
                    {c.file.replace(/\.html$/, '')}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-3">{when(c.at)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-12 text-ink-3">Screenshots show your own data — look through them before sharing.</p>
        </div>
      </Block>
    </Group>
  );
}
