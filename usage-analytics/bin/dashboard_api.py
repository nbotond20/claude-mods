"""The dashboard's HTTP server and its queries, for `claude-usage serve`.

Every query takes the same filters (?days=&from=&to=&profile=&project=&model=) and answers
{"cols": [...], "rows": [[...]]}. Binds to 127.0.0.1 only; /api/sql opens the database read-only.
"""
import fcntl, glob, json, os, re, socket, sqlite3, sys, threading, time, webbrowser
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from paths import mods_home

# Which filter columns each source has.
COLS = {
    'requests': ('day', 'profile', 'project', 'model'),
    'v_requests': ('day', 'profile', 'project', 'model'),
    'tool_uses': ('day', 'profile', 'project'),
    'prompts': ('day', 'profile', 'project'),
    'attachments': ('day', 'profile'),
    'system_events': ('day', 'profile'),
    'events': ('day', 'profile'),
    'v_mod_steps': ('day', 'profile', 'model'),
    'v_mod_tools': ('day', 'profile'),
    'v_measure': ('day', 'profile'),
    'v_context': ('day', 'profile'),
    'v_compactions': ('day', 'profile'),
    'v_system_prompt': ('day', 'profile'),
    'v_tool_schemas': ('profile',),
    'gateway_spend': ('day', 'profile', 'model'),
    'mood': ('day', 'profile', 'project', 'model'),
    'v_background': ('day', 'profile', 'project', 'model'),
}

TOK = '''ROUND(SUM(cost_usd), 2) cost, COUNT(*) requests, SUM(input) input, SUM(output) output,
  SUM(cache_read) cache_read, SUM(cache_write) cache_write,
  ROUND(100.0 * SUM(cache_read) / NULLIF(SUM(input + cache_read + cache_write), 0), 1) hit_pct'''

# Frustration aggregates over mood rows (score 0-100 per prompt; frustrated = 50+, rage = 75+).
MOOD = '''ROUND(AVG(score), 1) avg_score, MAX(score) peak, SUM(score >= 50) frustrated, SUM(score >= 75) rage,
  ROUND(100.0 * SUM(score >= 25) / COUNT(*), 1) annoyed_pct, ROUND(100.0 * SUM(score >= 50) / COUNT(*), 1) frustrated_pct,
  SUM(signals LIKE '%"swearing"%') swearing'''

# Background spend: the mods' own model calls (v_background), next to all spend.
BG = '''ROUND(SUM(cost_usd), 2) cost, COUNT(DISTINCT run_id) runs, COUNT(*) requests,
  ROUND(SUM(cost_usd) / NULLIF(COUNT(DISTINCT run_id), 0), 4) usd_per_run, ROUND(AVG(context_tokens)) avg_context'''

