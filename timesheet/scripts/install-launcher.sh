#!/bin/sh
# Called by the timesheet mod at session start and by /timesheet install:
#   install-launcher.sh <entry file> [--force]
# Records this plugin's bin/timesheet.js in <entry file>, then puts the launcher in ~/.local/bin/timesheet
# unless a launcher that is not timesheet's own is already there. Prints one word: installed, updated,
# current or foreign, then the PATH note when ~/.local/bin is not on PATH.
# Never downgrades: an entry that still exists and belongs to a newer version (a profile that already
# updated) is kept, so profiles on different versions do not take turns rewriting it.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FILE=$1
FORCE=${2:-}
mkdir -p "$(dirname "$FILE")" "$HOME/.local/bin"
ENTRY="$ROOT/bin/timesheet.js"

# version of the install that holds <entry>, from its package.json
version_of() { sed -n 's/^ *"version": *"\([0-9.]*\)".*/\1/p' "$(dirname "$(dirname "$1")")/package.json" 2>/dev/null | head -n 1; }
# true when dotted version $1 is newer than $2
newer() { awk -v a="$1" -v b="$2" 'BEGIN { n = split(a, x, "."); m = split(b, y, "."); for (i = 1; i <= (n > m ? n : m); i++) { if (x[i] + 0 != y[i] + 0) exit !(x[i] + 0 > y[i] + 0) } exit 1 }'; }

OLD=$(cat "$FILE" 2>/dev/null)
if [ "$OLD" != "$ENTRY" ]; then
  if [ -n "$OLD" ] && [ -f "$OLD" ] && newer "$(version_of "$OLD")" "$(version_of "$ENTRY")"; then
    ENTRY=$OLD
  else
    printf '%s' "$ENTRY" > "$FILE"
  fi
fi

DEST="$HOME/.local/bin/timesheet"
NEW=$(sed -e "s|__ENTRY_FILE__|$FILE|g" -e "s|__ENTRY__|$ENTRY|g" "$ROOT/scripts/launcher.sh")
if [ -e "$DEST" ] && ! grep -q 'timesheet launcher' "$DEST" 2>/dev/null && [ "$FORCE" != --force ]; then
  echo foreign
elif [ -e "$DEST" ] && [ "$(cat "$DEST")" = "$NEW" ]; then
  echo current
else
  state=installed; [ -e "$DEST" ] && state=updated
  printf '%s\n' "$NEW" > "$DEST" && chmod +x "$DEST" && echo "$state"
fi
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "path: add ~/.local/bin to your PATH (export PATH=\"\$HOME/.local/bin:\$PATH\" in your shell profile)" ;; esac
