import { useEffect, useState } from 'react';
import { Alert, Button, Card, EmptyState, Skeleton, Wizard } from '@loam/ui-web';
import { useConfigDraft } from './settings/useConfigDraft';
import { CalendarSection, ClassifierSection, HoursSection, ProjectsSection, ScopeSection, SourcesSection, useDetected } from './settings/sections';

/**
 * First-run setup. Each step reuses the Settings groups; nothing is written until
 * the last step, which saves through the same server-side validation as Settings.
 */
export function SetupWizard({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const { loaded, draft, update, save, errors, loadError, reload } = useConfigDraft();
  const { detected } = useDetected();
  const [step, setStep] = useState(0);
  const [prefilled, setPrefilled] = useState(false);

  // Prefill the git identity once from the global git config.
  useEffect(() => {
    if (prefilled || !draft || !detected) return;
    setPrefilled(true);
    if (!draft.authorEmails.length && detected.gitEmail) update({ authorEmails: [detected.gitEmail] });
  }, [prefilled, draft, detected, update]);

  if (loadError && !draft) return <EmptyState variant="error" title="Could not load the configuration" description={loadError} action={<Button size="sm" variant="primary" onClick={reload}>Try again</Button>} />;

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-20 font-semibold tracking-tight">Set up Timesheet</h1>
        <p className="mt-0.5 text-13 text-ink-3">Everything here can be changed later in Settings.</p>
      </div>
      {onCancel && (
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel setup</Button>
      )}
    </div>
  );

  if (!draft || !loaded) {
    return (
      <div className="mx-auto flex max-w-[880px] flex-col gap-6">
        {header}
        <Skeleton variant="rect" height={360} />
      </div>
    );
  }
  const props = { config: draft, update };
  const body = (children: React.ReactNode) => <div className="flex flex-col gap-8 pt-2">{children}</div>;

  const steps = [
    {
      id: 'sources',
      label: 'Sources',
      content: body(
        <>
          <p className="text-13 text-ink-2">Timesheet builds your hours from AI coding sessions (Claude Code, OpenCode), git commits and Google Calendar. Check what was found on this machine.</p>
          <SourcesSection {...props} detected={detected} />
        </>,
      ),
    },
    {
      id: 'projects',
      label: 'Projects & hours',
      content: body(
        <>
          <ProjectsSection {...props} />
          <HoursSection {...props} />
        </>,
      ),
    },
    {
      id: 'scope',
      label: 'Work scope',
      content: body(<ScopeSection {...props} />),
      validate: () => draft.scope.work.length > 0 || window.confirm('No work paths yet, so nothing will be booked. Continue anyway?'),
    },
    { id: 'calendar', label: 'Calendar', content: body(<CalendarSection {...props} />) },
    { id: 'classifier', label: 'Classification', content: body(<ClassifierSection {...props} detected={detected} />) },
  ];

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-6">
      {header}
      {errors.length > 0 && <Alert tone="danger" title="Could not save" description={<ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul>} />}
      <Card className="p-6">
        <Wizard
          steps={steps}
          step={step}
          onStepChange={setStep}
          finishLabel="Save & start"
          onFinish={async () => {
            if (await save()) onDone();
          }}
        />
      </Card>
    </div>
  );
}
