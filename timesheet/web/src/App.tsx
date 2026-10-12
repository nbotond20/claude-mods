import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@loam/ui-web';
import { api, type Meta } from './api';
import { JobIndicator, JobsProvider } from './jobs';
import { TimesheetView } from './TimesheetView';
// The scheduler is most of the bundle; load it when the Calendar tab is first opened.
const CalendarView = lazy(() => import('./CalendarView').then((m) => ({ default: m.CalendarView })));
import { SettingsView } from './SettingsView';
import { SetupWizard } from './SetupWizard';

type Tab = 'timesheet' | 'calendar' | 'settings';

function initialTab(): Tab {
  const hash = window.location.hash.slice(1).split('/')[0];
  return hash === 'calendar' || hash === 'settings' ? hash : 'timesheet';
}

export function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wizard, setWizard] = useState<'first-run' | 'manual' | null>(null);
  // Tabs stay mounted once visited, so switching back is instant and keeps scroll and state.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([initialTab()]));
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab))), [tab]);
  const panel = (value: Tab) => ({ value, forceMount: true as const, hidden: tab !== value });

  const loadMeta = useCallback(() => {
    setError(null);
    api<Meta>('/api/meta').then(setMeta, (e) => setError(e.message));
  }, []);
  useEffect(loadMeta, [loadMeta]);
  useEffect(() => {
    const onHash = () => setTab(initialTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    api<{ exists: boolean }>('/api/config').then((r) => !r.exists && setWizard('first-run'), () => {});
  }, []);

  const change = (value: string) => {
    setTab(value as Tab);
    window.history.replaceState(null, '', `#${value}`);
  };

  return (
    <JobsProvider>
      <Tabs value={tab} onValueChange={change} className="flex min-h-screen flex-col text-ink">
        <header className="sticky top-0 z-20 border-b border-line bg-canvas">
          <div className="mx-auto flex max-w-[1200px] flex-wrap items-end gap-x-8 px-4 pt-3 tablet:flex-nowrap tablet:px-6">
            <span className="flex h-11 shrink-0 items-center gap-2 text-16 font-semibold tracking-tight">
              <span className="grid size-7 place-items-center rounded-md bg-accent text-accent-ink">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <circle cx="12" cy="12" r="8" />
                  <path d="M12 8v4l2.5 2" />
                </svg>
              </span>
              Timesheet
            </span>
            {!wizard && (
              <TabsList aria-label="Sections" className="order-last -mb-px w-full tablet:order-none tablet:w-auto">
                <TabsTrigger value="timesheet">Timesheet</TabsTrigger>
                <TabsTrigger value="calendar">Calendar</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
            )}
            <div className="ml-auto flex h-11 min-w-0 items-center">
              <JobIndicator />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 tablet:px-6 tablet:py-8">
          {wizard ? (
            <SetupWizard
              onDone={() => {
                setWizard(null);
                loadMeta();
              }}
              onCancel={wizard === 'manual' ? () => setWizard(null) : undefined}
            />
          ) : error ? (
            <EmptyState variant="error" title="Timesheet is not reachable" description={`${error}. Is \`timesheet serve\` still running?`} action={<Button variant="primary" size="sm" leadingIcon="refresh" onClick={loadMeta}>Try again</Button>} />
          ) : !meta ? (
            <div className="flex flex-col gap-4" aria-busy>
              <Skeleton variant="rect" height={40} width="40%" />
              <Skeleton variant="rect" height={112} />
              <Skeleton variant="rect" height={240} />
            </div>
          ) : (
            <>
              <TabsContent {...panel('timesheet')}>{visited.has('timesheet') && <TimesheetView meta={meta} />}</TabsContent>
              <TabsContent {...panel('calendar')}>{visited.has('calendar') && (
                  <Suspense fallback={<Skeleton variant="rect" height="calc(100vh - 190px)" />}>
                    <CalendarView meta={meta} active={tab === 'calendar'} />
                  </Suspense>
                )}</TabsContent>
              <TabsContent {...panel('settings')}>{visited.has('settings') && <SettingsView meta={meta} onSaved={loadMeta} onRunWizard={() => setWizard('manual')} />}</TabsContent>
            </>
          )}
        </main>
      </Tabs>
    </JobsProvider>
  );
}
