import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, LoadingOverlay, Scheduler, Select, Spinner, Switch, useToast, type CalendarEvent, type CalendarResource, type EventTone, type SchedulerView } from '@loam/ui-web';
import { CalendarLayout } from './CalendarLayout';
import { api, fmt, fmtMin, OTHER_LABEL, type Block, type DayReport, type Meta, type RepoInfo } from './api';
import { hueMark, hueOf, nearestTone, schedulerCss } from './colors';
import { BlockDetails, repoOf, type BlockRef } from './BlockDetails';
import { useReport } from './useReport';
import { useShowOther } from './prefs';

const DAY_MS = 86_400_000;
/** Parallel pieces get their own lane only when at least this long, and at most as many as the view has room for. */
const LANE_MIN_MS = 20 * 60_000;
const MAX_LANES: Record<SchedulerView, number> = { day: 4, resource: 4, week: 2, month: 1, agenda: 1, year: 1 };
/**
 * A timed chip is drawn at least this tall (Loam's min height at the densest zoom), but only
 * events whose times overlap are laid side by side. A shorter chip would spill over the next.
 */
const MIN_CHIP_MS = 35 * 60_000;
const TIME_GRID: SchedulerView[] = ['day', 'week', 'resource'];
const VIEWS: SchedulerView[] = ['day', 'week', 'month', 'agenda', 'resource'];
const iso = (ms: number) => new Date(ms).toLocaleDateString('sv-SE');
const catId = (name: string) => `cat:${name}`;
const otherId = (kind: string) => `other:${kind}`;

/** The dates a view shows, padded a week each side so week-start preferences never leave gaps. */
function rangeFor(view: SchedulerView, visible: number, today: string): [string, string] | null {
  const d = new Date(visible);
  let from: number;
  let to: number;
  if (view === 'day' || view === 'resource') [from, to] = [visible, visible];
  else if (view === 'week') [from, to] = [visible - 7 * DAY_MS, visible + 7 * DAY_MS];
  else [from, to] = [new Date(d.getFullYear(), d.getMonth(), 1).getTime() - 7 * DAY_MS, new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime() + 7 * DAY_MS];
  const f = iso(from);
  const t = iso(to) > today ? today : iso(to);
  return f > t ? null : [f, t];
}

function primary(b: Block): string {
  return [...b.allocations].sort((x, y) => y.fraction - x.fraction)[0]?.category ?? b.hint;
}

type ColorBy = 'category' | 'repo';