# name -> (source table for filters, sql). `{W}` is replaced by the filter clause (repeatable).
Q = {
    # What a LiteLLM gateway billed (synced by the mod), next to the list-price estimate of the same days and profiles.
    'gateway_kpis': ('gateway_spend', '''SELECT ROUND(SUM(spend_usd), 2) billed, COUNT(DISTINCT day) days, MIN(day) first_day,
        ROUND((SELECT SUM(cost_usd) FROM requests r WHERE EXISTS (SELECT 1 FROM gateway_spend g WHERE {W} AND g.day = r.day AND g.profile = r.profile)), 2) list
        FROM gateway_spend WHERE {W}'''),
    'gateway_daily': ('gateway_spend', 'SELECT day, ROUND(SUM(spend_usd), 2) billed FROM gateway_spend WHERE {W} GROUP BY day ORDER BY day'),
    'gateway_models': ('gateway_spend', 'SELECT model, ROUND(SUM(spend_usd), 2) billed FROM gateway_spend WHERE {W} GROUP BY model ORDER BY billed DESC'),
    'kpis': ('requests', f'''SELECT ROUND(SUM(cost_usd), 2) cost, COUNT(*) requests, COUNT(DISTINCT session_id) sessions,
        COUNT(DISTINCT day) active_days, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_write) cache_write,
        SUM(thinking) thinking, ROUND(100.0 * SUM(cache_read) / NULLIF(SUM(input + cache_read + cache_write), 0), 1) hit_pct,
        ROUND(AVG(input + cache_read + cache_write)) avg_context, MAX(input + cache_read + cache_write) max_context,
        ROUND(SUM(CASE WHEN agent_id IS NOT NULL THEN cost_usd END), 2) subagent_cost,
        ROUND(SUM(cost_usd) / NULLIF(COUNT(DISTINCT session_id), 0), 2) cost_per_session,
        ROUND(SUM(cost_usd) / NULLIF(COUNT(DISTINCT day), 0), 2) cost_per_day,
        ROUND(1000 * SUM(cost_usd) / NULLIF(COUNT(*), 0), 1) cost_per_1k_requests,
        SUM(tool_blocks) tool_calls, SUM(web_search) web_searches, SUM(web_fetch) web_fetches,
        MIN(day) first_day, MAX(day) last_day
        FROM requests WHERE {{W}}'''),
    'kpi_daily': ('requests', '''SELECT day, ROUND(SUM(cost_usd), 2) cost, COUNT(*) requests, COUNT(DISTINCT session_id) sessions,
        ROUND(100.0 * SUM(cache_read) / NULLIF(SUM(input + cache_read + cache_write), 0), 1) hit_pct,
        ROUND(AVG(input + cache_read + cache_write)) avg_context, SUM(output) output, SUM(tool_blocks) tool_calls,
        ROUND(SUM(CASE WHEN agent_id IS NOT NULL THEN cost_usd END), 2) subagent_cost
        FROM requests WHERE {W} GROUP BY day ORDER BY day'''),
    'daily_cost_kind': ('requests', '''SELECT day, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_write) cache_write
        FROM requests WHERE {W} GROUP BY day ORDER BY day'''),
    'model_mix_daily': ('requests', '''SELECT day, CASE WHEN model LIKE '%opus%' THEN 'Opus' WHEN model LIKE '%sonnet%' THEN 'Sonnet'
        WHEN model LIKE '%haiku%' THEN 'Haiku' ELSE 'other' END family, COUNT(*) requests, ROUND(SUM(cost_usd), 2) cost
        FROM requests WHERE {W} GROUP BY 1, 2 ORDER BY day'''),
    'project_daily': ('requests', '''SELECT day, project, ROUND(SUM(cost_usd), 2) cost FROM requests WHERE {W}
        AND project IN (SELECT project FROM requests WHERE {W} GROUP BY project ORDER BY SUM(cost_usd) DESC LIMIT 8) GROUP BY 1, 2 ORDER BY day'''),
    'session_scatter': ('requests', '''SELECT session_id, profile, project, COUNT(*) requests, ROUND(SUM(cost_usd), 2) cost,
        MAX(input + cache_read + cache_write) max_context, ROUND(AVG(input + cache_read + cache_write)) avg_context
        FROM requests WHERE {W} GROUP BY session_id HAVING cost > 0 ORDER BY cost DESC LIMIT 400'''),
    'daily_profile': ('requests', 'SELECT day, profile, ROUND(SUM(cost_usd), 2) cost, COUNT(*) requests FROM requests WHERE {W} GROUP BY day, profile ORDER BY day'),
    'daily_model': ('requests', 'SELECT day, model, ROUND(SUM(cost_usd), 2) cost FROM requests WHERE {W} GROUP BY day, model ORDER BY day'),
    'daily_tokens': ('requests', '''SELECT day, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_write) cache_write,
        SUM(thinking) thinking FROM requests WHERE {W} GROUP BY day ORDER BY day'''),
    'daily_efficiency': ('requests', '''SELECT day, ROUND(1000 * SUM(cost_usd) / COUNT(*), 1) cost_per_1k_req,
        ROUND(AVG(input + cache_read + cache_write)) avg_context, ROUND(1.0 * SUM(tool_blocks) / COUNT(*), 2) tools_per_req,
        ROUND(100.0 * SUM(cache_read) / NULLIF(SUM(input + cache_read + cache_write), 0), 1) hit_pct,
        ROUND(100.0 * SUM(CASE WHEN agent_id IS NOT NULL THEN cost_usd ELSE 0 END) / NULLIF(SUM(cost_usd), 0), 1) subagent_pct
        FROM requests WHERE {W} GROUP BY day ORDER BY day'''),
    'by_profile': ('requests', f'SELECT profile, COUNT(DISTINCT session_id) sessions, {TOK} FROM requests WHERE {{W}} GROUP BY profile ORDER BY cost DESC'),
    'by_model': ('requests', f'SELECT model, speed, {TOK}, SUM(thinking) thinking FROM requests WHERE {{W}} GROUP BY model, speed ORDER BY cost DESC'),
    'by_effort': ('requests', f"SELECT COALESCE(effort, '(none)') effort, {TOK} FROM requests WHERE {{W}} GROUP BY effort ORDER BY cost DESC"),
    'by_agent_type': ('v_requests', f'''SELECT agent_type, COUNT(DISTINCT COALESCE(agent_id, session_id)) agents, {TOK},
        GROUP_CONCAT(DISTINCT model) models FROM v_requests WHERE {{W}} GROUP BY agent_type ORDER BY cost DESC'''),
    'agent_model': ('v_requests', 'SELECT agent_type, model, ROUND(SUM(cost_usd), 2) cost, COUNT(*) requests FROM v_requests WHERE {W} AND agent_id IS NOT NULL GROUP BY 1, 2 ORDER BY cost DESC'),
    'agent_spawns': ('tool_uses', '''SELECT subagent, COALESCE(detail, '(default)') model_param, COUNT(*) spawns, SUM(input_chars) prompt_chars,
        SUM(result_chars) result_chars FROM tool_uses WHERE {W} AND tool IN ('Agent', 'Task') GROUP BY 1, 2 ORDER BY spawns DESC'''),
    'top_agents': ('v_requests', '''SELECT r.agent_id, r.agent_type, a.description, r.session_id, MIN(r.day) day, COUNT(*) requests,
        MAX(r.input + r.cache_read + r.cache_write) peak_context, ROUND(SUM(r.cost_usd), 2) cost
        FROM v_requests r LEFT JOIN agents a USING (agent_id) WHERE {RW} AND r.agent_id IS NOT NULL
        GROUP BY r.agent_id ORDER BY cost DESC LIMIT 50'''),
    'by_project': ('requests', f'''SELECT project, COUNT(DISTINCT session_id) sessions, {TOK},
        ROUND(AVG(input + cache_read + cache_write)) avg_context FROM requests WHERE {{W}} GROUP BY project ORDER BY cost DESC LIMIT 40'''),
    'by_branch': ('requests', 'SELECT project, git_branch, COUNT(DISTINCT session_id) sessions, ROUND(SUM(cost_usd), 2) cost FROM requests WHERE {W} GROUP BY 1, 2 ORDER BY cost DESC LIMIT 40'),
    'by_version': ('requests', f'SELECT version, MIN(day) first_seen, {TOK} FROM requests WHERE {{W}} GROUP BY version ORDER BY first_seen DESC LIMIT 30'),
    'by_entrypoint': ('requests', f"SELECT COALESCE(entrypoint, '?') entrypoint, COUNT(DISTINCT session_id) sessions, {TOK} FROM requests WHERE {{W}} GROUP BY 1 ORDER BY cost DESC"),
    'stop_reasons': ('requests', "SELECT COALESCE(stop_reason, '?') stop_reason, COUNT(*) requests, ROUND(SUM(cost_usd), 2) cost FROM requests WHERE {W} GROUP BY 1 ORDER BY requests DESC"),
    'ctx_buckets': ('requests', '''SELECT CASE
          WHEN input + cache_read + cache_write < 25000 THEN '0-25k' WHEN input + cache_read + cache_write < 50000 THEN '25-50k'
          WHEN input + cache_read + cache_write < 100000 THEN '50-100k' WHEN input + cache_read + cache_write < 150000 THEN '100-150k'
          WHEN input + cache_read + cache_write < 200000 THEN '150-200k' WHEN input + cache_read + cache_write < 300000 THEN '200-300k'
          WHEN input + cache_read + cache_write < 400000 THEN '300-400k' ELSE '400k+' END bucket,
        MIN(input + cache_read + cache_write) lo, COUNT(*) requests, ROUND(SUM(cost_usd), 2) cost,
        ROUND(SUM(CASE WHEN agent_id IS NULL THEN cost_usd ELSE 0 END), 2) main_cost,
        ROUND(SUM(CASE WHEN agent_id IS NOT NULL THEN cost_usd ELSE 0 END), 2) subagent_cost
        FROM requests WHERE {W} GROUP BY bucket ORDER BY lo'''),
    'ctx_daily': ('requests', '''SELECT day, ROUND(AVG(input + cache_read + cache_write)) avg_context, MAX(input + cache_read + cache_write) max_context
        FROM requests WHERE {W} AND agent_id IS NULL GROUP BY day ORDER BY day'''),
    'parallelism': ('requests', '''SELECT CASE WHEN tool_blocks >= 5 THEN '5+' ELSE CAST(tool_blocks AS TEXT) END tools_in_request,
        COUNT(*) requests, ROUND(SUM(cost_usd), 2) cost FROM requests WHERE {W} GROUP BY 1 ORDER BY MIN(tool_blocks)'''),
    'heatmap': ('requests', '''SELECT CAST(strftime('%w', day) AS INTEGER) weekday, hour, ROUND(SUM(cost_usd), 2) cost, COUNT(*) requests
        FROM requests WHERE {W} GROUP BY 1, 2'''),
    'hours': ('requests', 'SELECT hour, ROUND(SUM(cost_usd), 2) cost, COUNT(*) requests FROM requests WHERE {W} GROUP BY hour ORDER BY hour'),
    'tools': ('tool_uses', '''SELECT tool, COUNT(*) calls, SUM(input_chars) input_chars, SUM(result_chars) result_chars,
        ROUND(AVG(result_chars)) avg_result, MAX(result_chars) max_result, SUM(result_images) images, SUM(is_error) errors,
        ROUND(100.0 * SUM(is_error) / COUNT(*), 1) error_pct,
        ROUND(100.0 * SUM(result_chars) / NULLIF((SELECT SUM(result_chars) FROM tool_uses WHERE {W}), 0), 1) result_share
        FROM tool_uses WHERE {W} AND tool IS NOT NULL GROUP BY tool ORDER BY result_chars DESC LIMIT 60'''),
    'tool_daily': ('tool_uses', '''SELECT day, CASE WHEN tool LIKE 'mcp__%' THEN 'MCP' WHEN tool IN ('Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Agent', 'LSP', 'WebFetch') THEN tool ELSE 'other' END tool,
        SUM(result_chars) result_chars, COUNT(*) calls FROM tool_uses WHERE {W} AND tool IS NOT NULL GROUP BY 1, 2 ORDER BY day'''),
    'result_sizes': ('tool_uses', '''SELECT tool, CASE WHEN result_chars < 1000 THEN 'a <1k' WHEN result_chars < 5000 THEN 'b 1-5k' WHEN result_chars < 15000 THEN 'c 5-15k'
          WHEN result_chars < 30000 THEN 'd 15-30k' ELSE 'e 30k+' END size, COUNT(*) calls, SUM(result_chars) chars
        FROM tool_uses WHERE {W} AND tool IN ('Bash', 'Read', 'Grep', 'WebFetch') AND result_chars IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2'''),
    'bash': ('tool_uses', '''SELECT cmd, COUNT(*) calls, SUM(result_chars) result_chars, ROUND(AVG(result_chars)) avg_result, MAX(result_chars) max_result,
        SUM(is_error) errors, SUM(detail = 'capped') capped FROM tool_uses WHERE {W} AND tool = 'Bash' GROUP BY cmd ORDER BY result_chars DESC LIMIT 60'''),
    'bash_programs': ('tool_uses', '''SELECT CASE WHEN instr(cmd, ' ') > 0 THEN substr(cmd, 1, instr(cmd, ' ') - 1) ELSE cmd END program,
        COUNT(*) calls, SUM(result_chars) result_chars FROM tool_uses WHERE {W} AND tool = 'Bash' GROUP BY 1 ORDER BY result_chars DESC LIMIT 25'''),
    'files': ('tool_uses', '''SELECT file, SUM(tool = 'Read') reads, SUM(tool = 'Edit') edits, SUM(tool = 'Write') writes,
        SUM(CASE WHEN tool = 'Read' THEN result_chars END) read_chars, SUM(CASE WHEN tool IN ('Write', 'Edit') THEN input_chars END) written_chars,
        COUNT(DISTINCT session_id) sessions FROM tool_uses WHERE {W} AND file IS NOT NULL
        GROUP BY file ORDER BY COALESCE(read_chars, 0) + COALESCE(written_chars, 0) DESC LIMIT 60'''),
    'rereads': ('tool_uses', '''SELECT file, session_id, COUNT(*) reads, SUM(result_chars) chars FROM tool_uses WHERE {W} AND tool = 'Read'
        GROUP BY session_id, file HAVING COUNT(*) > 2 ORDER BY chars DESC LIMIT 50'''),
    'read_ranges': ('tool_uses', '''SELECT CASE WHEN detail IS NULL THEN 'whole file' ELSE 'ranged' END kind, COUNT(*) reads,
        SUM(result_chars) chars, ROUND(AVG(result_chars)) avg_chars FROM tool_uses WHERE {W} AND tool = 'Read' GROUP BY 1'''),
    'edit_vs_write': ('tool_uses', '''SELECT tool, COUNT(*) calls, SUM(input_chars) input_chars, ROUND(AVG(input_chars)) avg_input
        FROM tool_uses WHERE {W} AND tool IN ('Edit', 'Write', 'NotebookEdit', 'MultiEdit') GROUP BY tool'''),
    'extensions': ('tool_uses', '''SELECT COALESCE(ext, '(none)') ext, COUNT(*) calls, SUM(result_chars) result_chars, SUM(input_chars) input_chars
        FROM tool_uses WHERE {W} AND file IS NOT NULL GROUP BY 1 ORDER BY result_chars DESC LIMIT 25'''),
    'mcp': ('tool_uses', '''SELECT mcp_server, COUNT(*) calls, COUNT(DISTINCT tool) tools, SUM(result_chars) result_chars, SUM(result_images) images,
        SUM(is_error) errors FROM tool_uses WHERE {W} AND mcp_server IS NOT NULL GROUP BY 1 ORDER BY result_chars DESC'''),
    'skills': ('tool_uses', 'SELECT skill, COUNT(*) calls, SUM(result_chars) result_chars FROM tool_uses WHERE {W} AND tool = \'Skill\' GROUP BY 1 ORDER BY calls DESC'),
    'web': ('tool_uses', '''SELECT tool, COALESCE(detail, '?') target, COUNT(*) calls, SUM(result_chars) result_chars FROM tool_uses
        WHERE {W} AND tool IN ('WebFetch', 'WebSearch') GROUP BY 1, 2 ORDER BY result_chars DESC LIMIT 40'''),
    'lsp': ('tool_uses', "SELECT COALESCE(detail, '?') operation, COUNT(*) calls, SUM(result_chars) result_chars FROM tool_uses WHERE {W} AND tool = 'LSP' GROUP BY 1 ORDER BY calls DESC"),
    'search_vs_lsp': ('tool_uses', '''SELECT day, SUM(tool = 'LSP') lsp, SUM(tool IN ('Grep', 'Glob') OR (tool = 'Bash' AND (cmd LIKE 'grep%' OR cmd LIKE 'rg%' OR cmd LIKE 'find%'))) text_search
        FROM tool_uses WHERE {W} GROUP BY day ORDER BY day'''),
    'tool_errors': ('tool_uses', '''SELECT tool, COALESCE(cmd, file, '') target, COUNT(*) errors FROM tool_uses WHERE {W} AND is_error = 1
        GROUP BY 1, 2 ORDER BY errors DESC LIMIT 40'''),
    'attachments': ('attachments', 'SELECT type, COUNT(*) n, SUM(chars) chars, ROUND(AVG(chars)) avg_chars, MAX(chars) max_chars FROM attachments WHERE {W} GROUP BY type ORDER BY chars DESC'),
    'prompt_kinds': ('prompts', 'SELECT kind, COUNT(*) n, SUM(chars) chars, ROUND(AVG(chars)) avg_chars, MAX(chars) max_chars FROM prompts WHERE {W} GROUP BY kind ORDER BY n DESC'),
    'prompts_daily': ('prompts', "SELECT day, SUM(kind = 'prompt') prompts, SUM(kind = 'command') commands, SUM(kind = 'agent_prompt') agent_prompts FROM prompts WHERE {W} GROUP BY day ORDER BY day"),
    'prompt_lengths': ('prompts', '''SELECT CASE WHEN chars < 50 THEN 'a <50' WHEN chars < 200 THEN 'b 50-200' WHEN chars < 1000 THEN 'c 200-1k'
          WHEN chars < 5000 THEN 'd 1-5k' ELSE 'e 5k+' END length, COUNT(*) prompts FROM prompts WHERE {W} AND kind = 'prompt' GROUP BY 1 ORDER BY 1'''),
    'commands': ('prompts', '''SELECT substr(text, instr(text, '<command-name>') + 14, instr(text, '</command-name>') - instr(text, '<command-name>') - 14) command,
        COUNT(*) n FROM prompts WHERE {W} AND kind = 'command' AND instr(text, '<command-name>') > 0 GROUP BY 1 ORDER BY n DESC LIMIT 40'''),
    'recent_prompts': ('prompts', "SELECT ts, profile, project, chars, substr(text, 1, 300) text, session_id FROM prompts WHERE {W} AND kind = 'prompt' ORDER BY ts DESC LIMIT 100"),
    # Each prompt owns the requests from it until the session's next prompt.
    'expensive_prompts': ('requests', '''WITH p AS (SELECT uuid, ts, profile, session_id, text,
          LEAD(ts, 1, '9999') OVER (PARTITION BY session_id ORDER BY ts) next_ts
          FROM prompts WHERE kind = 'prompt' AND session_id IN (SELECT DISTINCT session_id FROM requests r WHERE {RW}))
        SELECT p.ts, p.profile, substr(p.text, 1, 200) prompt, ROUND(SUM(r.cost_usd), 2) cost, COUNT(r.msg_id) requests,
          MAX(r.input + r.cache_read + r.cache_write) peak_context, p.session_id
        FROM p JOIN requests r ON r.session_id = p.session_id AND r.ts >= p.ts AND r.ts < p.next_ts
        GROUP BY p.uuid ORDER BY cost DESC LIMIT 40'''),
    'sessions': ('requests', '''SELECT r.session_id, r.profile, MIN(r.day) day, s.title, r.project, COUNT(*) requests,
        SUM(r.agent_id IS NOT NULL) subagent_requests, MAX(r.input + r.cache_read + r.cache_write) peak_context,
        ROUND((julianday(MAX(r.ts)) - julianday(MIN(r.ts))) * 1440) minutes, ROUND(SUM(r.cost_usd), 2) cost, ROUND(s.cc_cost_usd, 2) cc_cost,
        s.lines_added, s.lines_removed, GROUP_CONCAT(DISTINCT r.model) models
        FROM requests r LEFT JOIN sessions s USING (session_id) WHERE {RW} GROUP BY r.session_id ORDER BY cost DESC LIMIT 100'''),
    'session_sizes': ('requests', '''SELECT CASE WHEN c < 1 THEN 'a <$1' WHEN c < 5 THEN 'b $1-5' WHEN c < 20 THEN 'c $5-20' WHEN c < 50 THEN 'd $20-50' ELSE 'e $50+' END size,
        COUNT(*) sessions, ROUND(SUM(c), 2) cost FROM (SELECT session_id, SUM(cost_usd) c FROM requests WHERE {W} GROUP BY session_id) GROUP BY 1 ORDER BY 1'''),
    'system_daily': ('system_events', "SELECT day, subtype, COUNT(*) n FROM system_events WHERE {W} AND subtype IN ('api_error', 'compact_boundary', 'informational') GROUP BY 1, 2 ORDER BY day"),
    'turn_durations': ('system_events', '''SELECT day, COUNT(*) turns, ROUND(AVG(duration_ms) / 1000.0, 1) avg_s, ROUND(MAX(duration_ms) / 1000.0) max_s,
        ROUND(AVG(message_count)) avg_messages FROM system_events WHERE {W} AND subtype = 'turn_duration' GROUP BY day ORDER BY day'''),
    'api_errors': ('system_events', "SELECT ts, profile, substr(data, 1, 300) error FROM system_events WHERE {W} AND subtype = 'api_error' ORDER BY ts DESC LIMIT 40"),
    # Frustration meter: one scored row per main-loop prompt (rules and weights in frustration.py).
    'bg_kpis': ('v_background', f'''SELECT {BG}, ROUND(SUM(CASE WHEN kind <> 'in-session call' THEN cost_usd END), 2) run_cost,
        ROUND(SUM(CASE WHEN kind = 'in-session call' THEN cost_usd END), 4) call_cost,
        ROUND(100.0 * SUM(cost_usd) / NULLIF((SELECT SUM(cost_usd) FROM requests WHERE {{W}}), 0), 2) share_pct FROM v_background WHERE {{W}}'''),
    'bg_daily': ('v_background', f'SELECT day, {BG} FROM v_background WHERE {{W}} GROUP BY day ORDER BY day'),
    'bg_daily_caller': ('v_background', 'SELECT day, caller, ROUND(SUM(cost_usd), 4) cost FROM v_background WHERE {W} GROUP BY 1, 2 ORDER BY 1'),
    'bg_callers': ('v_background', f'''SELECT caller, kind, {BG}, GROUP_CONCAT(DISTINCT model) models,
        CASE WHEN kind = 'claude -p' AND AVG(context_tokens) > 15000
             THEN 'mostly Claude Code''s own prompt: run it lean (no tools, short system prompt)' ELSE '' END hint
        FROM v_background WHERE {{W}} GROUP BY caller, kind ORDER BY cost DESC LIMIT 60'''),
    'bg_models': ('v_background', 'SELECT model, ROUND(SUM(cost_usd), 4) cost, COUNT(*) requests FROM v_background WHERE {W} GROUP BY 1 ORDER BY cost DESC'),
    'bg_context': ('v_background', '''SELECT day, kind, ROUND(AVG(context_tokens)) context FROM v_background WHERE {W} GROUP BY 1, 2 ORDER BY 1'''),
    'bg_runs': ('v_background', '''SELECT MIN(ts) ts, caller, kind, session_id, COUNT(*) requests, ROUND(AVG(context_tokens)) avg_context,
        GROUP_CONCAT(DISTINCT model) models, ROUND(SUM(cost_usd), 4) cost FROM v_background WHERE {W} AND kind <> 'in-session call'
        GROUP BY run_id ORDER BY cost DESC LIMIT 60'''),
    'mood_kpis': ('mood', f'''SELECT COUNT(*) prompts, {MOOD} FROM mood WHERE {{W}}'''),
    'mood_daily': ('mood', f'SELECT day, COUNT(*) prompts, {MOOD} FROM mood WHERE {{W}} GROUP BY day ORDER BY day'),
    'mood_weekly': ('mood', f'''SELECT date(day, 'weekday 0', '-6 days') week, COUNT(*) prompts, {MOOD}
        FROM mood WHERE {{W}} GROUP BY 1 ORDER BY 1'''),
    'mood_levels_daily': ('mood', '''SELECT day, level, COUNT(*) prompts FROM mood WHERE {W} AND score > 0 GROUP BY 1, 2
        ORDER BY day, CASE level WHEN 'mild' THEN 1 WHEN 'annoyed' THEN 2 WHEN 'frustrated' THEN 3 ELSE 4 END'''),
    'mood_heatmap': ('mood', 'SELECT weekday, hour, ROUND(AVG(score), 1) score, COUNT(*) prompts FROM mood WHERE {W} GROUP BY 1, 2'),
    'mood_hours': ('mood', f'SELECT hour, COUNT(*) prompts, {MOOD} FROM mood WHERE {{W}} GROUP BY hour ORDER BY hour'),
    'mood_signals': ('mood', '''SELECT s.value signal, COUNT(*) prompts, COUNT(DISTINCT session_id) sessions, ROUND(AVG(score), 1) avg_score
        FROM mood, json_each(mood.signals) s WHERE {W} GROUP BY 1 ORDER BY prompts DESC'''),
    'mood_signals_daily': ('mood', 'SELECT day, s.value signal, COUNT(*) n FROM mood, json_each(mood.signals) s WHERE {W} GROUP BY 1, 2 ORDER BY day'),
    'mood_by_model': ('mood', f'''SELECT COALESCE(model, '?') model, COALESCE(effort, '-') effort, COUNT(*) prompts, {MOOD}
        FROM mood WHERE {{W}} GROUP BY 1, 2 HAVING prompts >= 5 ORDER BY avg_score DESC'''),
    'mood_by_project': ('mood', f'''SELECT project, COUNT(*) prompts, {MOOD} FROM mood WHERE {{W}}
        GROUP BY project HAVING prompts >= 5 ORDER BY avg_score DESC LIMIT 40'''),
    'mood_prompts': ('mood', '''SELECT r.ts, r.project, r.score, r.level, r.signals, substr(p.text, 1, 300) text, r.model, r.session_id
        FROM mood r JOIN prompts p USING (uuid) WHERE {RW} AND r.score > 0 ORDER BY r.score DESC, r.ts DESC LIMIT 100'''),
    'mood_recent': ('mood', '''SELECT r.ts, r.project, r.score, r.level, r.signals, substr(p.text, 1, 300) text, r.session_id
        FROM mood r JOIN prompts p USING (uuid) WHERE {RW} ORDER BY r.ts DESC LIMIT 100'''),
    'mood_sessions': ('mood', f'''SELECT r.session_id, MIN(r.day) day, s.title, r.project, COUNT(*) prompts, {MOOD}
        FROM mood r LEFT JOIN sessions s USING (session_id) WHERE {{RW}} GROUP BY r.session_id HAVING peak > 0
        ORDER BY frustrated DESC, avg_score DESC LIMIT 60'''),
    # From the usage-analytics mod's own log (present once sessions run with it).
    'mod_latency': ('v_mod_steps', '''SELECT model, COUNT(*) steps, ROUND(AVG(ttft_ms)) avg_ttft_ms, ROUND(AVG(ms)) avg_ms, MAX(ms) max_ms,
        ROUND(AVG(messages)) avg_messages FROM v_mod_steps WHERE {W} GROUP BY model ORDER BY steps DESC'''),
    'mod_tool_latency': ('v_mod_tools', '''SELECT tool, COUNT(*) calls, ROUND(AVG(ms)) avg_ms, MAX(ms) max_ms, SUM(denied IS NOT NULL) denied,
        ROUND(AVG(result_chars)) avg_result FROM v_mod_tools WHERE {W} GROUP BY tool ORDER BY calls DESC LIMIT 40'''),
    'mod_context': ('v_context', '''SELECT profile, category, MAX(tokens) tokens, deferred FROM v_context
        WHERE {W} AND ts = (SELECT MAX(ts) FROM events e WHERE e.ev = 'context' AND e.profile = v_context.profile)
        GROUP BY profile, category ORDER BY profile, tokens DESC'''),
    'mod_context_daily': ('v_context', 'SELECT day, category, ROUND(AVG(tokens)) tokens FROM v_context WHERE {W} GROUP BY 1, 2 ORDER BY day'),
    'mod_tool_schemas': ('v_tool_schemas', 'SELECT tool, MAX(chars) chars, MAX(deferred) deferred, GROUP_CONCAT(DISTINCT profile) profiles, MAX(last_seen) last_seen FROM v_tool_schemas WHERE {W} GROUP BY tool ORDER BY chars DESC LIMIT 80'),
    'mod_system_prompt': ('v_system_prompt', 'SELECT section, MAX(section_chars) chars, MAX(chars) prompt_chars, COUNT(DISTINCT sid) sessions FROM v_system_prompt WHERE {W} GROUP BY section ORDER BY chars DESC'),
    'mod_rate_limits': ('v_measure', '''SELECT ts, profile, json_extract(r.value, '$.kind') kind, json_extract(r.value, '$.percentUsed') percent
        FROM v_measure, json_each(v_measure.rate_limits) r WHERE {W} ORDER BY ts DESC LIMIT 200'''),
    'mod_compactions': ('v_compactions', 'SELECT ts, profile, trigger_, tokens_before, tokens_after, ms, skipped FROM v_compactions WHERE {W} ORDER BY ts DESC LIMIT 50'),
    'mod_events': ('events', 'SELECT ev, COUNT(*) n, COUNT(DISTINCT sid) sessions, MAX(day) last_day FROM events WHERE {W} GROUP BY ev ORDER BY n DESC'),
}


