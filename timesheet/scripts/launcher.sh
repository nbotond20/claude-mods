#!/bin/sh
# timesheet launcher, installed into ~/.local/bin by scripts/setup.sh or by the timesheet mod
# (scripts/install-launcher.sh), which keeps the current plugin's entry point in __ENTRY_FILE__ so the
# launcher survives plugin updates. TIMESHEET_ENTRY overrides both (e.g. a development checkout).
# Version managers like fnm (--use-on-cd) or nvm switch Node per directory and keep
# separate global packages per version, so a plain `npm link` only works in some
# directories. This runs timesheet with the current Node when it is new enough,
# otherwise with the newest installed Node >= 22.18 via fnm.
ENTRY="${TIMESHEET_ENTRY:-}"
[ -z "$ENTRY" ] && [ -f "__ENTRY_FILE__" ] && ENTRY=$(cat "__ENTRY_FILE__")
[ -z "$ENTRY" ] && ENTRY="__ENTRY__"
# A plugin update deletes the old version's folder: fall back to the newest timesheet installed in any profile.
if [ -z "${TIMESHEET_ENTRY:-}" ] && [ ! -f "$ENTRY" ]; then
  best=; bestv=
  for f in "__ENTRY__" "$HOME"/.claude*/plugins/cache/*/timesheet/*/bin/timesheet.js; do
    [ -f "$f" ] || continue
    v=$(sed -n 's/^ *"version": *"\([0-9.]*\)".*/\1/p' "$(dirname "$(dirname "$f")")/package.json" 2>/dev/null | head -n 1)
    if [ -z "$best" ] || printf '%s\n%s\n' "$bestv" "$v" | awk -F. 'NR==1{split($0,a,".")} NR==2{for(i=1;i<=4;i++){if(a[i]+0!=$i+0){exit !($i+0>a[i]+0)}} exit 1}'; then
      best=$f; bestv=$v
    fi
  done
  if [ -n "$best" ]; then
    ENTRY=$best
    printf '%s' "$ENTRY" > "__ENTRY_FILE__" 2>/dev/null
  fi
fi

new_enough() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null
}

if command -v node >/dev/null 2>&1 && new_enough node; then
  exec node --experimental-sqlite --no-warnings "$ENTRY" "$@"
fi
if command -v fnm >/dev/null 2>&1; then
  for v in $(fnm list 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sort -t. -k1,1Vr -k2,2nr -k3,3nr); do
    if fnm exec --using="$v" node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null; then
      exec fnm exec --using="$v" node --experimental-sqlite --no-warnings "$ENTRY" "$@"
    fi
  done
fi
echo "timesheet: needs Node >= 22.18 (current: $(node -v 2>/dev/null || echo none)). Install one, e.g. \`fnm install 22\`." >&2
exit 1
