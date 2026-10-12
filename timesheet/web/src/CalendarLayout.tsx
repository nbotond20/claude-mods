import { useState } from 'react';
import {
  Button,
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Icon,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  SegmentedControl,
  SchedulerAppliedChips,
  SchedulerContextMenuItems,
  SchedulerFilterPanel,
  SchedulerImportExportPanel,
  SchedulerNarrowSurface,
  SchedulerPreferencesPanel,
  SchedulerSidePanel,
  SchedulerToolbarIconButton,
  SchedulerViewport,
  useScheduler,
  useSchedulerRangeTitle,
  type SchedulerView,
} from '@loam/ui-web';

const VIEW_LABELS: Record<SchedulerView, string> = { day: 'Day', week: 'Week', month: 'Month', agenda: 'Agenda', year: 'Year', resource: 'Resources' };

/**
 * Our arrangement of the Loam scheduler (passed as its children): the built-in layout,
 * with a toolbar that fits one row. Activity comes from the timesheet, so there is no
 * Create or Find a time; undo and redo are icons, and preferences open in a dialog
 * because the panel is taller than the space below the toolbar.
 */
export function CalendarLayout() {
  const { narrow, preferences, loading } = useScheduler();
  const [contextKey, setContextKey] = useState<string | null>(null);

  const grid = (
    <div className="relative flex min-h-0 flex-1">
      {!narrow && preferences.isSidePanelOpen && <SchedulerSidePanel />}
      <ContextMenuRoot>
        <ContextMenuTrigger asChild>
          <div
            className="relative flex min-w-0 flex-1 flex-col bg-surface"
            onContextMenuCapture={(e) => setContextKey((e.target as HTMLElement).closest<HTMLElement>('[data-occurrence-key]')?.dataset.occurrenceKey ?? null)}
          >
            {loading && (
              <div className="absolute inset-x-0 top-0 z-sticky">
                <Progress value={null} size="sm" aria-label="Loading events" />
              </div>
            )}
            <SchedulerViewport />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <SchedulerContextMenuItems occurrenceKey={contextKey} />
        </ContextMenuContent>
      </ContextMenuRoot>
    </div>
  );

  if (narrow) return <SchedulerNarrowSurface>{grid}</SchedulerNarrowSurface>;
  return (
    <>
      <CalendarToolbar />
      {grid}
    </>
  );
}

function CalendarToolbar() {
  const { preferences, setPreferences, views, view, setView, step, goTo, filters, setFilters, visibleDate, zone, canUndo, canRedo, undoLabel, undo, redo } = useScheduler();
  const title = useSchedulerRangeTitle();
  const [preferencesOpen, setPreferencesOpen] = useState(false);

  return (
    <header className="relative z-sticky flex flex-none flex-col gap-2 border-b-hairline border-line bg-surface p-3" data-noprint="">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
        <SchedulerToolbarIconButton
          icon="menu"
          label={preferences.isSidePanelOpen ? 'Hide side panel' : 'Show side panel'}
          onClick={() => setPreferences({ isSidePanelOpen: !preferences.isSidePanelOpen })}
          active={preferences.isSidePanelOpen}
        />
        <Button variant="outline" size="sm" onClick={() => goTo(Date.now())} title="Today (T)">
          Today
        </Button>
        <div className="flex items-center gap-0.5">
          <SchedulerToolbarIconButton icon="chevron-left" label="Previous period" onClick={() => step(-1)} />
          <SchedulerToolbarIconButton icon="chevron-right" label="Next period" onClick={() => step(1)} />
        </div>
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="type-h4 truncate text-ink">{title}</h3>
          {preferences.showWeekNumber && (view === 'week' || view === 'day') && <span className="font-mono text-11 text-ink-3">W{zone.weekNumber(visibleDate)}</span>}
        </div>

        {/* Takes the rest of the row; the search shrinks before anything wraps. */}
        <div className="flex min-w-min flex-1 items-center justify-end gap-2">
          <Input
            data-loam-sched-search=""
            size="sm"
            leadingIcon="search"
            aria-label="Search events"
            placeholder="Search events  /"
            value={filters.query}
            onChange={(e) => setFilters({ query: e.target.value })}
            className="w-panel-xs min-w-40 shrink"
          />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Filters" title="Filters" className="size-icon-btn-sm px-0">
                <Icon name="filter" className="icon-sm" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-panel-md">
              <SchedulerFilterPanel />
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Import and export" title="Import and export" className="size-icon-btn-sm px-0">
                <Icon name="download" className="icon-sm" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-panel-md">
              <SchedulerImportExportPanel />
            </PopoverContent>
          </Popover>
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="sm" aria-label="Undo" title={undoLabel ? `Undo · ${undoLabel}` : 'Undo (⌘Z)'} disabled={!canUndo} onClick={undo} className="size-icon-btn-sm px-0">
              <Icon name="undo" className="icon-sm" />
            </Button>
            <Button variant="ghost" size="sm" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={redo} className="size-icon-btn-sm px-0">
              <Icon name="redo" className="icon-sm" />
            </Button>
          </div>
          <SchedulerToolbarIconButton icon="settings" label="Preferences" onClick={() => setPreferencesOpen(true)} />
          <SegmentedControl
            aria-label="Calendar view"
            shape="rounded"
            size="sm"
            value={view}
            onValueChange={(next) => setView(next as SchedulerView)}
            items={views.map((v) => ({ value: v, label: VIEW_LABELS[v] }))}
          />
        </div>
      </div>
      <SchedulerAppliedChips />

      <Dialog open={preferencesOpen} onOpenChange={setPreferencesOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Calendar preferences</DialogTitle>
          </DialogHeader>
          <SchedulerPreferencesPanel />
        </DialogContent>
      </Dialog>
    </header>
  );
}
