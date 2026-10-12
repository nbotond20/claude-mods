#!/bin/sh
# Called by the timesheet mod at session start and by /timesheet install:
#   install-launcher.sh <entry file> [--force]
# Records this plugin's bin/timesheet.js in <entry file>, then puts the launcher in ~/.local/bin/timesheet
# unless a launcher that is not timesheet's own is already there. Prints one word: installed, updated,
# current or foreign, then the PATH note when ~/.local/bin is not on PATH.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FILE=$1
FORCE=${2:-}
mkdir -p "$(dirname "$FILE")" "$HOME/.local/bin"
ENTRY="$ROOT/bin/timesheet.js"
[ "$(cat "$FILE" 2>/dev/null)" = "$ENTRY" ] || printf '%s' "$ENTRY" > "$FILE"

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
