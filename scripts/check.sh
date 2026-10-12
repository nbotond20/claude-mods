#!/bin/sh
# Repository checks, run by CI and before a release:
#   - the shared hub block and bin/mods are the same in every mod (scripts/sync-shared.sh --check);
#   - every mod changed since the base ref has a new version, and its CHANGELOG.md has a heading for it;
#   - marketplace.json lists every mod with the version and description of its plugin.json;
#   - timesheet's package.json version matches its plugin.json.
# BASE_REF picks the ref to compare with (default: origin/main; the bump check is skipped when it is missing).
set -u
cd "$(dirname "$0")/.." || exit 2
fail=0
bad() { printf '✗ %s\n' "$*"; fail=1; }

sh scripts/sync-shared.sh --check >/dev/null || bad "shared copies differ: run scripts/sync-shared.sh"

MODS=$(for d in */.claude-plugin/plugin.json; do dirname "$(dirname "$d")"; done)
version() { python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])' 2>/dev/null; }

BASE=${BASE_REF:-origin/main}
if git rev-parse --verify -q "$BASE^{commit}" >/dev/null; then
  for m in $MODS; do
    changed=$(git diff --name-only "$BASE" -- "$m"; git ls-files --others --exclude-standard -- "$m")
    [ -n "$changed" ] || continue
    now=$(version < "$m/.claude-plugin/plugin.json")
    was=$(git show "$BASE:$m/.claude-plugin/plugin.json" 2>/dev/null | version)
    if [ -n "$was" ] && [ "$now" = "$was" ]; then bad "$m changed since $BASE but is still $now: bump .claude-plugin/plugin.json"; fi
    grep -q "^## $now\$" "$m/CHANGELOG.md" 2>/dev/null || bad "$m/CHANGELOG.md has no '## $now' section"
  done
else
  printf '· %s not found: version bump check skipped\n' "$BASE"
fi

python3 - $MODS <<'PY' || fail=1
import json, sys
m = json.load(open('.claude-plugin/marketplace.json'))
listed = {p['name']: p for p in m['plugins']}
bad = False
for mod in sys.argv[1:]:
    p = json.load(open(f'{mod}/.claude-plugin/plugin.json'))
    e = listed.get(mod)
    if not e:
        print(f'✗ marketplace.json does not list {mod}'); bad = True; continue
    for k in ('version', 'description'):
        if e.get(k) != p.get(k):
            print(f'✗ marketplace.json {mod}.{k} is {e.get(k)!r}, plugin.json has {p.get(k)!r}'); bad = True
for name in set(listed) - set(sys.argv[1:]):
    print(f'✗ marketplace.json lists {name}, which has no plugin folder'); bad = True
pk = json.load(open('timesheet/package.json'))['version']
pl = json.load(open('timesheet/.claude-plugin/plugin.json'))['version']
if pk != pl:
    print(f'✗ timesheet/package.json is {pk}, its plugin.json {pl}'); bad = True
sys.exit(1 if bad else 0)
PY

[ "$fail" = 0 ] && echo '✓ checks passed'
exit "$fail"
