export type Source = 'claude' | 'opencode' | 'git' | 'github' | 'calendar';

/** A span of observed activity. Point events (commits) get a lead-in window before them. */
export interface RawEvent {
  source: Source;
  start: number;
  end: number;
  /** cwd for Claude sessions, repo root for commits; absent for calendar events */
  path?: string;
  branch?: string;
  /** Prompts, commit subjects or meeting title */
  texts: string[];
  /** Set by the calendar collector: the meeting's project */
  project?: string;
  outOfOffice?: boolean;
  /** The AI session this span came from */
  session?: SessionRef;
  /** Commit hash (git events) */
  commit?: string;
  /** What the commit changed (git events) */
  change?: CommitChange;
  /** What the AI assistant did in this span: files edited, reads, shell commands (AI session events) */
  work?: SessionWork;
  /** What was done on GitHub (github events) */
  action?: GithubAction;
  /**
   * The parts of [start, end) backed by recorded timestamps, without assumed lead-ins or tails.
   * Absent = the whole span is recorded (calendar events); empty = none of it (commits, GitHub actions).
   */
  measured?: [number, number][];
  /** Rebuilt from history.jsonl: the transcript is gone, so reply timing is assumed (AI session events) */
  fromHistory?: boolean;
  /** Seen but not counted, with the reason shown as a warning (calendar events) */
  skipped?: string;
}

export type GithubActionKind = 'issue' | 'pull' | 'review' | 'comment' | 'release' | 'tag' | 'workflow' | 'approval';

/** One thing done on GitHub: an issue or PR opened, a review, a release, a manual workflow run, a deployment approval. */
export interface GithubAction {
  kind: GithubActionKind;
  /** owner/name */
  repo: string;
  /** What the timesheet shows, e.g. "Approved deployment of main to production" */
  title: string;
  url: string;
}

/** Enough to find an AI coding session again. */
export interface SessionRef {
  id: string;
  source: 'claude' | 'opencode';
  /** Where it ran */
  path: string;
  /** Claude Code config dir holding the transcript (for CLAUDE_CONFIG_DIR) */
  profile?: string;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** Created by the commit */
  isNew?: boolean;
}

/** Lines and files a commit changed. Absent on days computed before it was collected. */
export interface CommitChange {
  added?: number;
  removed?: number;
  /** The most-changed files, at most MAX_COMMIT_FILES */
  files?: FileChange[];
}

/** What an AI assistant did during some session time, from its tool calls. */
export interface SessionWork {
  /** Files it wrote or edited, relative to the session folder where possible, most-changed first */
  edits: FileChange[];
  /** Files read and searches run */
  reads: number;
  shell: number;
  web: number;
  /** Distinct shell commands as program + subcommand only (`pnpm test`, `kubectl logs`), never arguments */
  commands: string[];
}

export interface CommitRef extends CommitChange {
  hash: string;
  repo: string;
  subject: string;
}

export interface Allocation {
  category: string;
  fraction: number;
}

export interface Block {
  id: number;
  start: number;
  end: number;
  kind: 'work' | 'meeting';
  project: string;
  sources: Source[];
  branches: string[];
  paths: string[];
  texts: string[];
  hint: string;
  allocations: Allocation[];
  /** One line on what was done in this block */
  summary?: string;
  sessions?: SessionRef[];
  commits?: CommitRef[];
  actions?: GithubAction[];
  /** The separate pieces of work inside a block, one per folder (sessions and commits there). They may overlap. */
  items?: BlockItem[];
  /** Minutes backed by recorded timestamps only (no lead-ins, padding or gap bridging), unrounded. Absent on days computed before it existed. */
  measured?: number;
  /** Booked at its real rounded hours on top of the daily target instead of counting towards it (set at report time). */
  uncounted?: boolean;
}

/** Activity outside work scope: in a personal folder, or in one no scope rule covers yet. Never booked. */
export interface OtherBlock extends Omit<Block, 'kind' | 'hint' | 'allocations' | 'project'> {
  kind: 'personal' | 'unassigned';
}

export interface BlockItem {
  /** `<block id>.<n>` */
  id: string;
  start: number;
  end: number;
  sources: Source[];
  path?: string;
  branch?: string;
  sessions: SessionRef[];
  commits: CommitRef[];
  /** Absent on days computed before GitHub was a source */
  actions?: GithubAction[];
  /** What the AI assistant did here; absent when nothing was recorded */
  work?: SessionWork;
  /** Prompts (AI sessions), commit subjects or GitHub action titles */
  texts: string[];
  summary?: string;
  /** Other folders whose brief activity was folded into this piece */
  alsoPaths?: string[];
  /** Recorded minutes, like Block.measured */
  measured?: number;
}

export interface Entry {
  project: string;
  category: string;
  capex: boolean;
  /** Real (observed) hours, unrounded */
  real: number;
  /** Hours to book: normalized/rounded, with overrides applied */
  hours: number;
  /** Recorded minutes (see Block.measured), unrounded; absent when a block lacks it */
  measured?: number;
  overridden?: boolean;
  /** Hours of it from blocks that don't count towards the target (already included in `hours`) */
  uncounted?: number;
}

/** What was detected in work scope on a day. */
export interface ActivityCounts {
  prompts: number;
  commits: number;
  /** GitHub actions (issues, reviews, releases, approvals…); absent before GitHub was a source */
  github?: number;
  meetings: number;
  /** Distinct work folders with activity */
  repos: number;
}

export type DayStatus = 'final' | 'partial' | 'today';

export interface StoredDay {
  date: string;
  status: DayStatus;
  computedAt: string;
  blocks: Block[];
  summary: string;
  warnings: string[];
  /** path → resolution key seen while computing, used to detect scope changes */
  paths: Record<string, string>;
  outOfOffice: boolean;
  /** Fingerprint of the settings that shaped this day; a mismatch means recompute */
  computeKey?: string;
  /** Partial because something failed (source, classifier): worth retrying later. Absent on old rows = true. */
  retry?: boolean;
  /** Absent on days computed before counting existed */
  activity?: ActivityCounts;
  /** Personal and unassigned activity, shown apart from work; absent on days computed before it was kept */
  other?: OtherBlock[];
  /** Fingerprint of what the classifier saw; set only when it succeeded, so a recompute with the same input reuses its result */
  classifyKey?: string;
  /** Hours of out-of-office time on a day that is otherwise worked; subtracted from the target */
  oooHours?: number;
}

export interface DayReport extends StoredDay {
  target: number | null;
  /** Kept as it is: never recomputed (submitted, or locked by hand) */
  locked?: boolean;
  /** A holiday from config.holidays: no target */
  holiday?: boolean;
  /** Little recorded work compared to the target; must be confirmed (or hours set) before it is submitted */
  lowActivity?: boolean;
  /** The low-activity day was confirmed as it is */
  confirmed?: boolean;
  /** Reasons the day needs a look, shown with the day and blocking submission where noted */
  flags?: string[];
  entries: Entry[];
  realTotal: number;
  total: number;
  /** Recorded minutes of work, unrounded; absent on days computed before it existed */
  measuredTotal?: number;
}