def where(source, qs, alias=''):
    cols = COLS.get(source, ())
    w, p = ['1'], []
    days = int((qs.get('days') or ['30'])[0] or 0)
    frm, to = (qs.get('from') or [''])[0], (qs.get('to') or [''])[0]
    if 'day' in cols:
        if frm:
            w.append(f'{alias}day >= ?'); p.append(frm)
        elif days:
            w.append(f'{alias}day >= ?'); p.append((datetime.now() - timedelta(days=days - 1)).strftime('%Y-%m-%d'))
        if to:
            w.append(f'{alias}day <= ?'); p.append(to)
    for key in ('profile', 'model'):
        vals = [v for v in (qs.get(key) or [''])[0].split(',') if v]
        if vals and key in cols:
            w.append(f'{alias}{key} IN ({",".join("?" * len(vals))})'); p += vals
    proj = (qs.get('project') or [''])[0]
    if proj and 'project' in cols:
        w.append(f'{alias}project LIKE ?'); p.append(f'%{proj}%')
    return ' AND '.join(w), p


def run(con, sql, params=()):
    cur = con.execute(sql, params)
    return {'cols': [c[0] for c in cur.description], 'rows': cur.fetchall()}


def query(con, name, qs):
    source, sql = Q[name]
    # {W} filters the source unqualified; {RW} filters it as `r` where queries join it.
    w, p = where(source, qs)
    rw, _ = where(source, qs, 'r.')
    params = []
    for tok in re.findall(r'\{R?W\}', sql):
        params += p
    return run(con, sql.replace('{RW}', rw).replace('{W}', w), params)


