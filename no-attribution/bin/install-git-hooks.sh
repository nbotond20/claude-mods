#!/bin/sh
# Installs (or, with "remove", uninstalls) the no-attribution git hooks as the global hooks dir.
# Each hook also runs the repository's own, so existing repo hooks keep working.
# Prints: installed | ok | other:<path> (another global hooksPath is set; left alone) | removed | absent
set -e
if [ -n "$CLAUDE_MODS_HOME" ]; then base="${CLAUDE_MODS_HOME%/}"
elif [ -d "$HOME/.claude-shared" ]; then base="$HOME/.claude-shared"
else base="$HOME/.claude-mods"; fi
src="$(cd "$(dirname "$0")/../git-hooks" && pwd)"
dst="$base/no-attribution/git-hooks"
cur=$(git config --global --get core.hooksPath || true)
if [ "$1" = "remove" ]; then
  if [ "$cur" = "$dst" ]; then git config --global --unset core.hooksPath; echo removed; else echo absent; fi
  exit 0
fi
mkdir -p "$dst"
cp "$src"/* "$dst"/
chmod +x "$dst"/*
if [ -z "$cur" ]; then git config --global core.hooksPath "$dst"; echo installed
elif [ "$cur" = "$dst" ]; then echo ok
else echo "other:$cur"; fi
