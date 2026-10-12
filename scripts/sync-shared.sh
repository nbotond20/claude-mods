#!/bin/sh
# Copies the shared blocks into every mod: shared/mods-hub.ts between the "mods hub" markers of each
# hooks module, and bin/mods to <mod>/bin/mods. `--check` changes nothing and fails when a copy differs.
set -eu
cd "$(dirname "$0")/.."
check=0
[ "${1:-}" = "--check" ] && check=1
python3 - "$check" <<'PY'
import glob, os, re, shutil, sys
check = sys.argv[1] == '1'
block = open('shared/mods-hub.ts').read().rstrip('\n') + '\n'
start, end = block.splitlines()[0], block.rstrip('\n').splitlines()[-1]
pat = re.compile(re.escape(start) + r'.*?' + re.escape(end) + r'\n', re.S)
stale = []
mods = sorted(os.path.dirname(p) for p in glob.glob('*/.claude-plugin/plugin.json'))
for mod in [os.path.dirname(m) for m in mods]:
    src = next(iter(glob.glob(f'{mod}/hooks/register.ts*')), None)
    if not src:
        continue
    text = open(src).read()
    if not pat.search(text):
        print(f'{src}: no mods hub block (paste shared/mods-hub.ts after modsHome)', file=sys.stderr)
        stale.append(src)
        continue
    new = pat.sub(lambda _: block, text, count=1)
    if new != text:
        stale.append(src)
        if not check:
            open(src, 'w').write(new)
    dst = f'{mod}/bin/mods'
    if not os.path.exists(dst) or open(dst, 'rb').read() != open('bin/mods', 'rb').read():
        stale.append(dst)
        if not check:
            os.makedirs(f'{mod}/bin', exist_ok=True)
            shutil.copyfile('bin/mods', dst)
            os.chmod(dst, 0o755)
if stale:
    print(('out of sync: ' if check else 'updated: ') + ', '.join(stale))
    sys.exit(1 if check else 0)
PY