def cost_kinds(con, qs, coster):
    w, p = where('requests', qs)
    split = {'input': 0.0, 'output': 0.0, 'cache read': 0.0, 'cache write': 0.0}
    for m, sp, i, o, cr, c5, c1, cw in con.execute(f'''SELECT model, speed, SUM(input), SUM(output), SUM(cache_read), SUM(cw_5m), SUM(cw_1h),
            SUM(cache_write) FROM requests WHERE {w} GROUP BY model, speed''', p):
        split['input'] += coster(m, sp, i, 0, 0, 0, 0, 0) or 0
        split['output'] += coster(m, sp, 0, o, 0, 0, 0, 0) or 0
        split['cache read'] += coster(m, sp, 0, 0, cr, 0, 0, 0) or 0
        split['cache write'] += coster(m, sp, 0, 0, 0, c5, c1, cw) or 0
    return {'cols': ['kind', 'cost'], 'rows': [[k, round(v, 2)] for k, v in split.items()]}


def meta(con):
    one = lambda sql: [r[0] for r in con.execute(sql)]
    last = con.execute('SELECT MAX(ingested_at) FROM files').fetchone()[0]
    return {
        'profiles': one('SELECT DISTINCT profile FROM requests WHERE profile IS NOT NULL ORDER BY 1'),
        'models': one('SELECT model FROM requests GROUP BY model ORDER BY COUNT(*) DESC'),
        'projects': one('SELECT project FROM requests WHERE project IS NOT NULL GROUP BY project ORDER BY SUM(cost_usd) DESC LIMIT 200'),
        'range': con.execute('SELECT MIN(day), MAX(day) FROM requests').fetchone(),
        'lastIngest': last,
        'modEvents': con.execute('SELECT COUNT(*) FROM events').fetchone()[0],
    }


