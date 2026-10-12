#!/usr/bin/env bash
# Timesheet setup: checks prerequisites, installs the `timesheet` command and the
# Claude Code skill, then runs the setup wizard. Safe to re-run.
#
#   ./scripts/setup.sh            # from a checkout or an unpacked release
#   ./scripts/setup.sh --web      # run the wizard in the browser instead of the terminal
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIZARD="terminal"
[[ "${1:-}" == "--web" ]] && WIZARD="web"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

bold "Checking prerequisites"
command -v node >/dev/null || die "Node.js is required (>= 22.18): https://nodejs.org or \`brew install node\`"
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || die "Node $NODE_VERSION is too old; timesheet needs >= 22.18 (built-in TypeScript + SQLite)"
ok "Node $NODE_VERSION"
command -v git >/dev/null && ok "git" || warn "git not found: commits will not be counted"
if command -v claude >/dev/null; then ok "Claude Code CLI (used for classification and daily summaries)"; else warn "claude CLI not found: classification falls back to rules (set classifier.command later)"; fi
[[ -d "${XDG_DATA_HOME:-$HOME/.local/share}/opencode" ]] && ok "OpenCode data found"
[[ -f "$ROOT/web/dist/index.html" ]] && ok "Web app (prebuilt)" || warn "web/dist missing: the browser UI falls back to a basic page (maintainers: npm run build:web)"

bold "Installing the timesheet command"
if [[ -f "$ROOT/package.json" && -d "$ROOT/.git" ]]; then
  (cd "$ROOT" && npm link --silent >/dev/null) && ok "Linked from checkout ($ROOT)"
else
  (cd "$ROOT" && npm install --global --silent . >/dev/null) && ok "Installed globally"
fi
# A launcher in ~/.local/bin keeps `timesheet` working in every directory, even when
# fnm/nvm switch Node versions per directory (each version has its own global packages).
ENTRY="$(cd "$(npm prefix -g)/lib/node_modules/timesheet" 2>/dev/null && pwd -P)/bin/timesheet.js"
[[ -f "$ENTRY" ]] || ENTRY="$ROOT/bin/timesheet.js"
mkdir -p "$HOME/.local/bin"
sed "s|__ENTRY__|$ENTRY|" "$ROOT/scripts/launcher.sh" > "$HOME/.local/bin/timesheet"
chmod +x "$HOME/.local/bin/timesheet"
ok "Launcher: ~/.local/bin/timesheet"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "Add ~/.local/bin to your PATH (e.g. in ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\")"; export PATH="$HOME/.local/bin:$PATH" ;; esac
command -v timesheet >/dev/null || die "timesheet is not on PATH"

bold "Installing the Claude Code skill"
timesheet install-skill

bold "Checking the installation"
timesheet doctor || true

bold "Setup wizard"
if [[ "$WIZARD" == "web" ]]; then
  echo "  Opening the wizard in your browser (Ctrl+C here when done)…"
  timesheet init --web
else
  timesheet init
  echo
  echo "Done. Try:  timesheet day yesterday    ·    timesheet week last --copy    ·    timesheet serve --open"
fi
