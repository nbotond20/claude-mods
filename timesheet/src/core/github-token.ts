/**
 * What a GitHub token for timesheet needs, and a link that opens GitHub's token form with it
 * filled in. No Node imports: the web app uses this too.
 */

export type PermissionGroup = 'delivery' | 'collaboration' | 'required';

/** Repository permissions, all read-only; `param` is the name in GitHub's token template URL. */
export const GITHUB_PERMISSIONS: { name: string; param: string; why: string; group: PermissionGroup }[] = [
  { name: 'Actions', param: 'actions', why: 'workflows you ran by hand, and who approved a deployment', group: 'delivery' },
  { name: 'Contents', param: 'contents', why: 'releases and tags', group: 'delivery' },
  { name: 'Deployments', param: 'deployments', why: 'deployments waiting for review and when they were approved', group: 'delivery' },
  { name: 'Environments', param: 'environments', why: 'which environments require a reviewer', group: 'delivery' },
  { name: 'Issues', param: 'issues', why: 'titles of issues you opened or commented on', group: 'collaboration' },
  { name: 'Pull requests', param: 'pull_requests', why: 'titles of PRs you opened or reviewed', group: 'collaboration' },
  { name: 'Metadata', param: 'metadata', why: 'required by GitHub for every token', group: 'required' },
];

const GROUP_TITLES: Record<PermissionGroup, string> = { delivery: 'Releases & deployments', collaboration: 'Issues & pull requests', required: 'Always required' };

/** GitHub caps fine-grained tokens at 366 days (organizations may allow less). */
export const GITHUB_TOKEN_DAYS = 366;

/**
 * GitHub's "new fine-grained token" page, pre-filled with the name, owner, expiry and read-only
 * permissions. Repository access cannot be pre-filled: choose "All repositories" there.
 */
export function githubTokenUrl(owner?: string): string {
  const params = new URLSearchParams({
    name: `timesheet${owner ? ` ${owner}` : ''}`.slice(0, 40),
    description: 'Read-only: lets timesheet count issues, reviews, releases, manual workflow runs and deployment approvals.',
    ...(owner?.trim() ? { target_name: owner.trim() } : {}),
    expires_in: String(GITHUB_TOKEN_DAYS),
  });
  for (const p of GITHUB_PERMISSIONS) params.set(p.param, 'read');
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}

/** Step-by-step instructions for the terminal. */
export function githubTokenHelp(owner?: string): string {
  const width = Math.max(...GITHUB_PERMISSIONS.map((p) => p.name.length));
  const groups = (Object.entries(GROUP_TITLES) as [PermissionGroup, string][])
    .map(([g, title]) => `       ${title}\n${GITHUB_PERMISSIONS.filter((p) => p.group === g).map((p) => `         ${p.name.padEnd(width)}  ${p.why}`).join('\n')}`)
    .join('\n');
  return `GitHub needs a read-only fine-grained token for each account or organization you work in.

  1. Open this link. It fills in the name, ${owner ? `owner (${owner})` : 'owner (pick your account or the organization)'}, expiry and permissions:
     ${githubTokenUrl(owner)}
  2. Repository access: choose "All repositories" (this part cannot be pre-filled).
  3. Check that the repository permissions are all Read-only:
${groups}
  4. Generate the token and copy it (github_pat_…). An organization may have to approve it first.`;
}