function toEvents(days: DayReport[], meta: Meta, repos: Record<string, RepoInfo>, colorBy: ColorBy, maxLanes: number, showOther: boolean): CalendarEvent[] {
  const tone = new Map(meta.categories.map((c) => [c.name, c.tone as EventTone]));
  const hue = new Map(meta.categories.map((c) => [c.name, c.hue]));
  const events: CalendarEvent[] = [];
  for (const d of days) {
    const other = showOther ? d.other ?? [] : [];
    const otherMs = other.reduce((n, b) => n + b.end - b.start, 0);
    if (d.entries.length || otherMs) {
      const start = new Date(`${d.date}T00:00:00`).getTime();
      events.push({
        id: `total:${d.date}`,
        title: [d.entries.length && `Booked ${fmt(d.total)}h · real ${fmt(d.realTotal)}h${d.measuredTotal !== undefined ? ` · ${fmtMin(d.measuredTotal)} recorded` : ''}`, otherMs && `other ${fmt(otherMs / 3_600_000)}h`].filter(Boolean).join(' · '),
        description: d.summary,
        start,
        end: new Date(`${d.date}T00:00:00`).setDate(new Date(start).getDate() + 1),
        allDay: true,
        busy: false,
        readOnly: true,
        tone: 'waiting',
      });
    }
    for (const b of d.blocks) {
      const category = primary(b);
      const blockRepos = [...new Map(b.paths.map((p) => repoOf(repos, p)).map((r) => [r.root, r])).values()];
      const hueFor = (paths: string[]) => (colorBy === 'repo' && paths.length ? hueOf(repoOf(repos, paths[0]).root) : hue.get(category));
      const base = {
        resource: catId(category),
        tone: tone.get(category) ?? 'accent',
        // Details open in a side sheet (see onClickCapture); this is only the fallback text.
        description: b.allocations.map((a) => (a.fraction < 1 ? `${a.category} ${Math.round(a.fraction * 100)}%` : a.category)).join(', '),
        resizable: false as const,
      };
      const items = b.items ?? [];
      // Parallel pieces become separate events, drawn next to each other. To keep the grid
      // readable only the longest few that last long enough get a lane; the rest are listed in
      // the details sheet, and the last lane starts with how many more there are.
      const lanes = items
        .map((it, n) => ({ it, n }))
        .filter(({ it }) => it.end - it.start >= LANE_MIN_MS)
        .sort((x, y) => y.it.end - y.it.start - (x.it.end - x.it.start))
        .slice(0, maxLanes)
        .sort((x, y) => x.it.start - y.it.start);
      const hidden = items.length - lanes.length;
      if (b.kind === 'work' && lanes.length > 1) {
        lanes.forEach(({ it, n }, i) => {
          const h = hueFor(it.path ? [it.path] : b.paths);
          const more = i === lanes.length - 1 && hidden > 0 ? `+${hidden} more · ` : '';
          events.push({
            ...base,
            id: `item:${d.date}:${b.id}:${n}${h == null ? '' : hueMark(h)}`,
            title: more + (it.summary || 'Work'),
            start: it.start,
            end: it.end,
            location: [it.path ? repoOf(repos, it.path).name : null, it.branch].filter(Boolean).join(' · ') || undefined,
          });
        });
        continue;
      }
      const h = hueFor(b.paths);
      events.push({
        ...base,
        // The hue mark lets the stylesheet colour this chip (see colors.ts).
        id: `block:${d.date}:${b.id}${h == null ? '' : hueMark(h)}`,
        title: b.kind === 'meeting' ? (b.texts[0] ?? 'Meeting') : (b.summary || 'Work') + (items.length > 1 ? ` · ${items.length} parallel` : ''),
        start: b.start,
        end: b.end,
        location: b.kind === 'meeting' ? undefined : [blockRepos.map((r) => r.name).join(', '), b.branches.filter((x) => x !== 'HEAD')[0]].filter(Boolean).join(' · ') || undefined,
      });
    }
    // Personal and unassigned activity: one muted chip per block, in its own resource group.
    for (const b of other) {
      const names = [...new Set(b.paths.map((p) => repoOf(repos, p).name))];
      events.push({
        id: `other:${d.date}:${b.id}`,
        resource: otherId(b.kind),
        tone: 'waiting',
        title: `${OTHER_LABEL[b.kind]} · ${names.slice(0, 2).join(', ') || 'activity'}${names.length > 2 ? ` +${names.length - 2}` : ''}`,
        description: b.kind === 'unassigned' ? 'Not booked until a scope rule covers it' : 'Personal; never booked',
        start: b.start,
        end: b.end,
        busy: false,
        readOnly: true,
      });
    }
  }
  return events;
}

/**
 * Gives a short chip that would run into the next one a display span of MIN_CHIP_MS, so the
 * scheduler puts the two side by side instead of drawing one over the other. Times shown in
 * the details sheet still come from the block.
 */
function separate(events: CalendarEvent[], byResource: boolean): CalendarEvent[] {
  const timed = events.filter((e) => !e.allDay).sort((a, b) => a.start - b.start);
  const out = new Map<string, CalendarEvent>();
  for (const e of timed) {
    const shown = e.start + MIN_CHIP_MS;
    if (e.end >= shown) continue;
    const collides = timed.some((o) => o !== e && (!byResource || o.resource === e.resource) && o.start >= e.start && o.start < shown);
    if (collides) out.set(e.id, { ...e, end: shown });
  }
  return out.size ? events.map((e) => out.get(e.id) ?? e) : events;
}

/** A category row; the scheduler's own dots only take a tone, so use the closest one to its hue. */
const resourceOf = (c: Meta['categories'][number]): CalendarResource => ({ id: catId(c.name), title: c.name, subtitle: c.subtask, tone: c.hue == null ? (c.tone as EventTone) : nearestTone(c.hue) });

