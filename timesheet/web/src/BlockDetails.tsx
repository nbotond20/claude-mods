import { useState, type ReactNode } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Icon, useToast } from '@loam/ui-web';
import { fmtMin, isOther, OTHER_LABEL, type Block, type BlockItem, type Meta, type OtherBlock, type RepoInfo, type SessionRef } from './api';
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

/** Where a block happened and what it did: a wide dialog with the pieces of work next to their context. */
export function BlockDetails({ open, onClose, value, repos, meta }: { open: boolean; onClose: () => void; value: BlockRef | null; repos: Record<string, RepoInfo>; meta: Meta }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" onOpenAutoFocus={(e) => e.preventDefault()} className="max-h-[calc(100dvh-2rem)] max-w-[min(62rem,100%)] gap-0 overflow-hidden p-0">
        {value && <Body value={value} repos={repos} meta={meta} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ value: { date, block: b, itemId }, repos, meta, onClose }: { value: BlockRef; repos: Record<string, RepoInfo>; meta: Meta; onClose: () => void }) {
  const { toast } = useToast();
  const hues = new Map(meta.categories.map((c) => [c.name, c.hue]));
  const blockRepos = [...new Map([...b.paths, ...(b.commits ?? []).map((c) => c.repo)].map((p) => repoOf(repos, p)).map((r) => [r.root, r])).values()];
  const items = b.items ?? [];
  const branches = b.branches.filter((x) => x !== 'HEAD');
  const other = isOther(b);
  const title = b.summary || (b.kind === 'meeting' ? b.texts[0] : null) || 'Work';
  const sessionCount = items.reduce((n, it) => n + it.sessions.length, 0);
  const commitCount = items.reduce((n, it) => n + it.commits.length, 0);

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
      <DialogHeader className="gap-3 border-b border-line px-6 pb-5 pt-6">
        <DialogTitle className="pr-10 text-20 leading-snug">{title}</DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-13">
          <span>{dayTitle(date)}</span>
          <Dot />
          <span className="font-mono tabular-nums">
            {time(b.start)}–{time(b.end)}
          </span>
          <Dot />
          <span className="font-medium text-ink">{duration(b.end - b.start)}</span>
          {b.measured !== undefined && (
            <>
              <Dot />
              <span title="Time between recorded timestamps only: no lead-ins, padding or rounding">{fmtMin(b.measured)} recorded</span>
            </>
          )}
        </DialogDescription>
        <div className="flex flex-wrap items-center gap-2 text-13">
          {other ? (
            <>
              <Pill>
                <span className="size-2.5 rounded-full border border-dashed border-ink-3" />
                {OTHER_LABEL[b.kind]}
              </Pill>
              <span className="text-ink-3">{b.kind === 'unassigned' ? 'Not booked: no scope rule covers this folder yet.' : 'Personal: never booked.'}</span>
              {b.kind === 'unassigned' && (
                <a href="#settings/scope" onClick={onClose} className="font-medium underline underline-offset-2 hover:no-underline">
                  Assign in settings
                </a>
              )}
            </>
          ) : (
            b.allocations.map((a) => {
              const h = hues.get(a.category);
              return (
                <Pill key={a.category}>
                  <span className="size-2.5 rounded-full bg-line-strong" style={h == null ? undefined : { background: hueColor(h) }} />
                  {a.category}
                  {a.fraction < 1 && <span className="text-ink-3">{Math.round(a.fraction * 100)}%</span>}
                </Pill>
              );
            })
          )}
        </div>
      </DialogHeader>

      <div className="grid min-h-0 flex-1 overflow-y-auto tablet:grid-cols-[minmax(0,1fr)_18rem] tablet:overflow-hidden">
        {/* Context: where the block happened */}
        <aside className="flex flex-col gap-5 border-b border-line bg-surface-2/40 px-6 py-5 tablet:order-2 tablet:overflow-y-auto tablet:border-b-0 tablet:border-l">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-13">
            {!other && <Fact label="Project">{b.project}</Fact>}
            <Fact label="Source">{b.kind === 'meeting' ? 'Meeting' : b.sources.map(sourceLabel).join(', ')}</Fact>
            {sessionCount > 0 && <Fact label="Sessions">{sessionCount}</Fact>}
            {commitCount > 0 && <Fact label="Commits">{commitCount}</Fact>}
          </dl>

          {blockRepos.length > 0 && (
            <Section title={blockRepos.length > 1 ? 'Repositories' : 'Repository'} count={blockRepos.length > 1 ? String(blockRepos.length) : undefined}>
              <ul className="-mx-2 flex flex-col">
                {blockRepos.map((r) => (
                  <li key={r.root} className="flex min-w-0 flex-col rounded-md px-2 py-1.5 hover:bg-hover" title={r.root}>
                    {r.url ? (
                      <a href={r.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 text-13 font-medium text-ink hover:underline hover:underline-offset-2">
                        <span className="truncate">{r.name}</span>
                        <Icon name="external-link" size={12} className="shrink-0 text-ink-3" />
                      </a>
                    ) : (
                      <span className="truncate text-13 font-medium">{r.name}</span>
                    )}
                    <span className="truncate font-mono text-11 text-ink-3 [direction:rtl] text-left">{'\u200e' + parentDir(r.root)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {branches.length > 0 && (
            <Section title={branches.length > 1 ? 'Branches' : 'Branch'} count={branches.length > 1 ? String(branches.length) : undefined}>
              <div className="flex flex-wrap gap-1.5 text-12">
                {branches.map((x) => (
                  <Chip key={x} icon="branch" mono>
                    {x}
                  </Chip>
                ))}
              </div>
            </Section>
          )}
        </aside>

        {/* Main: what happened */}
        <main className="flex min-w-0 flex-col gap-4 px-6 py-5 tablet:order-1 tablet:overflow-y-auto">
          {items.length > 0 && (
            <Section title="What happened" count={items.length > 1 ? `${items.length} pieces, may overlap` : undefined}>
              <ul className="flex flex-col gap-3">
                {items.map((it) => (
                  <ItemCard key={it.id} item={it} repos={repos} highlight={it.id === itemId} onResume={resume} />
                ))}
              </ul>
            </Section>
          )}
          {b.kind === 'meeting' && b.texts.length > 0 && (
            <Section title="Meeting">
              <p className="text-14">{b.texts.join(' · ')}</p>
            </Section>
          )}
          {items.length === 0 && b.kind !== 'meeting' && <p className="text-13 text-ink-3">No detailed activity recorded for this block.</p>}
        </main>
      </div>
    </>
  );
}

const SESSION_PREVIEW = 6;

function ItemCard({ item: it, repos, highlight, onResume }: { item: BlockItem; repos: Record<string, RepoInfo>; highlight: boolean; onResume: (s: SessionRef) => void }) {
  const [showPrompts, setShowPrompts] = useState(false);
  const [allSessions, setAllSessions] = useState(false);
  const repo = it.path ? repoOf(repos, it.path) : null;
  const actions = it.actions ?? [];
  const notPrompts = new Set([...it.commits.map((c) => c.subject), ...actions.map((a) => a.title)]);
  const prompts = it.texts.filter((t) => !notPrompts.has(t));
  const also = [...new Set((it.alsoPaths ?? []).map((p) => repoOf(repos, p).name))].filter((n) => n !== repo?.name);
  const profiles = [...new Set(it.sessions.map((x) => x.profile?.split('/').pop()).filter(Boolean))];
  const sessionSources = [...new Set(it.sessions.map((x) => sourceLabel(x.source)))];
  const sessions = allSessions ? it.sessions : it.sessions.slice(0, SESSION_PREVIEW);
  const ref = (el: HTMLLIElement | null) => {
    if (el && highlight) el.scrollIntoView({ block: 'nearest' });
  };

  return (
    <li ref={ref} className={`overflow-hidden rounded-lg border bg-surface ${highlight ? 'border-accent ring-1 ring-accent' : 'border-line'}`}>
      <div className="flex flex-col gap-2 px-4 pb-3 pt-3.5">
        <div className="flex items-start justify-between gap-4">
          <span className="text-15 font-medium leading-snug">{it.summary ?? repo?.name ?? 'Work'}</span>
          <span className="shrink-0 pt-0.5 text-right text-12 text-ink-3">
            <span className="font-mono tabular-nums">
              {time(it.start)}–{time(it.end)}
            </span>
            <span className="block font-medium text-ink-2">{duration(it.end - it.start)}</span>
            {it.measured !== undefined && <span className="block tabular-nums">{fmtMin(it.measured)} recorded</span>}
          </span>
        </div>
        {(repo || it.branch || also.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 text-12">
            {repo && <Chip icon="folder">{repo.name}</Chip>}
            {it.branch && <Chip icon="branch" mono>{it.branch}</Chip>}
            {also.length > 0 && <span className="text-ink-3">+ {also.join(', ')}</span>}
          </div>
        )}
      </div>

      {it.commits.length > 0 && (
        <Group label={`${it.commits.length} commit${it.commits.length > 1 ? 's' : ''}`}>
          <ul className="flex flex-col gap-1.5 text-13">
            {it.commits.map((c) => {
              const url = repos[c.repo]?.url;
              return (
                <li key={c.hash} className="grid grid-cols-[4.5rem_1fr] items-baseline gap-2">
                  {url ? (
                    <a href={`${url}/commit/${c.hash}`} target="_blank" rel="noreferrer" className="font-mono text-12 text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink">
                      {c.hash.slice(0, 7)}
                    </a>
                  ) : (
                    <span className="font-mono text-12 text-ink-3">{c.hash.slice(0, 7)}</span>
                  )}
                  <span className="line-clamp-2 min-w-0 break-words text-ink-2" title={c.subject}>{c.subject}</span>
                </li>
              );
            })}
          </ul>
        </Group>
      )}

      {actions.length > 0 && (
        <Group label={`${actions.length} GitHub action${actions.length > 1 ? 's' : ''}`}>
          <ul className="flex flex-col gap-1.5 text-13">
            {actions.map((a) => (
              <li key={`${a.kind}:${a.url}`} className="min-w-0">
                <a href={a.url} target="_blank" rel="noreferrer" className="line-clamp-2 break-words text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink" title={`${a.repo}: ${a.title}`}>
                  {a.title}
                </a>
              </li>
            ))}
          </ul>
        </Group>
      )}

      {it.sessions.length > 0 && (
        <Group label={`${it.sessions.length} ${sessionSources.join(' / ')} session${it.sessions.length > 1 ? 's' : ''}${profiles.length === 1 ? ` · ${profiles[0]}` : ''}`} hint="Click to copy the resume command">
          <div className="flex flex-wrap gap-1.5">
            {sessions.map((x) => (
              <button
                key={`${x.source}:${x.id}`}
                type="button"
                onClick={() => onResume(x)}
                title={`Copy the command that resumes ${sourceLabel(x.source)} session ${x.id}`}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2 font-mono text-12 text-ink-2 hover:border-line-strong hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {x.source === 'opencode' && <span className="font-sans text-11 text-ink-3">OC</span>}
                {x.id.slice(0, 8)}
                {profiles.length > 1 && x.profile && <span className="font-sans text-11 text-ink-3">{x.profile.split('/').pop()}</span>}
                <Icon name="copy" size={12} className="text-ink-3" />
              </button>
            ))}
            {it.sessions.length > SESSION_PREVIEW && (
              <Button size="xs" variant="ghost" onClick={() => setAllSessions(!allSessions)}>
                {allSessions ? 'Show fewer' : `+${it.sessions.length - SESSION_PREVIEW} more`}
              </Button>
            )}
          </div>
        </Group>
      )}

      {prompts.length > 0 && (
        <div className="border-t border-line px-4 py-2">
          <Button size="xs" variant="ghost" className="-ml-2" trailingIcon={showPrompts ? 'chevron-up' : 'chevron-down'} onClick={() => setShowPrompts(!showPrompts)}>
            {showPrompts ? 'Hide' : 'Show'} {prompts.length} prompt{prompts.length > 1 ? 's' : ''}
          </Button>
          {showPrompts && (
            <ol className="mb-1 mt-1 flex list-decimal flex-col gap-1.5 pl-5 text-13 text-ink-2">
              {prompts.map((p, i) => (
                <li key={i} className="break-words">{p}</li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

/** A labelled strip inside an item card, separated from the one above. */
function Group({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
      <span className="flex items-baseline justify-between gap-3 text-12 text-ink-3">
        <span className="font-medium">{label}</span>
        {hint && <span className="hidden text-11 tablet:inline">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 font-medium">{children}</span>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-12 text-ink-3">{label}</dt>
      <dd className="truncate font-medium">{children}</dd>
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

function Section({ title, count, children }: { title: string; count?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="flex items-baseline gap-2 text-12 font-semibold uppercase tracking-wide text-ink-3">
        {title}
        {count && <span className="font-normal normal-case tracking-normal">{count}</span>}
      </h3>
      {children}
    </section>
  );
}
