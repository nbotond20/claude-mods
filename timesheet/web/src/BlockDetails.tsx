import { useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Icon, Switch, useToast } from '@loam/ui-web';
import { api, fmtMin, isOther, OTHER_LABEL, type Block, type BlockItem, type Meta, type OtherBlock, type RepoInfo, type SessionRef } from './api';
import { hueColor } from './colors';

export interface BlockRef {
  date: string;
  block: Block | OtherBlock;
  /** Open with this item highlighted */
  itemId?: string;
}

const time = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const duration = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim();
};
const dayTitle = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const shellQuote = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
const parentDir = (p: string) => p.replace(/\/[^/]+\/?$/, '') || p;
const sourceLabel = (s: string) => ({ claude: 'Claude Code', opencode: 'OpenCode', git: 'Git', github: 'GitHub', calendar: 'Calendar' })[s] ?? s;

export function repoOf(repos: Record<string, RepoInfo>, path: string): RepoInfo {
  return repos[path] ?? { root: tilde(path), name: path.split('/').pop() ?? path, url: null };
}

/** Where a block happened and what it did. Quiet by default: one line per piece of work, details on click. */
export function BlockDetails({ open, onClose, value, repos, meta, onChanged }: { open: boolean; onClose: () => void; value: BlockRef | null; repos: Record<string, RepoInfo>; meta: Meta; onChanged?: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" onOpenAutoFocus={(e) => e.preventDefault()} className="max-h-[calc(100dvh-2rem)] max-w-[min(46rem,100%)] gap-0 overflow-hidden p-0">
        {value && <Body key={`${value.date}:${value.block.id}`} value={value} repos={repos} meta={meta} onClose={onClose} onChanged={onChanged} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ value: { date, block: b, itemId }, repos, meta, onClose, onChanged }: { value: BlockRef; repos: Record<string, RepoInfo>; meta: Meta; onClose: () => void; onChanged?: () => void }) {
  const { toast } = useToast();
  const [counts, setCounts] = useState(!(b as Block).uncounted);
  const [saving, setSaving] = useState(false);
  const setCounted = async (counted: boolean) => {
    setSaving(true);
    try {
      await api('/api/block-count', { body: { date, blockId: b.id, counted } });
      setCounts(counted);
      onChanged?.();
    } catch (err) {
      toast({ title: 'Could not change the meeting', description: (err as Error).message, severity: 'error' });
    } finally {
      setSaving(false);
    }
  };
  const hues = new Map(meta.categories.map((c) => [c.name, c.hue]));
  const blockRepos = [...new Map([...b.paths, ...(b.commits ?? []).map((c) => c.repo)].map((p) => repoOf(repos, p)).map((r) => [r.root, r])).values()];
  const items = b.items ?? [];
  const branches = b.branches.filter((x) => x !== 'HEAD');
  const other = isOther(b);
  const title = b.summary || (b.kind === 'meeting' ? b.texts[0] : null) || 'Work';
  const source = b.kind === 'meeting' ? 'Meeting' : b.sources.map(sourceLabel).join(', ');

  const resume = async (s: SessionRef) => {
    const cmd = s.source === 'claude' ? `cd ${shellQuote(s.path)} && ${s.profile ? `CLAUDE_CONFIG_DIR=${shellQuote(s.profile)} ` : ''}claude --resume ${s.id}` : `cd ${shellQuote(s.path)} && opencode --session ${s.id}`;
    try {
      await navigator.clipboard.writeText(cmd);
      toast({ title: 'Resume command copied', description: cmd, severity: 'success' });
    } catch {
      toast({ title: 'Clipboard not available', description: cmd, severity: 'error' });
    }
  };

  return (
    <>
      <DialogHeader className="gap-2 border-b border-line px-6 pb-4 pt-5">
        <DialogTitle className="pr-10 text-18 leading-snug">{title}</DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-13">
          <span>{dayTitle(date)}</span>
          <Dot />
          <span className="font-mono tabular-nums">
            {time(b.start)}–{time(b.end)}
          </span>
          <Dot />
          <span className="font-medium text-ink" title={b.measured !== undefined ? `${fmtMin(b.measured)} recorded between timestamps (no lead-ins, padding or rounding)` : undefined}>
            {duration(b.end - b.start)}
          </span>
        </DialogDescription>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-13">
          {other ? (
            <span className="inline-flex items-center gap-1.5 text-ink-2">
              <span className="size-2 rounded-full border border-dashed border-ink-3" />
              <span className="font-medium text-ink">{OTHER_LABEL[b.kind]}</span>
              <span className="text-ink-3">{b.kind === 'unassigned' ? '· no scope rule covers this folder yet' : '· never booked'}</span>
              {b.kind === 'unassigned' && (
                <a href="#settings/scope" onClick={onClose} className="ml-1 font-medium text-ink underline underline-offset-2 hover:no-underline">
                  Assign
                </a>
              )}
            </span>
          ) : (
            <>
              {b.project && <span className="font-medium text-ink">{b.project}</span>}
              {b.allocations.map((a) => {
                const h = hues.get(a.category);
                return (
                  <span key={a.category} className="inline-flex items-center gap-1.5 text-ink-2">
                    <span className="size-2 rounded-full bg-line-strong" style={h == null ? undefined : { background: hueColor(h) }} />
                    {a.category}
                    {a.fraction < 1 && <span className="tabular-nums text-ink-3">{Math.round(a.fraction * 100)}%</span>}
                  </span>
                );
              })}
            </>
          )}
        </div>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
        {items.length > 0 && (
          <ul className="flex flex-col">
            {items.map((it) => (
              <ItemRow key={it.id} item={it} repos={repos} highlight={it.id === itemId} startOpen={it.id === itemId || items.length === 1} onResume={resume} />
            ))}
          </ul>
        )}
        {b.kind === 'meeting' && b.texts.length > 0 && <p className="px-3 py-2 text-14 text-ink-2">{b.texts.join(' · ')}</p>}
        {b.kind === 'meeting' && (
          <label className="mx-3 my-2 flex items-center justify-between gap-4 rounded-md border border-line px-3 py-2.5 text-13">
            <span className="flex flex-col">
              <span className="font-medium text-ink">Counts towards the daily target</span>
              <span className="text-ink-3">{counts ? 'Part of the normal day.' : 'Booked at its real time on top of the day.'}</span>
            </span>
            <Switch checked={counts} disabled={saving} onCheckedChange={setCounted} aria-label="Counts towards the daily target" />
          </label>
        )}
        {items.length === 0 && b.kind !== 'meeting' && <p className="px-3 py-2 text-13 text-ink-3">No detailed activity recorded for this block.</p>}

        {(blockRepos.length > 0 || branches.length > 0 || source) && (
          <Disclosure label="Context" summary={[source, plural(blockRepos.length, 'repo'), plural(branches.length, 'branch', 'branches')].filter(Boolean).join(' · ')}>
            <div className="flex flex-col gap-4 pb-1 text-13">
              {blockRepos.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {blockRepos.map((r) => (
                    <li key={r.root} className="flex min-w-0 items-baseline gap-2" title={r.root}>
                      {r.url ? (
                        <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 font-medium text-ink hover:underline hover:underline-offset-2">
                          {r.name}
                          <Icon name="external-link" size={11} className="text-ink-3" />
                        </a>
                      ) : (
                        <span className="shrink-0 font-medium">{r.name}</span>
                      )}
                      <span className="truncate font-mono text-11 text-ink-3">{parentDir(r.root)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {branches.length > 0 && (
                <div className="flex flex-wrap gap-1.5 text-12">
                  {branches.map((x) => (
                    <Chip key={x} icon="branch" mono>
                      {x}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          </Disclosure>
        )}
      </div>
    </>
  );
}

const SESSION_PREVIEW = 6;
const plural = (n: number, one: string, many = `${one}s`) => (n ? `${n} ${n === 1 ? one : many}` : '');

/** One piece of work: a single scannable line, expanding to commits, actions, sessions and prompts. */
function ItemRow({ item: it, repos, highlight, startOpen, onResume }: { item: BlockItem; repos: Record<string, RepoInfo>; highlight: boolean; startOpen: boolean; onResume: (s: SessionRef) => void }) {
  const [open, setOpen] = useState(startOpen);
  const [showPrompts, setShowPrompts] = useState(false);
  const [allSessions, setAllSessions] = useState(false);
  const repo = it.path ? repoOf(repos, it.path) : null;
  const actions = it.actions ?? [];
  const notPrompts = new Set([...it.commits.map((c) => c.subject), ...actions.map((a) => a.title)]);
  const prompts = it.texts.filter((t) => !notPrompts.has(t));
  const also = [...new Set((it.alsoPaths ?? []).map((p) => repoOf(repos, p).name))].filter((n) => n !== repo?.name);
  const profiles = [...new Set(it.sessions.map((x) => x.profile?.split('/').pop()).filter(Boolean))];
  const sessions = allSessions ? it.sessions : it.sessions.slice(0, SESSION_PREVIEW);
  const counts = [plural(it.commits.length, 'commit'), plural(actions.length, 'action'), plural(it.sessions.length, 'session')].filter(Boolean).join(' · ');
  const hasMore = it.commits.length + actions.length + it.sessions.length + prompts.length > 0;
  const ref = (el: HTMLLIElement | null) => {
    if (el && highlight) el.scrollIntoView({ block: 'nearest' });
  };
  const when = `${time(it.start)}–${time(it.end)}${it.measured !== undefined ? ` · ${fmtMin(it.measured)} recorded` : ''}`;

  return (
    <li ref={ref} className={`rounded-lg ${open ? 'bg-surface-2/50' : ''} ${highlight ? 'ring-1 ring-accent' : ''}`}>
      <button
        type="button"
        disabled={!hasMore}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:hover:bg-transparent"
      >
        <Icon name="chevron-right" size={14} className={`mt-1 shrink-0 text-ink-3 transition-transform ${open ? 'rotate-90' : ''} ${hasMore ? '' : 'invisible'}`} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-14 font-medium leading-snug">{it.summary ?? repo?.name ?? 'Work'}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-12 text-ink-3">
            {repo && <span className="text-ink-2">{repo.name}</span>}
            {also.length > 0 && <span title={also.join(', ')}>+{also.length}</span>}
            {it.branch && (
              <span className="inline-flex items-center gap-0.5 font-mono text-11">
                <Icon name="branch" size={11} />
                {it.branch}
              </span>
            )}
            {counts && !open && (
              <>
                {(repo || it.branch) && <Dot />}
                <span>{counts}</span>
              </>
            )}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-13 font-medium tabular-nums text-ink-2" title={when}>
          {duration(it.end - it.start)}
        </span>
      </button>

      {open && hasMore && (
        <div className="flex flex-col gap-3 pb-3 pl-9 pr-3 text-13">
          {it.commits.length > 0 && (
            <ul className="flex flex-col gap-1">
              {it.commits.map((c) => {
                const url = repos[c.repo]?.url;
                const hash = c.hash.slice(0, 7);
                return (
                  <li key={c.hash} className="flex min-w-0 items-baseline gap-2.5">
                    {url ? (
                      <a href={`${url}/commit/${c.hash}`} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-11 text-ink-3 hover:text-ink hover:underline">
                        {hash}
                      </a>
                    ) : (
                      <span className="shrink-0 font-mono text-11 text-ink-3">{hash}</span>
                    )}
                    <span className="min-w-0 truncate text-ink-2" title={c.subject}>
                      {c.subject}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {actions.length > 0 && (
            <ul className="flex flex-col gap-1">
              {actions.map((a) => (
                <li key={`${a.kind}:${a.url}`} className="flex min-w-0 items-baseline gap-2.5">
                  <span className="shrink-0 text-11 text-ink-3">GitHub</span>
                  <a href={a.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-ink-2 hover:text-ink hover:underline" title={`${a.repo}: ${a.title}`}>
                    {a.title}
                  </a>
                </li>
              ))}
            </ul>
          )}

          {(it.sessions.length > 0 || prompts.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {sessions.map((x) => (
                <button
                  key={`${x.source}:${x.id}`}
                  type="button"
                  onClick={() => onResume(x)}
                  title={`${sourceLabel(x.source)} session${x.profile ? ` · ${x.profile.split('/').pop()}` : ''}. Click to copy the resume command`}
                  className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-11 text-ink-3 hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <Icon name="copy" size={11} />
                  {x.source === 'opencode' && <span className="font-sans">OC</span>}
                  {x.id.slice(0, 8)}
                  {profiles.length > 1 && x.profile && <span className="font-sans">{x.profile.split('/').pop()}</span>}
                </button>
              ))}
              {it.sessions.length > SESSION_PREVIEW && (
                <button type="button" onClick={() => setAllSessions(!allSessions)} className="h-6 rounded-md px-1.5 text-11 text-ink-3 hover:bg-hover hover:text-ink">
                  {allSessions ? 'fewer' : `+${it.sessions.length - SESSION_PREVIEW}`}
                </button>
              )}
              {prompts.length > 0 && (
                <button
                  type="button"
                  aria-expanded={showPrompts}
                  onClick={() => setShowPrompts(!showPrompts)}
                  className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-11 text-ink-3 hover:bg-hover hover:text-ink"
                >
                  {plural(prompts.length, 'prompt')}
                  <Icon name="chevron-down" size={11} className={`transition-transform ${showPrompts ? 'rotate-180' : ''}`} />
                </button>
              )}
            </div>
          )}

          {showPrompts && (
            <ol className="flex list-decimal flex-col gap-1.5 border-l border-line pl-6 text-ink-2">
              {prompts.map((p, i) => (
                <li key={i} className="break-words">
                  {p}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

/** A collapsed section with a one-line summary; the body shows on click. */
function Disclosure({ label, summary, children }: { label: string; summary?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 border-t border-line pt-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-12 hover:bg-hover">
        <Icon name="chevron-right" size={14} className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="font-medium text-ink-2">{label}</span>
        {summary && <span className="truncate text-ink-3">{summary}</span>}
      </button>
      {open && <div className="pl-9 pr-3 pt-1">{children}</div>}
    </div>
  );
}

const Dot = () => <span aria-hidden className="text-ink-3/60">·</span>;

function Chip({ icon, mono, children }: { icon: 'folder' | 'branch'; mono?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-surface-2 px-2 text-ink-2 ${mono ? 'font-mono text-11' : ''}`}>
      <Icon name={icon} size={12} className="shrink-0 text-ink-3" />
      <span className="truncate">{children}</span>
    </span>
  );
}