export function CalendarView({ meta, active = true }: { meta: Meta; active?: boolean }) {
  const { toast } = useToast();
  const [view, setView] = useState<SchedulerView>('week');
  const [visible, setVisible] = useState(() => new Date(`${meta.today}T12:00:00`).getTime());

  const range = rangeFor(view, visible, meta.today);
  const { report, loading, refreshing, error, reload } = useReport(range ? { from: range[0], to: range[1] } : null);
  const days = range ? report?.days ?? [] : [];

  // A hidden tab has no size; let the scheduler measure again when it is shown.
  useEffect(() => {
    if (active) window.dispatchEvent(new Event('resize'));
    else setDetailsOpen(false);
  }, [active]);

  const [colorBy, setColorBy] = useState<ColorBy>(() => {
    try {
      return localStorage.getItem('ts-color-by') === 'repo' ? 'repo' : 'category';
    } catch {
      return 'category';
    }
  });
  const [showOther, setShowOther] = useShowOther();
  const [details, setDetails] = useState<BlockRef | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const pressAt = useRef<[number, number] | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  /** The range the time grid was last scrolled for; cleared while hidden, since a hidden scroller forgets its position. */
  const scrolledFor = useRef<string | null>(null);
  /** The block (and item) behind a clicked event chip; opens its details. */
  const openFrom = (target: HTMLElement): boolean => {
    const key = target.closest<HTMLElement>('[data-occurrence-key]')?.dataset.occurrenceKey;
    const m = key && /^(block|item|other):([\d-]+):(\d+)(?::(\d+))?/.exec(key);
    if (!m) return false;
    const day = days.find((d) => d.date === m[2]);
    const block = (m[1] === 'other' ? day?.other : day?.blocks)?.find((b) => String(b.id) === m[3]);
    if (!block) return false;
    setDetails({ date: m[2], block, itemId: m[4] !== undefined ? block.items?.[Number(m[4])]?.id : undefined });
    setDetailsOpen(true);
    return true;
  };
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 639px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const maxLanes = Math.min(MAX_LANES[view], narrow ? 2 : Infinity);
  // Land on the day's work: the earliest timed block in view (08:00 when there is none), once per
  // range and each time the tab is shown, so it never fights the user's own scrolling.
  const rangeKey = `${view}|${range?.join('|') ?? ''}`;
  useEffect(() => {
    if (!active) {
      scrolledFor.current = null;
      return;
    }
    if (!TIME_GRID.includes(view) || loading || scrolledFor.current === rangeKey) return;
    const frame = requestAnimationFrame(() => {
      const scroller = shell.current?.querySelector<HTMLElement>('[data-loam-sched-scroller]');
      if (!scroller?.clientHeight) return;
      scrolledFor.current = rangeKey;
      const top = scroller.getBoundingClientRect().top;
      const chips = [...scroller.querySelectorAll<HTMLElement>('[data-occurrence-key]')].filter((el) => /^(block|item|other):/.test(el.dataset.occurrenceKey ?? ''));
      if (chips.length) {
        const first = Math.min(...chips.map((el) => el.getBoundingClientRect().top));
        scroller.scrollTop += first - top - scroller.clientHeight * 0.15;
      } else {
        scroller.scrollTop = (8 / 24) * scroller.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, view, rangeKey, loading, report]);

  const events = useMemo(() => {
    const all = toEvents(days, meta, report?.repos ?? {}, colorBy, maxLanes, showOther);
    return TIME_GRID.includes(view) ? separate(all, view === 'resource') : all;
  }, [days, meta, report, colorBy, maxLanes, showOther, view]);
  const css = useMemo(() => schedulerCss(events.flatMap((e) => /:h(\d+)$/.exec(e.id)?.[1] ?? []).map(Number)), [events]);
  const resources: CalendarResource[] = useMemo(
    () => [
      { id: 'capex', title: 'CAPEX', children: meta.categories.filter((c) => c.capex).map(resourceOf) },
      { id: 'opex', title: 'OPEX', children: meta.categories.filter((c) => !c.capex).map(resourceOf) },
      ...(showOther
        ? [
            {
              id: 'other',
              title: 'Other',
              children: [
                { id: otherId('unassigned'), title: OTHER_LABEL.unassigned, subtitle: 'No scope rule yet', tone: 'warn' as EventTone },
                { id: otherId('personal'), title: OTHER_LABEL.personal, subtitle: 'Never booked', tone: 'waiting' as EventTone },
              ],
            },
          ]
        : []),
    ],
    [meta, showOther],
  );

  /** Moving a block to another category recategorizes it; its time comes from real activity and snaps back. */
  const onEventsChange = async (next: CalendarEvent[]) => {
    const before = new Map(events.map((e) => [e.id, e]));
    let recategorized = 0;
    const done = new Set<string>();
    let moved = false;
    try {
      for (const e of next) {
        const prev = before.get(e.id);
        if (!prev || !/^(block|item):/.test(e.id)) {
          if (!prev) moved = true;
          continue;
        }
        if (e.resource !== prev.resource && e.resource?.startsWith('cat:')) {
          const [, date, blockId] = e.id.split(':');
          if (done.has(`${date}:${blockId}`)) continue;
          done.add(`${date}:${blockId}`);
          await api('/api/block', { body: { date, blockId, category: e.resource.slice(4) } });
          recategorized++;
        } else if (e.start !== prev.start || e.end !== prev.end || e.title !== prev.title) moved = true;
      }
    } catch (err) {
      toast({ title: 'Could not recategorize', description: (err as Error).message, severity: 'error' });
    }
    if (next.length < events.length) moved = true;
    if (recategorized) toast({ title: `Recategorized ${recategorized} block${recategorized > 1 ? 's' : ''}`, severity: 'success' });
    else if (moved) toast({ title: 'Times come from your activity', description: 'Move a block to another category instead, or edit booked hours on the Timesheet tab.', severity: 'info' });
    reload();
  };

  return (
    <div className="flex flex-col gap-4">
      <style>{css}</style>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          size="sm"
          className="w-48"
          aria-label="Colour blocks by"
          value={colorBy}
          onValueChange={(v) => {
            setColorBy(v as ColorBy);
            try {
              localStorage.setItem('ts-color-by', v);
            } catch {
              /* private mode */
            }
          }}
          items={[{ value: 'category', label: 'Colour by category' }, { value: 'repo', label: 'Colour by repository' }]}
        />
        <label className="flex items-center gap-2 text-13 text-ink-2">
          <Switch size="sm" checked={showOther} onCheckedChange={setShowOther} aria-label="Show personal and unassigned activity" />
          Show other activity
        </label>
        <p className="hidden text-13 text-ink-3 desktop:block">In the Resources view, drag a block to another category to recategorize it.</p>
        <span className="ml-auto flex items-center gap-2 text-12 text-ink-3">
          {(loading || refreshing) && <Spinner size="sm" />}
          {report?.pending.length ? `${report.pending.length} day${report.pending.length > 1 ? 's' : ''} computing` : loading ? 'Loading…' : null}
        </span>
      </div>
      {error && <Alert tone="danger" title="Could not load activity" description={error} action={<Button size="sm" variant="outline" onClick={() => reload()}>Retry</Button>} />}
      {/* Clicking an event opens our details sheet instead of the scheduler's plain popover. A press
          that moved is a drag (recategorizing in the Resources view) and is left alone. */}
      <div
        ref={shell}
        className="relative"
        onPointerDownCapture={(e) => (pressAt.current = [e.clientX, e.clientY])}
        onClickCapture={(e) => {
          const [x, y] = pressAt.current ?? [e.clientX, e.clientY];
          if (Math.hypot(e.clientX - x, e.clientY - y) > 4) return;
          if (openFrom(e.target as HTMLElement)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onKeyDownCapture={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && openFrom(e.target as HTMLElement)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <Scheduler
          label="Work activity"
          events={events}
          onEventsChange={onEventsChange}
          resources={resources}
          views={VIEWS}
          view={view}
          onViewChange={setView}
          visibleDate={visible}
          onVisibleDateChange={setVisible}
          areEventsResizable={false}
          canDragEventsFromTheOutside={false}
          externalItems={[]}
          height="calc(100vh - 190px)"
        >
          <CalendarLayout />
        </Scheduler>
        <LoadingOverlay active={loading && !!range} label="Loading activity" />
      </div>
      <BlockDetails open={detailsOpen} onClose={() => setDetailsOpen(false)} value={details} repos={report?.repos ?? {}} meta={meta} onChanged={() => reload()} />
    </div>
  );
}