def live_view(con, qs):
    """Right now: today vs yesterday, burn rate, month projection, active sessions, the newest requests and tool calls."""
    profiles = [v for v in (qs.get('profile') or [''])[0].split(',') if v]
    pw = f" AND profile IN ({','.join('?' * len(profiles))})" if profiles else ''
    rpw = pw.replace('profile', 'r.profile')
    now = datetime.now()
    utc = lambda d: d.astimezone().astimezone(__import__('datetime').timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    today, yday = now.strftime('%Y-%m-%d'), (now - timedelta(days=1)).strftime('%Y-%m-%d')
    one = lambda sql, p=(): con.execute(sql, (*p, *profiles)).fetchone()
    t = one(f'SELECT ROUND(SUM(cost_usd), 2), COUNT(*), COUNT(DISTINCT session_id) FROM requests WHERE day = ?{pw}', (today,))
    y_same = one(f'SELECT ROUND(SUM(cost_usd), 2) FROM requests WHERE day = ? AND ts <= ?{pw}', (yday, utc(now - timedelta(days=1))))
    y_all = one(f'SELECT ROUND(SUM(cost_usd), 2) FROM requests WHERE day = ?{pw}', (yday,))
    hour = one(f'SELECT ROUND(SUM(cost_usd), 2), COUNT(*) FROM requests WHERE ts >= ?{pw}', (utc(now - timedelta(hours=1)),))
    month0 = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    nxt = (month0 + timedelta(days=32)).replace(day=1)
    mtd = one(f'SELECT ROUND(SUM(cost_usd), 2) FROM requests WHERE day >= ?{pw}', (month0.strftime('%Y-%m-%d'),))[0] or 0
    prev0 = (month0 - timedelta(days=1)).replace(day=1)
    prev = one(f'SELECT ROUND(SUM(cost_usd), 2) FROM requests WHERE day >= ? AND day < ?{pw}', (prev0.strftime('%Y-%m-%d'), month0.strftime('%Y-%m-%d')))[0] or 0
    frac = (now - month0) / (nxt - month0)
    since = utc(now - timedelta(hours=3))
    return {
        'now': now.isoformat(timespec='seconds'),
        'today': {'cost': t[0] or 0, 'requests': t[1], 'sessions': t[2], 'yesterdaySameTime': y_same[0] or 0, 'yesterday': y_all[0] or 0},
        'lastHour': {'cost': hour[0] or 0, 'requests': hour[1]},
        'month': {'mtd': mtd, 'projected': round(mtd / frac, 2) if frac > 0.02 else None, 'previous': prev, 'elapsedPct': round(100 * frac, 1)},
        'perMinute': run(con, f'''SELECT substr(ts, 1, 16) minute, profile, ROUND(SUM(cost_usd), 4) cost, COUNT(*) requests
            FROM requests WHERE ts >= ?{pw} GROUP BY 1, 2 ORDER BY 1''', (since, *profiles)),
        'todayHourly': run(con, f'SELECT hour, profile, ROUND(SUM(cost_usd), 2) cost FROM requests WHERE day = ?{pw} GROUP BY 1, 2 ORDER BY 1', (today, *profiles)),
        'active': run(con, f'''WITH a AS (SELECT session_id, MAX(ts) last_ts FROM requests WHERE ts >= ?{pw} GROUP BY session_id)
            SELECT a.session_id, r0.profile, r0.project, s.title, a.last_ts,
              (SELECT COUNT(*) FROM requests x WHERE x.session_id = a.session_id) requests,
              (SELECT ROUND(SUM(cost_usd), 2) FROM requests x WHERE x.session_id = a.session_id) cost,
              (SELECT input + cache_read + cache_write FROM requests x WHERE x.session_id = a.session_id AND x.agent_id IS NULL ORDER BY ts DESC LIMIT 1) context,
              (SELECT model FROM requests x WHERE x.session_id = a.session_id AND x.agent_id IS NULL ORDER BY ts DESC LIMIT 1) model,
              (SELECT ROUND(SUM(cost_usd), 2) FROM requests x WHERE x.session_id = a.session_id AND x.ts >= ?) cost_last_hour
            FROM a JOIN requests r0 ON r0.session_id = a.session_id AND r0.ts = a.last_ts LEFT JOIN sessions s ON s.session_id = a.session_id
            GROUP BY a.session_id ORDER BY a.last_ts DESC LIMIT 20''', (utc(now - timedelta(minutes=30)), *profiles, utc(now - timedelta(hours=1)))),
        'feed': run(con, f'''SELECT r.ts, r.profile, r.project, r.model, COALESCE(a.agent_type, CASE WHEN r.agent_id IS NULL THEN 'main' ELSE 'subagent' END) agent,
            r.input + r.cache_read + r.cache_write context, r.output, r.tool_blocks tools, ROUND(r.cost_usd, 4) cost, r.session_id, r.msg_id
            FROM requests r LEFT JOIN agents a USING (agent_id) WHERE r.ts >= ?{rpw} ORDER BY r.ts DESC LIMIT 60''', (utc(now - timedelta(days=2)), *profiles)),
        'tools': run(con, f'''SELECT ts, profile, tool, COALESCE(cmd, file, pattern, skill, subagent, detail) target, result_chars, is_error, session_id, id
            FROM tool_uses WHERE ts >= ?{pw} ORDER BY ts DESC LIMIT 60''', (utc(now - timedelta(days=2)), *profiles)),
    }


def session_detail(con, sid):
    return {
        'info': run(con, 'SELECT * FROM sessions WHERE session_id = ?', (sid,)),
        'timeline': run(con, '''SELECT ts, COALESCE(a.agent_type, CASE WHEN r.agent_id IS NULL THEN 'main' ELSE 'subagent' END) agent, r.model,
            r.input + r.cache_read + r.cache_write context, r.output, r.cache_write, ROUND(r.cost_usd, 4) cost, r.tool_blocks tools, r.stop_reason
            FROM requests r LEFT JOIN agents a USING (agent_id) WHERE r.session_id = ? ORDER BY ts''', (sid,)),
        'tools': run(con, '''SELECT ts, tool, COALESCE(cmd, file, pattern, skill, subagent, detail) target, input_chars, result_chars, is_error, agent_id
            FROM tool_uses WHERE session_id = ? ORDER BY ts''', (sid,)),
        'prompts': run(con, "SELECT ts, kind, chars, substr(text, 1, 1000) text FROM prompts WHERE session_id = ? ORDER BY ts", (sid,)),
        'agents': run(con, 'SELECT agent_id, agent_type, description, spawn_depth FROM agents WHERE session_id = ?', (sid,)),
    }


def savings():
    """budget-guard's per-session ledgers: what each lever saved, by day and profile."""
    d = os.path.join(mods_home(), 'budget-guard', 'sessions')
    by_cat, by_day, by_prof = {}, {}, {}
    for f in os.listdir(d) if os.path.isdir(d) else []:
        if not f.endswith('.json'):
            continue
        try:
            s = json.load(open(os.path.join(d, f)))
        except Exception:
            continue
        saved = 0
        for cat, v in (s.get('saved') or {}).items():
            c = by_cat.setdefault(cat, [0, 0])
            c[0] += v.get('usd', 0); c[1] += v.get('count', 0); saved += v.get('usd', 0)
        day = by_day.setdefault(s.get('day') or '?', [0, 0])
        day[0] += saved; day[1] += s.get('spent') or 0
        pr = by_prof.setdefault(s.get('profile') or '?', [0, 0])
        pr[0] += saved; pr[1] += s.get('spent') or 0
    r2 = lambda x: round(x, 2)
    return {
        'byLever': {'cols': ['lever', 'saved', 'times'], 'rows': sorted([[k, r2(v[0]), v[1]] for k, v in by_cat.items()], key=lambda r: -r[1])},
        'byDay': {'cols': ['day', 'saved', 'spent'], 'rows': sorted([[k, r2(v[0]), r2(v[1])] for k, v in by_day.items()])},
        'byProfile': {'cols': ['profile', 'saved', 'spent'], 'rows': [[k, r2(v[0]), r2(v[1])] for k, v in by_prof.items()]},
    }


class Live:
    """A version counter the stream handlers wait on; bumped whenever an ingest brought in new data."""
    def __init__(self):
        self.cond = threading.Condition()
        self.version = 0
        self.info = {}
        self.progress = None  # the running backfill: {running, total, done, requests, startedAt, finishedAt}

    def report(self, state):
        """A long ingest's progress: kept for /api/ping and pushed to the pages as an update."""
        self.progress = state
        self.bump(reason='backfill', progress=state)

    def bump(self, **info):
        with self.cond:
            self.version += 1
            self.info = {**info, 'version': self.version, 'at': datetime.now().isoformat(timespec='seconds')}
            self.cond.notify_all()

    def wait(self, seen, timeout):
        with self.cond:
            self.cond.wait_for(lambda: self.version != seen, timeout)
            return self.version, self.info


def data_signature(db):
    """Changes whenever an ingest read anything new (every source file's read offset)."""
    try:
        con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=10)
        try:
            return con.execute('SELECT COUNT(*), TOTAL(offset), MAX(ingested_at) FROM files').fetchone()
        finally:
            con.close()
    except sqlite3.Error:
        return None


