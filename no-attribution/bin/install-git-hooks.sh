#!/bin/sh
# Installs the no-attribution git hooks as the global hooks dir (each hook also runs the repository's own).
# Prints: installed | ok | other:<path> (another global hooksPath is set; left alone).
set -e
src="$(cd "$(dirname "$0")/../git-hooks" && pwd)"
dst="$HOME/.claude-shared/no-attribution/git-hooks"
mkdir -p "$dst"
cp "$src"/* "$dst"/
chmod +x "$dst"/*
cur=$(git config --global --get core.hooksPath || true)
if [ -z "$cur" ]; then git config --global core.hooksPath "$dst"; echo installed
elif [ "$cur" = "$dst" ]; then echo ok
else echo "other:$cur"; fi
