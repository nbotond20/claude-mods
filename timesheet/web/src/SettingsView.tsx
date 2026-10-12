import { useEffect, useState } from 'react';
import { Alert, Button, EmptyState, Icon, Select, Skeleton, useToast, type IconName } from '@loam/ui-web';
import type { Meta } from './api';
import { useConfigDraft } from './settings/useConfigDraft';
import { Group, Row } from './settings/fields';
import {
  CalendarSection,
  CategoriesSection,
  GithubSection,
  ClassifierSection,
  ExportSection,
  HoursSection,
  ProjectsSection,
  RawJsonSection,
  ScopeSection,
  SourcesSection,
  TrackingSection,
  useDetected,
} from './settings/sections';
import { SubmissionSection } from './settings/SubmissionSection';

type Page = 'general' | 'sources' | 'scope' | 'github' | 'calendar' | 'categories' | 'classifier' | 'submission' | 'advanced';

const PAGES: { value: Page; label: string; icon: IconName; description: string }[] = [
  { value: 'general', label: 'General', icon: 'sliders', description: 'Projects, daily hours and export format' },
  { value: 'sources', label: 'Activity sources', icon: 'layers', description: 'Where working time is read from' },
  { value: 'scope', label: 'Work scope', icon: 'folder', description: 'Which folders count as work' },
  { value: 'github', label: 'GitHub', icon: 'branch', description: 'Issues, reviews, releases and deployment approvals' },
  { value: 'calendar', label: 'Calendar', icon: 'calendar', description: 'Google Calendar meetings' },
  { value: 'categories', label: 'Task categories', icon: 'tag', description: 'The NetSuite task list you book against' },
  { value: 'classifier', label: 'Classification', icon: 'sparkle', description: 'How Claude assigns categories' },
  { value: 'submission', label: 'Submission', icon: 'upload', description: 'Entering booked hours into Redmine and NetSuite' },
  { value: 'advanced', label: 'Advanced', icon: 'code', description: 'Raw configuration and setup' },
];

const pageFromHash = (): Page => {
  const p = window.location.hash.split('/')[1];
  return PAGES.some((x) => x.value === p) ? (p as Page) : 'general';
};

export function SettingsView({ onSaved, onRunWizard, meta }: { onSaved: () => void; onRunWizard: () => void; meta?: Meta }) {
  const { toast } = useToast();
  const { loaded, draft, setDraft, update, save, saving, errors, loadError, reload, dirty, reset } = useConfigDraft();
  const { detected } = useDetected();
  const [page, setPage] = useState<Page>(pageFromHash);

  const go = (p: Page) => {
    setPage(p);
    window.history.replaceState(null, '', `#settings/${p}`);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    const onHash = () => {
      if (!window.location.hash.startsWith('#settings')) return;
      setPage(pageFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (loadError && !draft) {
    return <EmptyState variant="error" title="Could not load settings" description={loadError} action={<Button size="sm" variant="primary" leadingIcon="refresh" onClick={reload}>Try again</Button>} />;
  }

  const onSave = async () => {
    if (await save()) {
      toast({ title: 'Settings saved', description: 'Days affected by the change are recomputed in the background.', severity: 'success' });
      onSaved();
    }
  };

  const current = PAGES.find((p) => p.value === page)!;
  const props = draft ? { config: draft, update } : null;

  return (
    <div className="grid gap-8 desktop:grid-cols-[13rem_1fr]">
      <nav aria-label="Settings sections" className="desktop:sticky desktop:top-24 desktop:self-start">
        <Select size="sm" className="w-full desktop:hidden" aria-label="Settings section" value={page} onValueChange={(v) => go(v as Page)} items={PAGES.map((p) => ({ value: p.value, label: p.label, icon: p.icon }))} />
        <ul className="hidden flex-col gap-0.5 desktop:flex">
          {PAGES.map((p) => (
            <li key={p.value}>
              <button
                type="button"
                onClick={() => go(p.value)}
                aria-current={page === p.value ? 'page' : undefined}
                className={`flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-13 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${page === p.value ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'}`}
              >
                <Icon name={p.icon} size={16} className={page === p.value ? 'text-accent-strong' : 'text-ink-3'} />
                {p.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex min-w-0 flex-col gap-8 pb-24">
        <header>
          <h1 className="text-20 font-semibold tracking-tight">{current.label}</h1>
          <p className="text-13 text-ink-3">{current.description}</p>
        </header>

        {errors.length > 0 && <Alert tone="danger" title="Settings were not saved" description={<ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul>} />}

        {!props || !loaded ? (
          <div className="flex flex-col gap-3" aria-busy>
            <Skeleton width={180} height={18} />
            <Skeleton variant="rect" height={220} />
          </div>
        ) : (
          <>
            {page === 'general' && (
              <>
                <ProjectsSection {...props} />
                <HoursSection {...props} />
                <ExportSection {...props} />
              </>
            )}
            {page === 'sources' && (
              <>
                <SourcesSection {...props} detected={detected} />
                <TrackingSection {...props} />
              </>
            )}
            {page === 'scope' && <ScopeSection {...props} />}
            {page === 'github' && <GithubSection {...props} />}
            {page === 'calendar' && <CalendarSection {...props} />}
            {page === 'categories' && (
              <CategoriesSection {...props} autoTones={Object.fromEntries((meta?.categories ?? []).map((c) => [c.name, c.tone]))} />
            )}
            {page === 'classifier' && <ClassifierSection {...props} detected={detected} />}
            {page === 'submission' && <SubmissionSection {...props} />}
            {page === 'advanced' && (
              <>
                <Group title="Setup">
                  <Row label="Setup wizard" hint="Walk through sources, projects, work scope, calendar and classification again.">
                    <Button size="sm" variant="outline" onClick={onRunWizard}>Open wizard</Button>
                  </Row>
                  <Row label="Configuration file" hint="Also editable with timesheet config edit.">
                    <code className="text-12 text-ink-2">{loaded.path}</code>
                  </Row>
                </Group>
                <RawJsonSection config={props.config} replace={setDraft} path={loaded.path} />
              </>
            )}
          </>
        )}
      </div>

      {/* Save bar: only while there is something to save */}
      <div
        className={`fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur transition-[translate,visibility] duration-200 ${dirty ? 'visible translate-y-0' : 'invisible translate-y-full'}`}
        aria-hidden={!dirty}
      >
        <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-3 px-4 tablet:px-6">
          <Icon name="info" size={16} className="text-ink-3" />
          <span className="text-13 text-ink-2">You have unsaved changes</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={reset} tabIndex={dirty ? 0 : -1}>Discard</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={onSave} tabIndex={dirty ? 0 : -1}>Save changes</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