def watch(db, ingest, live, live_dir, fallback_s=20, trailer_s=3):
    """Ingest as soon as a session pulses (live/<profile>.json, touched by the mod on every prompt, request,
    tool call and turn end), once more a few seconds later for transcript lines written after the pulse,
    and every `fallback_s` anyway for sessions without the mod. Every ingest that read something bumps `live`."""
    last_pulse, last_ingest, trailer_at = 0.0, 0.0, None
    sig = data_signature(db)
    while True:
        time.sleep(1)
        now = time.time()
        try:
            pulse = max((os.stat(f).st_mtime for f in glob.glob(os.path.join(live_dir, '*.json'))), default=0.0)
        except OSError:
            pulse = last_pulse
        fresh = pulse > last_pulse
        if fresh:
            last_pulse, trailer_at = pulse, now + trailer_s
        due = fresh or now - last_ingest >= fallback_s or (trailer_at is not None and now >= trailer_at)
        if not due:
            continue
        if trailer_at is not None and now >= trailer_at:
            trailer_at = None
        last_ingest = now
        try:
            ingest(live.report)
        except Exception as ex:
            print('ingest failed:', ex, file=sys.stderr)
            continue
        new = data_signature(db)
        if new != sig:
            sig = new
            live.bump(reason='pulse' if fresh else 'poll')


