"""Where the mods keep their data, resolved the same way as the mods do (see their `modsHome`)."""
import json, os

HOME = os.path.expanduser('~')


def mods_home():
    """$CLAUDE_MODS_HOME, else ~/.claude-shared when it exists (installs from before the variable), else ~/.claude-mods."""
    v = os.environ.get('CLAUDE_MODS_HOME')
    if v:
        return os.path.expanduser(v.rstrip('/'))
    legacy = os.path.join(HOME, '.claude-shared')
    return legacy if os.path.isdir(legacy) else os.path.join(HOME, '.claude-mods')


DATA = os.environ.get('CLAUDE_USAGE_DIR') or os.path.join(mods_home(), 'usage-analytics')
DEFAULT_PORT = 8787


def config():
    try:
        with open(os.path.join(DATA, 'config.json')) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


DEFAULT_IDLE_MIN = 60


def idle_min():
    """Minutes with no dashboard page open before the server closes itself; 0 keeps it running."""
    try:
        return max(0, int(config().get('dashboardIdleMin', DEFAULT_IDLE_MIN)))
    except (TypeError, ValueError):
        return DEFAULT_IDLE_MIN


def port():
    try:
        p = int(os.environ.get('CLAUDE_USAGE_PORT') or config().get('port') or DEFAULT_PORT)
        return p if 0 < p < 65536 else DEFAULT_PORT
    except (TypeError, ValueError):
        return DEFAULT_PORT