class Activity:
    """When the dashboard was last used: the last request, and how many pages hold a live stream open."""
    def __init__(self):
        self.lock = threading.Lock()
        self.last = time.time()
        self.streams = 0

    def touch(self, streams=0):
        with self.lock:
            self.last = time.time()
            self.streams += streams

    def idle_s(self):
        with self.lock:
            return 0 if self.streams else time.time() - self.last


def close_when_idle(srv, activity, idle_min, check_s=30):
    """Shut the server down once no page is open and nothing was asked of it for `idle_min` minutes."""
    while True:
        time.sleep(check_s)
        if activity.idle_s() >= idle_min * 60:
            print(f'dashboard: idle for {idle_min} min, closing', file=sys.stderr)
            srv.shutdown()
            return


def make_handler(db, html_path, coster, ingest, live=None, version=None, activity=None):
    recur = {}    # (live version, filters) -> the recurring asks report
    advice = {}   # (live version, days, profiles) -> the advisor's page; it takes seconds to compute

    def ro():
        import advisor
        return advisor.readonly(db)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, code, body, ctype='application/json', headers=None):
            b = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def host_ok(self):
            # DNS rebinding: a page on evil.example can point its name at 127.0.0.1, but its requests still carry
            # Host: evil.example. Only answer requests addressed to the loopback names.
            port = self.server.server_address[1]
            if self.headers.get('Host') in (f'127.0.0.1:{port}', f'localhost:{port}', f'[::1]:{port}'):
                return True
            self.send(421, {'error': 'unexpected Host header'})
            return False

        def do_GET(self):
            if not self.host_ok():
                return
            if activity:
                activity.touch()
            u = urlparse(self.path)
            qs = parse_qs(u.query)
            try:
                if u.path in ('/', '/index.html'):
                    return self.send(200, open(html_path, 'rb').read(), 'text/html; charset=utf-8')
                if u.path == '/api/ping':
                    return self.send(200, {'ok': True, 'app': 'claude-usage', 'pid': os.getpid(), 'version': version, 'html': html_path,
                                           'live': live.version if live else None, 'progress': live.progress if live else None})
                if u.path == '/api/stream':
                    return self.stream()
                con = ro()
                try:
                    if u.path == '/api/meta':
                        return self.send(200, {**meta(con), 'version': version, 'progress': live.progress if live else None})
                    if u.path == '/api/cost_kinds':
                        return self.send(200, cost_kinds(con, qs, coster))
                    if u.path == '/api/session':
                        return self.send(200, session_detail(con, (qs.get('id') or [''])[0]))
                    if u.path == '/api/live':
                        return self.send(200, {**live_view(con, qs), 'version': live.version if live else 0,
                                               'progress': live.progress if live else None})
                    if u.path == '/api/savings':
                        return self.send(200, savings())
                    if u.path == '/api/impact':
                        import impact
                        days = int((qs.get('days') or ['30'])[0] or 0)
                        profiles = [v for v in (qs.get('profile') or [''])[0].split(',') if v]
                        return self.send(200, impact.impact(con, coster, days=days, profiles=profiles or None))
                    if u.path == '/api/summary':
                        # A shareable summary: html opens as a page, md downloads.
                        import impact
                        import summary
                        days = max(1, min(366, int((qs.get('days') or ['30'])[0] or 30)))
                        fmt = 'md' if (qs.get('format') or [''])[0] == 'md' else 'html'
                        projects = (qs.get('projects') or ['1'])[0] != '0'
                        try:
                            imp = impact.impact(con, coster, days=days)
                        except Exception:
                            imp = None
                        s = summary.summary(con, days=days, projects=projects, impact=imp)
                        name = f"claude-usage-{s['from']}-to-{s['to']}.{fmt}"
                        if fmt == 'md':
                            return self.send(200, summary.to_md(s).encode(), 'text/markdown; charset=utf-8',
                                             {'Content-Disposition': f'attachment; filename="{name}"'})
                        return self.send(200, summary.to_html(s).encode(), 'text/html; charset=utf-8',
                                         {'Content-Disposition': f'inline; filename="{name}"'})
                    if u.path == '/api/advisor':
                        import advisor
                        days = int((qs.get('days') or ['30'])[0] or 30)
                        profiles = [v for v in (qs.get('profile') or [''])[0].split(',') if v]
                        key = (live.version if live else time.time() // 60, days, tuple(profiles))
                        if key not in advice:
                            a = advisor.adb(os.path.dirname(db))
                            try:
                                advice.clear()
                                advice[key] = advisor.dashboard(con, a, profiles or None, days)
                            finally:
                                a.close()
                        return self.send(200, advice[key])
                    if u.path == '/api/recurring':
                        import recurring
                        g = lambda k, d='': (qs.get(k) or [d])[0] or d
                        days = int(g('days', '90') or 90)
                        profiles = [v for v in g('profile').split(',') if v]
                        key = (live.version if live else time.time() // 60, days, g('from'), g('to'), tuple(profiles), g('project'))
                        if key not in recur:
                            a = recurring.adb(os.path.dirname(db))
                            try:
                                recur.clear()
                                recur[key] = recurring.report(con, a, days=days, profiles=profiles or None, project=g('project') or None,
                                                              since=g('from') or None, until=g('to') or None)
                            finally:
                                a.close()
                        return self.send(200, recur[key])
                    if u.path == '/api/batch':
                        names = [n for n in (qs.get('q') or [''])[0].split(',') if n in Q]
                        return self.send(200, {n: query(con, n, qs) for n in names})
                    name = u.path[len('/api/'):]
                    if name in Q:
                        return self.send(200, query(con, name, qs))
                finally:
                    con.close()
                if u.path.startswith('/api/'):
                    return self.send(404, {'error': f'no query {u.path[5:]!r} in this server ({version or "?"}): it may be older than the page; run /dashboard to restart it'})
                self.send(404, {'error': 'not found'})
            except Exception as ex:
                self.send(500, {'error': str(ex)})

        def stream(self):
            # Server-sent events: `update` whenever new data is in, a comment every 15s to keep the line open.
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            seen = live.version if live else 0
            if activity:
                activity.touch(1)
            try:
                self.wfile.write(f'event: hello\ndata: {json.dumps({"version": seen, "server": version})}\n\n'.encode())
                self.wfile.flush()
                while True:
                    if live is None:
                        time.sleep(15); v, info = seen, None
                    else:
                        v, info = live.wait(seen, 15)
                    if v != seen:
                        seen = v
                        self.wfile.write(f'event: update\ndata: {json.dumps(info, default=str)}\n\n'.encode())
                    else:
                        self.wfile.write(b': hb\n\n')
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                return
            finally:
                if activity:
                    activity.touch(-1)

        def do_POST(self):
            if not self.host_ok():
                return
            if activity:
                activity.touch()
            u = urlparse(self.path)
            body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
            # A page on another origin must not drive this server.
            if self.headers.get('Origin') not in (None, f'http://{self.headers.get("Host")}'):
                return self.send(403, {'error': 'cross-origin request refused'})
            try:
                if u.path == '/api/sql':
                    sql = json.loads(body or b'{}').get('sql', '')
                    con = ro()
                    try:
                        r = run(con, sql)
                        r['rows'] = r['rows'][:5000]
                        return self.send(200, r)
                    finally:
                        con.close()
                if u.path == '/api/advisor/status':
                    import advisor
                    req = json.loads(body or b'{}')
                    con, a = ro(), advisor.adb(os.path.dirname(db))
                    try:
                        advisor.set_status(con, a, str(req.get('id', '')), str(req.get('status', '')), req.get('note') or None)
                        advice.clear()
                        return self.send(200, {'ok': True, 'rec': dict(a.execute('SELECT id, status, verdict FROM recs WHERE id = ?', (req.get('id'),)).fetchone() or {})})
                    finally:
                        a.close()
                        con.close()
                if u.path == '/api/recurring/status':
                    import recurring
                    req = json.loads(body or b'{}')
                    con, a = ro(), recurring.adb(os.path.dirname(db))
                    try:
                        r = recurring.set_status(con, a, str(req.get('id', '')), str(req.get('status', '')), req.get('note') or None,
                                                 days=int(req.get('days') or 90))
                        recur.clear()
                        return self.send(200, {'ok': True, **r})
                    finally:
                        a.close()
                        con.close()
                if u.path == '/api/ingest':
                    t0 = time.time()
                    ingest(live.report if live else None)
                    if live:
                        live.bump(reason='manual')
                    return self.send(200, {'ok': True, 'seconds': round(time.time() - t0, 1)})
                self.send(404, {'error': 'not found'})
            except Exception as ex:
                self.send(400, {'error': str(ex)})

    return H


def ping(port):
    """The running dashboard's /api/ping answer, or None when nothing (or something else) answers on the port."""
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.5) as s:
            s.sendall(f'GET /api/ping HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n'.encode())
            data = b''
            while chunk := s.recv(4096):
                data += chunk
        body = data.split(b'\r\n\r\n', 1)[1]
        j = json.loads(body)
        return j if j.get('app') == 'claude-usage' else None
    except (OSError, ValueError, IndexError):
        return None


def port_answers(port):
    return ping(port) is not None


def vtuple(v):
    return tuple(int(x) for x in re.findall(r'\d+', v or '0'))


def listeners(port):
    """{pid: command line} of the processes listening on 127.0.0.1:port."""
    import subprocess
    try:
        pids = subprocess.run(['lsof', '-t', f'-iTCP:{port}', '-sTCP:LISTEN'], capture_output=True, text=True, timeout=5).stdout.split()
    except (OSError, subprocess.SubprocessError):
        return {}
    out = {}
    for pid in pids:
        try:
            out[int(pid)] = subprocess.run(['ps', '-o', 'command=', '-p', pid], capture_output=True, text=True, timeout=5).stdout.strip()
        except (OSError, ValueError, subprocess.SubprocessError):
            out[int(pid)] = ''
    return out


def is_ours(cmd):
    return 'claude-usage' in cmd and ' serve' in cmd


def port_free(port):
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # as the server binds: closed connections don't count
        try:
            s.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def _kill(pids, port):
    """SIGTERM, then SIGKILL whatever still holds the port after 3 seconds."""
    for sig, wait in ((15, 30), (9, 20)):
        for pid in pids:
            try:
                os.kill(pid, sig)
            except OSError:
                pass
        for _ in range(wait):
            if port_free(port):
                return True
            time.sleep(0.1)
    return port_free(port)


def stop(port=8787):
    """Stop the dashboard on this port (found by its listening port): a running one, or a hung one that no longer
    answers. Never touches another program that happens to use the port."""
    pids = [pid for pid, cmd in listeners(port).items() if is_ours(cmd)]
    if not pids:  # lsof found none (or is missing): a running dashboard says its own pid
        p = ping(port)
        pids = [p['pid']] if p and p.get('pid') else []
    return bool(pids) and _kill(pids, port)


def decide(running, version, restart=False, html_exists=True):
    """What to do with the dashboard on the port: 'start' (nothing there), 'reuse' or 'replace'. Never downgrades:
    a server newer than this copy (a session not yet restarted after an update) is kept even when `restart` is set;
    an older one is replaced, and so is one whose files an update removed, whatever its version."""
    if not running:
        return 'start'
    if not html_exists:  # broken whatever its version: an update deleted the copy it serves
        return 'replace'
    mine, theirs = vtuple(version), vtuple(running.get('version'))
    if version and theirs > mine:
        return 'reuse'
    if (version and theirs < mine) or restart:
        return 'replace'
    return 'reuse'


def serve(db, html_path, coster, ingest, port=8787, open_browser=False, daemon=False, log_path=None, tab=None,
          live_dir=None, version=None, quiet=False, restart=False, idle_min=0):
    """One dashboard per machine: a second call opens the running one, or replaces it when this copy is newer
    (a profile updated the plugin) or `restart` is set. A lock file closes the race between sessions starting
    together. With `idle_min`, it closes itself once no page was open for that many minutes."""
    url = f'http://127.0.0.1:{port}/' + (f'#{tab}' if tab else '')
    say = (lambda *a: None) if quiet else print
    lock_path = os.path.join(os.path.dirname(db), 'dashboard.lock')
    guard = open(lock_path, 'w')
    fcntl.flock(guard, fcntl.LOCK_EX)  # held only while deciding and starting
    try:
        running = ping(port)
        action = decide(running, version, restart, not running or not running.get('html') or os.path.exists(running['html']))
        if action == 'replace':
            say(f'restarting dashboard {running.get("version") or "?"}' + (f' as {version}' if version and version != running.get('version') else ''))
            if not stop(port):
                print(f'dashboard: could not stop the running dashboard on port {port}', file=sys.stderr)
                return 1
            running = None
        if running:
            if restart and action == 'reuse' and version and running.get('version') != version:
                say(f'dashboard {running.get("version")} is newer than this copy ({version}): keeping it')
            say(f'dashboard already running: {url}')
            if open_browser:
                webbrowser.open(url)
            return 0
        if not port_free(port):
            # Something holds the port without answering as a dashboard: a hung dashboard is replaced,
            # anything else is left alone and named.
            held = listeners(port)
            if held and all(is_ours(c) for c in held.values()):
                say('restarting a dashboard that stopped answering')
                _kill(list(held), port)
            if not port_free(port):
                who = ', '.join(f'{os.path.basename(c.split()[0]) if c else "?"} (pid {p})' for p, c in held.items()) or 'another program'
                print(f'dashboard: port {port} is used by {who}. Stop it, or set "port" in '
                      f'{os.path.join(os.path.dirname(db), "config.json")} (or CLAUDE_USAGE_PORT) to another port.', file=sys.stderr)
                return 1
        if daemon:
            if os.fork() > 0:
                for _ in range(150):  # wait until it answers so the caller can open it
                    if port_answers(port):
                        break
                    time.sleep(0.1)
                else:
                    tail = ''
                    try:
                        tail = open(log_path).read().strip().splitlines()[-1] if log_path else ''
                    except (OSError, IndexError):
                        pass
                    print(f'dashboard: did not start on port {port}' + (f': {tail}' if tail else '') + (f' (log: {log_path})' if log_path else ''), file=sys.stderr)
                    return 1
                say(f'dashboard running: {url}')
                if open_browser:
                    webbrowser.open(url)
                return 0
            os.setsid()
            if os.fork() > 0:
                os._exit(0)
            out = open(log_path or os.devnull, 'a')
            os.dup2(out.fileno(), 1); os.dup2(out.fileno(), 2)
            os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
        live, activity = Live(), Activity()
        try:
            ThreadingHTTPServer.daemon_threads = True
            srv = ThreadingHTTPServer(('127.0.0.1', port), make_handler(db, html_path, coster, ingest, live, version, activity))
        except OSError as ex:
            print(f'dashboard: port {port} is taken ({ex})', file=sys.stderr)
            if daemon:
                os._exit(1)
            return 1
    finally:
        guard.close()
    if not daemon:
        say(f'dashboard: {url}  (Ctrl-C to stop)')
        if open_browser:
            threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    if live_dir:
        os.makedirs(live_dir, exist_ok=True)
    threading.Thread(target=watch, args=(db, ingest, live, live_dir or os.path.join(os.path.dirname(db), 'live')), daemon=True).start()
    if idle_min and idle_min > 0:
        threading.Thread(target=close_when_idle, args=(srv, activity, idle_min), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    if daemon:
        os._exit(0)
    return 0
