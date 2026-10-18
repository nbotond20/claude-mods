#!/usr/bin/env python3
"""Builds the Grafana dashboards in stack/dashboards/ from this file.

Totals come from Loki (Claude Code's events: one api_request per model call, one tool_result per tool run),
so they are exact and include replayed history; Tempo holds the traces (waterfalls); Prometheus holds Claude
Code's own counters (active time, lines, commits) and the span metrics Tempo derives from traces.

    python3 observability/scripts/build_dashboards.py
"""
import json
import re
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'stack', 'dashboards')

LOKI = {'type': 'loki', 'uid': 'loki'}
PROM = {'type': 'prometheus', 'uid': 'prometheus'}
TEMPO = {'type': 'tempo', 'uid': 'tempo'}


def sel(event=None, extra=''):
    """A Loki stream selector for Claude Code events, filtered by the profile variable."""
    s = 'service_name=~"claude-code.*", claude_profile=~"$profile"'
    if event:
        s += f', event_name="{event}"' if '|' not in event else f', event_name=~"{event}"'
    return '{' + s + '}' + extra


M = ' | model=~"$model"'  # for events that carry the model
SESSION = ' | session_id=~"$session"'


class Dash:
    def __init__(self, uid, title, description, vars_=('profile', 'model'), tags=()):
        self.uid, self.title, self.description = uid, title, description
        self.panels, self.vars, self.tags = [], vars_, tags
        self.x = self.y = self.row_h = 0
        self.next_id = 1

    # layout: panels flow left to right on a 24-column grid
    def place(self, w, h):
        if self.x + w > 24:
            self.x, self.y = 0, self.y + self.row_h
            self.row_h = 0
        pos = {'x': self.x, 'y': self.y, 'w': w, 'h': h}
        self.x += w
        self.row_h = max(self.row_h, h)
        return pos

    def row(self, title, collapsed=False):
        if self.x:
            self.x, self.y, self.row_h = 0, self.y + self.row_h, 0
        p = {'type': 'row', 'title': title, 'collapsed': collapsed, 'panels': [], 'id': self.next_id,
             'gridPos': {'x': 0, 'y': self.y, 'w': 24, 'h': 1}}
        self.next_id += 1
        self.y += 1
        self.panels.append(p)

    def add(self, panel, w, h):
        panel['id'] = self.next_id
        self.next_id += 1
        panel['gridPos'] = self.place(w, h)
        self.panels.append(panel)
        return panel

    def text(self, md, w=24, h=3):
        return self.add({'type': 'text', 'title': '', 'transparent': True,
                         'options': {'mode': 'markdown', 'content': md}}, w, h)

    def json(self):
        tvars = []
        for v in self.vars:
            if v == 'profile':
                tvars.append({'name': 'profile', 'label': 'Profile', 'type': 'query', 'datasource': LOKI,
                              'query': 'label_values(claude_profile)', 'definition': 'label_values(claude_profile)',
                              'includeAll': True, 'multi': True, 'allValue': '.*', 'refresh': 2, 'sort': 1,
                              'current': {'text': ['All'], 'value': ['$__all']}})
            elif v == 'model':
                q = 'label_values(claude_code_token_usage_tokens_total, model)'
                tvars.append({'name': 'model', 'label': 'Model', 'type': 'query', 'datasource': PROM,
                              'query': {'query': q, 'refId': 'model'}, 'definition': q,
                              'includeAll': True, 'multi': True, 'allValue': '.*', 'refresh': 2, 'sort': 1,
                              'current': {'text': ['All'], 'value': ['$__all']}})
            elif v == 'session':
                tvars.append({'name': 'session', 'label': 'Session id', 'type': 'textbox', 'query': '',
                              'current': {'text': '', 'value': ''},
                              'description': 'A session id (from Overview, Traces or Logs); empty shows every session.'})
            elif v == 'trace':
                tvars.append({'name': 'trace', 'label': 'Trace id', 'type': 'textbox', 'query': '',
                              'current': {'text': '', 'value': ''},
                              'description': 'Click a trace in a table to load its waterfall.'})
            elif v == 'event':
                tvars.append({'name': 'event', 'label': 'Event', 'type': 'query', 'datasource': LOKI,
                              'query': 'label_values(event_name)', 'definition': 'label_values(event_name)',
                              'includeAll': True, 'multi': True, 'allValue': '.+', 'refresh': 2, 'sort': 1,
                              'current': {'text': ['All'], 'value': ['$__all']}})
            elif v == 'search':
                tvars.append({'name': 'search', 'label': 'Search prompts, commands, errors', 'type': 'textbox',
                              'query': '', 'current': {'text': '', 'value': ''}})
        return {
            'uid': self.uid, 'title': self.title, 'description': self.description,
            'tags': ['claude-code', *self.tags], 'timezone': 'browser', 'editable': True,
            'graphTooltip': 1, 'schemaVersion': 41, 'version': 1, 'refresh': '30s',
            'time': {'from': 'now-24h', 'to': 'now'},
            'timepicker': {'refresh_intervals': ['10s', '30s', '1m', '5m', '15m']},
            'templating': {'list': tvars},
            'annotations': {'list': [{
                'name': 'API errors', 'datasource': LOKI, 'enable': False, 'iconColor': 'red',
                'expr': sel('api_error'), 'titleFormat': 'API error {{status_code}}', 'textFormat': '{{error}}',
                'tagKeys': 'model,claude_profile'}]},
            'links': [{'title': 'Claude Code', 'type': 'dashboards', 'tags': ['claude-code'], 'asDropdown': False,
                       'includeVars': True, 'keepTime': True}],
            'panels': self.panels,
        }


# ---- panel builders ---------------------------------------------------------------------------------

def loki_t(expr, legend='', instant=False, ref='A'):
    return {'refId': ref, 'datasource': LOKI, 'expr': expr, 'legendFormat': legend,
            'queryType': 'instant' if instant else 'range'}


def prom_t(expr, legend='', instant=False, ref='A'):
    return {'refId': ref, 'datasource': PROM, 'expr': expr, 'legendFormat': legend,
            'instant': instant, 'range': not instant}


def tempo_t(q, limit=50, table='traces', ref='A'):
    return {'refId': ref, 'datasource': TEMPO, 'queryType': 'traceql', 'query': q, 'limit': limit,
            'tableType': table, 'spss': 10}


def grow(m, w):
    """increase() of a Claude Code counter over w that also counts each new session's first sample.

    Every session is its own series starting near zero, and increase() skips a series' first sample, so a
    short session would vanish. The second term adds the first value of series that did not exist before w."""
    first = f'(min_over_time({m}[{w}]) unless {m} offset {w})'
    inc = f'increase({m}[{w}])'
    return f'(({inc} or {first} * 0) + ({first} or {inc} * 0))'


def stat(title, target, unit='short', desc='', decimals=None, color='text', thresholds=None, graph=False):
    d = {'unit': unit, 'noValue': '0', 'color': {'mode': 'fixed', 'fixedColor': color} if not thresholds else {'mode': 'thresholds'}}
    if decimals is not None:
        d['decimals'] = decimals
    if thresholds:
        d['thresholds'] = {'mode': 'absolute', 'steps': thresholds}
    return {'type': 'stat', 'title': title, 'description': desc, 'datasource': target['datasource'],
            'targets': [target], 'fieldConfig': {'defaults': d, 'overrides': []},
            'options': {'reduceOptions': {'calcs': ['lastNotNull'], 'fields': '', 'values': False},
                        'colorMode': 'value', 'graphMode': 'area' if graph else 'none', 'textMode': 'value',
                        'justifyMode': 'center', 'wideLayout': True, 'showPercentChange': False}}


def ts(title, targets, unit='short', desc='', bars=False, stack=False, legend_calcs=('sum',), fill=10, min0=True):
    custom = {'drawStyle': 'bars' if bars else 'line', 'lineWidth': 2, 'fillOpacity': 80 if bars else fill,
              'gradientMode': 'none', 'showPoints': 'never', 'spanNulls': True, 'barAlignment': 1,
              'stacking': {'mode': 'normal' if stack else 'none', 'group': 'A'}, 'axisSoftMin': 0 if min0 else None,
              'lineInterpolation': 'smooth', 'insertNulls': False}
    # Loki rounds the last bucket up to a step boundary, past "now", so the newest activity falls off the chart:
    # stamp each bucket with its start instead
    targets = [{**t, 'expr': t['expr'].replace('[$__interval]', '[$__interval] offset -$__interval')} if t['datasource'] == LOKI else t
               for t in targets]
    return {'type': 'timeseries', 'title': title, 'description': desc, 'datasource': targets[0]['datasource'],
            'targets': targets, 'interval': '1m', **({'maxDataPoints': 90} if bars else {}),
            'fieldConfig': {'defaults': {'unit': unit, 'custom': custom, 'color': {'mode': 'palette-classic'}},
                            'overrides': []},
            'options': {'legend': {'displayMode': 'table', 'placement': 'right', 'calcs': list(legend_calcs),
                                   'showLegend': True, 'sortBy': legend_calcs[0].capitalize() if legend_calcs else None,
                                   'sortDesc': True},
                        'tooltip': {'mode': 'multi', 'sort': 'desc'}}}


def bar(title, target, unit='short', desc='', horizontal=True, label_field=None):
    """A bar gauge of one instant query, one bar per series: rankings, capped at the top 12."""
    if target['expr'].startswith('sort_desc('):
        target = {**target, 'expr': f"sort_desc(topk(12, {target['expr'][len('sort_desc('):-1]}))"}
    return {'type': 'bargauge', 'title': title, 'description': desc, 'datasource': target['datasource'],
            'targets': [target],
            # one frame per series is mishandled for instant Loki queries: merge into rows, one bar per row
            'transformations': [{'id': 'merge', 'options': {}}, {'id': 'organize', 'options': {'excludeByName': {'Time': True}}}],
            'fieldConfig': {'defaults': {'unit': unit, 'min': 0, 'color': {'mode': 'continuous-BlPu'},
                                         'displayName': label_field or ''}, 'overrides': []},
            'options': {'orientation': 'horizontal' if horizontal else 'vertical', 'displayMode': 'gradient',
                        'valueMode': 'text', 'showUnfilled': True, 'namePlacement': 'left', 'sizing': 'manual',
                        'minVizHeight': 16, 'maxVizHeight': 22, 'text': {'titleSize': 12, 'valueSize': 13},
                        'reduceOptions': {'calcs': ['lastNotNull'], 'fields': '/^Value/', 'values': True}}}


def pie(title, target, unit='short', desc=''):
    targets = target if isinstance(target, list) else [target]
    # Grafana drops the labels of instant Loki series: merge one-query pies into rows (labels become
    # columns, joined into the slice name) and name the slices of several queries by their legend
    by_rows = len(targets) == 1 and '{{' in targets[0]['legendFormat']
    named = [{'matcher': {'id': 'byFrameRefID', 'options': t['refId']}, 'properties': [{'id': 'displayName', 'value': t['legendFormat']}]}
             for t in targets if len(targets) > 1 and t['legendFormat']]
    return {'type': 'piechart', 'title': title, 'description': desc, 'datasource': targets[0]['datasource'],
            'targets': targets, 'fieldConfig': {'defaults': {'unit': unit, 'color': {'mode': 'palette-classic'}},
                                                 'overrides': named},
            'transformations': [{'id': 'merge', 'options': {}}, {'id': 'organize', 'options': {'excludeByName': {'Time': True}}}] if by_rows else [],
            'options': {'pieType': 'donut', 'legend': {'displayMode': 'table', 'placement': 'right',
                                                       'values': ['value', 'percent'], 'showLegend': True},
                        'reduceOptions': {'calcs': ['lastNotNull'], 'fields': '/^Value/' if by_rows else '', 'values': by_rows},
                        'tooltip': {'mode': 'single'}, 'displayLabels': []}}


def table(title, targets, desc='', transforms=(), overrides=(), unit=None, sort=None):
    d = {'custom': {'align': 'auto', 'cellOptions': {'type': 'auto'}, 'filterable': True}}
    if unit:
        d['unit'] = unit
    return {'type': 'table', 'title': title, 'description': desc, 'datasource': targets[0]['datasource'],
            'targets': targets, 'transformations': list(transforms),
            'fieldConfig': {'defaults': d, 'overrides': list(overrides)},
            'options': {'showHeader': True, 'cellHeight': 'sm', 'footer': {'show': False},
                        'sortBy': [sort] if sort else []}}


def log_table(title, target, desc, cols):
    """A table of log lines, newest first: `cols` maps each label to show to its header, in order."""
    names = ['Time', *cols, 'session_id', 'trace_id']
    return table(title, [target], desc,
                 transforms=[{'id': 'extractFields', 'options': {'source': 'labels', 'format': 'auto'}},
                             {'id': 'filterFieldsByName', 'options': {'include': {'names': names}}},
                             organize(cols, order=names)],
                 overrides=[SESSION_LINK, TRACE_LINK], sort={'displayName': 'Time', 'desc': True})


def logs(title, target, desc=''):
    return {'type': 'logs', 'title': title, 'description': desc, 'datasource': LOKI, 'targets': [target],
            'options': {'showTime': True, 'showLabels': False, 'showCommonLabels': False, 'wrapLogMessage': True,
                        'prettifyLogMessage': False, 'enableLogDetails': True, 'dedupStrategy': 'none',
                        'sortOrder': 'Descending', 'enableInfiniteScrolling': True}}


def traces_table(title, query, desc='', limit=50, spans=False, open_in='/d/claude-traces?${__url_time_range}&${profile:queryparam}'):
    # without the hint Tempo returns whichever matches it finds first, not the newest
    p = table(title, [tempo_t(query + ' with (most_recent=true)', limit, 'spans' if spans else 'traces')], desc)
    by = 'Duration' if title.startswith('Slowest') else 'Start time'
    p.setdefault('options', {})['sortBy'] = [{'displayName': by, 'desc': True}]
    p['fieldConfig']['overrides'] = [
        {'matcher': {'id': 'byName', 'options': 'Trace ID'},
         'properties': [{'id': 'links', 'value': [{'title': 'Open waterfall',
                                                    'url': open_in + '&var-trace=${__value.raw}'}]}]},
        {'matcher': {'id': 'byName', 'options': 'traceIdHidden'}, 'properties': [{'id': 'custom.hidden', 'value': True}]},
    ]
    return p


def organize(rename=None, order=None, exclude=()):
    rename = dict(rename or {})
    # a lone instant Loki query names its value field "Value #A" in tables
    if 'Value' in rename:
        rename.setdefault('Value #A', rename['Value'])
    if 'Value' in exclude:
        exclude = (*exclude, 'Value #A')
    o = {'excludeByName': {k: True for k in exclude}, 'renameByName': rename}
    if order:
        o['indexByName'] = {k: i for i, k in enumerate(order)}
    return {'id': 'organize', 'options': o}


def labels_to_fields():
    return {'id': 'labelsToFields', 'options': {'mode': 'columns'}}


def merge():
    return {'id': 'merge', 'options': {}}


SESSION_LINK = {'matcher': {'id': 'byName', 'options': 'session_id'},
                'properties': [{'id': 'links', 'value': [{'title': 'Open session',
                                                           'url': '/d/claude-session?${__url_time_range}&var-session=${__value.raw}'}]},
                               {'id': 'displayName', 'value': 'Session'}, {'id': 'custom.width', 'value': 130}]}
TRACE_LINK = {'matcher': {'id': 'byName', 'options': 'trace_id'},
              'properties': [{'id': 'links', 'value': [{'title': 'Open waterfall',
                                                         'url': '/d/claude-traces?${__url_time_range}&var-trace=${__value.raw}'}]},
                             {'id': 'displayName', 'value': 'Trace'}, {'id': 'custom.width', 'value': 130}]}
NAV = ('[Overview](/d/claude-overview) · [Traces & waterfall](/d/claude-traces) · [Where time goes](/d/claude-time) · '
       '[Errors](/d/claude-errors) · [Logs](/d/claude-logs) · [Sessions](/d/claude-session) · '
       '[Tools, hooks & MCP](/d/claude-tools) · [Explore](/explore)')


def nav(d):
    pass  # the dashboard links bar (every claude-code dashboard, keeping time and variables) is the navigation


def rate_range(expr):  # sum over the dashboard range
    return expr.replace('$R', '[$__range]')


# ---- Overview ----------------------------------------------------------------------------------------

def overview():
    d = Dash('claude-overview', 'Claude Code · Overview',
             'Spend, volume, latency and errors across every profile. Filter by profile and model above.')
    nav(d)
    api = sel('api_request', M)
    d.add(stat('Cost', loki_t(f'sum(sum_over_time({api} | unwrap cost_usd [$__range]))', instant=True),
               'currencyUSD', 'List-price cost of every model request in the range.', 2), 4, 4)
    d.add(stat('Model requests', loki_t(f'sum(count_over_time({api} [$__range]))', instant=True)), 3, 4)
    d.add(stat('Prompts', loki_t(f'sum(count_over_time({sel("user_prompt")} [$__range]))', instant=True)), 3, 4)
    d.add(stat('Sessions', loki_t(f'count(sum by (session_id) (count_over_time({sel("user_prompt")} [$__range])))', instant=True),
               desc='Sessions with at least one prompt in the range.'), 3, 4)
    d.add(stat('Cache hit', loki_t(
        f'sum(sum_over_time({api} | unwrap cache_read_tokens [$__range])) / '
        f'(sum(sum_over_time({api} | unwrap cache_read_tokens [$__range])) + sum(sum_over_time({api} | unwrap input_tokens [$__range])) '
        f'+ sum(sum_over_time({api} | unwrap cache_creation_tokens [$__range])))', instant=True),
        'percentunit', 'Share of input tokens read from the prompt cache.', 1), 3, 4)
    d.add(stat('p95 model latency', loki_t(f'quantile_over_time(0.95, {api} | unwrap duration_ms [$__range]) by ()', instant=True),
               'ms', 'Whole request, first byte to last.', 0), 4, 4)
    d.add(stat('Errors', loki_t(
        f'sum(count_over_time({sel("api_error|api_retries_exhausted|internal_error")} [$__range])) + '
        f'sum(count_over_time({sel("tool_result")} | success="false" [$__range])) or vector(0)', instant=True),
        desc='API errors, exhausted retries, internal errors and failed tool runs.',
        thresholds=[{'color': 'green', 'value': None}, {'color': 'orange', 'value': 1}, {'color': 'red', 'value': 20}]), 4, 4)

    d.add(stat('Output tokens', loki_t(f'sum(sum_over_time({api} | unwrap output_tokens [$__range]))', instant=True)), 4, 3)
    d.add(stat('Input + cache tokens', loki_t(
        f'sum(sum_over_time({api} | unwrap input_tokens [$__range])) + sum(sum_over_time({api} | unwrap cache_read_tokens [$__range])) '
        f'+ sum(sum_over_time({api} | unwrap cache_creation_tokens [$__range]))', instant=True)), 4, 3)
    d.add(stat('p95 time to first token', loki_t(f'quantile_over_time(0.95, {api} | unwrap ttft_ms [$__range]) by ()', instant=True),
               'ms', decimals=0), 4, 3)
    d.add(stat('Tool runs', loki_t(f'sum(count_over_time({sel("tool_result")} [$__range]))', instant=True)), 4, 3)
    d.add(stat('Active time (you, live)', prom_t('sum' + grow('claude_code_active_time_seconds_total{claude_profile=~"$profile", type="user"}', '$__range'), instant=True),
               's', 'Time you spent interacting, from Claude Code\'s own counter (live sessions only).', 0), 4, 3)
    d.add(stat('Active time (Claude, live)', prom_t('sum' + grow('claude_code_active_time_seconds_total{claude_profile=~"$profile", type="cli"}', '$__range'), instant=True),
               's', 'Time Claude Code spent working (live sessions only).', 0), 4, 3)

    d.row('Spend')
    d.add(ts('Cost by model', [loki_t(f'sum by (model) (sum_over_time({api} | unwrap cost_usd [$__interval]))', '{{model}}')],
             'currencyUSD', bars=True, stack=True), 12, 9)
    d.add(ts('Cost by profile', [loki_t(f'sum by (claude_profile) (sum_over_time({api} | unwrap cost_usd [$__interval]))', '{{claude_profile}}')],
             'currencyUSD', bars=True, stack=True), 12, 9)
    d.add(ts('Tokens by kind', [
        loki_t(f'sum(sum_over_time({api} | unwrap input_tokens [$__interval]))', 'input', ref='A'),
        loki_t(f'sum(sum_over_time({api} | unwrap output_tokens [$__interval]))', 'output', ref='B'),
        loki_t(f'sum(sum_over_time({api} | unwrap cache_read_tokens [$__interval]))', 'cache read', ref='C'),
        loki_t(f'sum(sum_over_time({api} | unwrap cache_creation_tokens [$__interval]))', 'cache write', ref='D')],
        'short', bars=True, stack=True), 12, 9)
    d.add(ts('Cost by source', [loki_t(f'sum by (query_source) (sum_over_time({api} | unwrap cost_usd [$__interval]))', '{{query_source}}')],
             'currencyUSD', 'main loop, subagents, and auxiliary calls (titles, classifiers…).', bars=True, stack=True), 12, 9)

    d.row('Latency and throughput')
    d.add(ts('Model latency p50 / p95 by model', [
        loki_t(f'quantile_over_time(0.5, {api} | unwrap duration_ms [$__interval]) by (model)', 'p50 {{model}}', ref='A'),
        loki_t(f'quantile_over_time(0.95, {api} | unwrap duration_ms [$__interval]) by (model)', 'p95 {{model}}', ref='B')],
        'ms', legend_calcs=('mean', 'max')), 12, 9)
    d.add(ts('Time to first token p95 by model', [
        loki_t(f'quantile_over_time(0.95, {api} | unwrap ttft_ms [$__interval]) by (model)', '{{model}}')],
        'ms', legend_calcs=('mean', 'max')), 12, 9)
    d.add(ts('Model requests by model', [loki_t(f'sum by (model) (count_over_time({api} [$__interval]))', '{{model}}')],
             bars=True, stack=True), 12, 8)
    d.add(ts('Output tokens per second (p50)', [
        loki_t(f'quantile_over_time(0.5, {api} | output_tokens > 50 | label_format tps=`{{{{ divf (mulf .output_tokens 1000) (subf .duration_ms .ttft_ms) }}}}` | unwrap tps [$__interval]) by (model)', '{{model}}')],
        'short', 'Generation speed after the first token, for requests with more than 50 output tokens.', legend_calcs=('mean',)), 12, 8)

    d.row('Breakdown')
    d.add(table('By profile and model', [
        loki_t(f'sum by (claude_profile, model) (sum_over_time({api} | unwrap cost_usd [$__range]))', instant=True, ref='cost'),
        loki_t(f'sum by (claude_profile, model) (count_over_time({api} [$__range]))', instant=True, ref='requests'),
        loki_t(f'sum by (claude_profile, model) (sum_over_time({api} | unwrap output_tokens [$__range]))', instant=True, ref='output'),
        loki_t(f'quantile_over_time(0.95, {api} | unwrap duration_ms [$__range]) by (claude_profile, model)', instant=True, ref='p95')],
        transforms=[merge(), organize({'claude_profile': 'Profile', 'model': 'Model', 'Value #cost': 'Cost',
                                       'Value #requests': 'Requests', 'Value #output': 'Output tokens', 'Value #p95': 'p95 ms'},
                                      exclude=('Time',))],
        overrides=[{'matcher': {'id': 'byName', 'options': 'Cost'}, 'properties': [
            {'id': 'unit', 'value': 'currencyUSD'}, {'id': 'decimals', 'value': 2},
            {'id': 'custom.cellOptions', 'value': {'type': 'gauge', 'mode': 'basic', 'valueDisplayMode': 'text'}}]},
            {'matcher': {'id': 'byName', 'options': 'p95 ms'}, 'properties': [{'id': 'unit', 'value': 'ms'}]}],
        sort={'displayName': 'Cost', 'desc': True}), 12, 10)
    d.add(table('Top sessions by cost', [
        loki_t(f'topk(25, sum by (session_id, claude_profile) (sum_over_time({api} | unwrap cost_usd [$__range])))', instant=True, ref='cost'),
        loki_t(f'sum by (session_id, claude_profile) (count_over_time({api} [$__range]))', instant=True, ref='requests')],
        'Click a session to open it.',
        transforms=[merge(), organize({'claude_profile': 'Profile', 'Value #cost': 'Cost', 'Value #requests': 'Requests'},
                                      exclude=('Time',)),
                    {'id': 'filterByValue', 'options': {'type': 'exclude', 'match': 'any', 'filters': [
                        {'fieldName': 'Cost', 'config': {'id': 'isNull', 'options': {}}}]}}],
        overrides=[SESSION_LINK, {'matcher': {'id': 'byName', 'options': 'Cost'}, 'properties': [
            {'id': 'unit', 'value': 'currencyUSD'}, {'id': 'decimals', 'value': 2},
            {'id': 'custom.cellOptions', 'value': {'type': 'gauge', 'mode': 'basic', 'valueDisplayMode': 'text'}}]}],
        sort={'displayName': 'Cost', 'desc': True}), 12, 10)

    d.row('Code output (live sessions)')
    d.add(ts('Lines of code', [prom_t('sum by (type) ' + grow('claude_code_lines_of_code_count_total{claude_profile=~"$profile"}', '$__interval'), '{{type}}')],
             bars=True, stack=False), 8, 7)
    d.add(ts('Commits and pull requests', [
        prom_t('sum' + grow('claude_code_commit_count_total{claude_profile=~"$profile"}', '$__interval'), 'commits', ref='A'),
        prom_t('sum' + grow('claude_code_pull_request_count_total{claude_profile=~"$profile"}', '$__interval'), 'pull requests', ref='B')],
        bars=True), 8, 7)
    d.add(ts('Edit decisions', [prom_t('sum by (decision, tool_name) ' + grow('claude_code_code_edit_tool_decision_total{claude_profile=~"$profile"}', '$__interval'), '{{tool_name}} {{decision}}')],
             bars=True, stack=True), 8, 7)
    return d


# ---- Traces & waterfall -----------------------------------------------------------------------------

def traces():
    d = Dash('claude-traces', 'Claude Code · Traces & waterfall',
             'Every prompt is a trace: claude_code.interaction with its model requests, tool runs (permission wait '
             'and execution), hooks and subagents. Click any trace to open its waterfall.',
             vars_=('profile', 'trace'))
    nav(d)
    P = 'resource.claude.profile=~"$profile"'
    d.add(traces_table('Recent prompts (interactions)', f'{{name="claude_code.interaction" && {P}}} | select(span.user_prompt, span.interaction.sequence, span.session.id)',
                       'Newest first. Duration is the whole turn.', 50), 12, 10)
    d.add(traces_table('Slowest prompts', f'{{name="claude_code.interaction" && {P} && duration > 30s}} | select(span.user_prompt, span.session.id)',
                       'Turns longer than 30 seconds.', 50), 12, 10)
    d.add({'type': 'traces', 'title': 'Waterfall: ${trace}', 'datasource': TEMPO,
           'description': 'Pick a trace from a table above, or paste a trace id into the Trace id box.',
           'targets': [{'refId': 'A', 'datasource': TEMPO, 'queryType': 'traceql', 'query': '${trace}', 'limit': 20}],
           'options': {}}, 24, 20)
    d.add(traces_table('Slowest model requests', f'{{name="claude_code.llm_request" && {P} && duration > 20s}} | select(span.model, span.ttft_ms, span.output_tokens, span.input_tokens, span.query_source)',
                       'Single model calls over 20 seconds.', 50, spans=True), 12, 12)
    d.add(traces_table('Slowest tool runs', f'{{name="claude_code.tool" && {P} && duration > 10s}} | select(span.tool_name, span.bash_argv0, span.full_command, span.file_path)',
                       'Tool calls (permission wait + execution) over 10 seconds.', 50, spans=True), 12, 12)
    d.add(traces_table('Failed spans', f'{{{P} && (status = error || span.success = false || span.error != nil)}} | select(span.tool_name, span.model, span.error, span.error_class, span.status_code)',
                       'Model requests and tool runs that failed.', 50, spans=True), 12, 12)
    d.add(traces_table('Waiting on you', f'{{name="claude_code.tool.blocked_on_user" && {P} && duration > 5s}} | select(span.decision, span.source)',
                       'Permission prompts that took longer than 5 seconds to answer.', 50, spans=True), 12, 12)

    d.row('Span metrics (derived from traces by Tempo)')
    sp = 'claude_profile=~"$profile"'
    d.add(ts('Spans per minute by kind', [prom_t(f'sum by (span_name) (rate(traces_spanmetrics_calls_total{{{sp}}}[$__rate_interval])) * 60', '{{span_name}}')],
             'short', legend_calcs=('mean',)), 12, 8)
    d.add(ts('p95 duration by kind', [prom_t(f'histogram_quantile(0.95, sum by (le, span_name) (rate(traces_spanmetrics_latency_bucket{{{sp}}}[$__rate_interval])))', '{{span_name}}')],
             's', legend_calcs=('mean', 'max')), 12, 8)
    d.add(ts('p95 model request by model', [prom_t(f'histogram_quantile(0.95, sum by (le, model) (rate(traces_spanmetrics_latency_bucket{{{sp}, span_name="claude_code.llm_request"}}[$__rate_interval])))', '{{model}}')],
             's', legend_calcs=('mean', 'max')), 12, 8)
    d.add(ts('Error rate by kind', [prom_t(f'sum by (span_name) (rate(traces_spanmetrics_calls_total{{{sp}, status_code="STATUS_CODE_ERROR"}}[$__rate_interval])) / sum by (span_name) (rate(traces_spanmetrics_calls_total{{{sp}}}[$__rate_interval]))', '{{span_name}}')],
             'percentunit', legend_calcs=('mean', 'max')), 12, 8)
    return d


# ---- Where time goes --------------------------------------------------------------------------------

def time_goes():
    d = Dash('claude-time', 'Claude Code · Where time goes',
             'Wall-clock time split by what Claude Code was doing: waiting on the model, running tools, waiting on '
             'your permission, running hooks. From events (history included); panels marked live use span metrics.', vars_=('profile',))
    nav(d)
    sp = 'claude_profile=~"$profile"'
    api = sel('api_request')
    tr = sel('tool_result')
    # from events, so imported history counts too; permission waits and hooks only exist as live spans
    ask = 'AskUserQuestion|ExitPlanMode|EnterPlanMode'  # tools whose whole run is waiting on your answer
    model = lambda w: f'sum(sum_over_time({api} | unwrap duration_ms [{w}])) / 1000'
    tools = lambda w: f'sum(sum_over_time({tr} | tool_name!~"{ask}" | unwrap duration_ms [{w}])) / 1000'
    you = lambda w: f'sum(sum_over_time({tr} | tool_name=~"{ask}" | unwrap duration_ms [{w}])) / 1000'
    caveat = (' Imported history (claude-obs backfill) cannot tell a permission prompt from the run itself, '
              'so its tool time includes those waits.')
    d.add(pie('Time by activity', [loki_t(model('$__range'), 'model', instant=True, ref='A'),
                                   loki_t(tools('$__range'), 'tools', instant=True, ref='B'),
                                   loki_t(you('$__range'), 'answering Claude', instant=True, ref='C')], 's',
              'Summed durations of model requests, tool runs and questions Claude asked you. Subagents run in '
              'parallel, so this can exceed wall-clock time.' + caveat), 8, 10)
    d.add(bar('Tool execution time by tool', loki_t(
        f'sort_desc(sum by (tool_name) (sum_over_time({tr} | tool_name!~"{ask}" | unwrap duration_ms [$__range])) / 1000)', '{{tool_name}}', instant=True), 's',
        caveat.strip()), 8, 10)
    d.add(bar('Model time by model', loki_t(
        f'sort_desc(sum by (model) (sum_over_time({api} | unwrap duration_ms [$__range])) / 1000)', '{{model}}', instant=True), 's'), 8, 10)
    d.add(ts('Time by activity over time', [loki_t(model('$__interval'), 'model', ref='A'),
                                            loki_t(tools('$__interval'), 'tools', ref='B'),
                                            loki_t(you('$__interval'), 'answering Claude', ref='C')],
        's', caveat.strip(), bars=True, stack=True), 24, 9)
    d.add(ts('Model time: waiting for first token vs generating', [
        loki_t(f'sum(sum_over_time({api} | unwrap ttft_ms [$__interval])) / 1000', 'to first token', ref='A'),
        loki_t(f'sum(sum_over_time({api} | label_format gen=`{{{{ subf .duration_ms .ttft_ms }}}}` | unwrap gen [$__interval])) / 1000', 'generating', ref='B')],
        's', 'From api_request events: time to first token against the rest of the response.', bars=True, stack=True), 8, 9)
    d.add(ts('Average turn length (live)', [prom_t(
        f'sum(rate(traces_spanmetrics_latency_sum{{{sp}, span_name="claude_code.interaction"}}[$__rate_interval])) / sum(rate(traces_spanmetrics_latency_count{{{sp}, span_name="claude_code.interaction"}}[$__rate_interval]))', 'mean turn')],
        's', 'Mean duration of a prompt from submit to the final answer. From span metrics: live sessions only.', legend_calcs=('mean', 'max')), 8, 9)
    kinds = 'claude_code.llm_request|claude_code.tool.execution|claude_code.tool.blocked_on_user|claude_code.hook'
    d.add(pie('Live sessions: model, tools, you, hooks', prom_t(
        f'sum by (span_name) (increase(traces_spanmetrics_latency_sum{{{sp}, span_name=~"{kinds}"}}[$__range]))', '{{span_name}}', instant=True), 's',
              'From span metrics, live sessions only: adds time blocked on your permission (tool.blocked_on_user) and hooks.'), 8, 9)
    d.add(table('Tools: count, total and tail latency', [
        loki_t(f'sum by (tool_name) (count_over_time({tr} [$__range]))', instant=True, ref='n'),
        loki_t(f'sum by (tool_name) (sum_over_time({tr} | unwrap duration_ms [$__range])) / 1000', instant=True, ref='total'),
        loki_t(f'quantile_over_time(0.5, {tr} | unwrap duration_ms [$__range]) by (tool_name)', instant=True, ref='p50'),
        loki_t(f'quantile_over_time(0.95, {tr} | unwrap duration_ms [$__range]) by (tool_name)', instant=True, ref='p95'),
        loki_t(f'sum by (tool_name) (count_over_time({tr} | success="false" [$__range]))', instant=True, ref='fail')],
        transforms=[merge(), organize({'tool_name': 'Tool', 'Value #n': 'Runs', 'Value #total': 'Total time',
                                       'Value #p50': 'p50', 'Value #p95': 'p95', 'Value #fail': 'Failed'}, exclude=('Time',))],
        overrides=[{'matcher': {'id': 'byName', 'options': 'Total time'}, 'properties': [
            {'id': 'unit', 'value': 's'}, {'id': 'custom.cellOptions', 'value': {'type': 'gauge', 'mode': 'basic', 'valueDisplayMode': 'text'}}]},
            {'matcher': {'id': 'byRegexp', 'options': 'p50|p95'}, 'properties': [{'id': 'unit', 'value': 'ms'}]},
            {'matcher': {'id': 'byName', 'options': 'Failed'}, 'properties': [
                {'id': 'custom.cellOptions', 'value': {'type': 'color-text'}},
                {'id': 'thresholds', 'value': {'mode': 'absolute', 'steps': [{'color': 'text', 'value': None}, {'color': 'red', 'value': 1}]}}]}],
        sort={'displayName': 'Total time', 'desc': True}), 24, 10)
    return d


# ---- Errors -----------------------------------------------------------------------------------------

def errors():
    d = Dash('claude-errors', 'Claude Code · Errors', 'Where things fail: API errors and refusals, exhausted retries, '
             'tool failures, rejected permissions, MCP servers and hooks.', vars_=('profile', 'model'))
    nav(d)
    ae = sel('api_error', M)
    tf = sel('tool_result', ' | success="false"')
    d.add(stat('API errors', loki_t(f'sum(count_over_time({ae} [$__range])) or vector(0)', instant=True),
               thresholds=[{'color': 'green', 'value': None}, {'color': 'red', 'value': 1}]), 4, 4)
    d.add(stat('API error rate', loki_t(f'(sum(count_over_time({ae} [$__range])) or vector(0)) / sum(count_over_time({sel("api_request", M)} [$__range]))', instant=True),
               'percentunit', decimals=2, thresholds=[{'color': 'green', 'value': None}, {'color': 'orange', 'value': 0.01}, {'color': 'red', 'value': 0.05}]), 4, 4)
    d.add(stat('Retries exhausted', loki_t(f'sum(count_over_time({sel("api_retries_exhausted")} [$__range])) or vector(0)', instant=True),
               thresholds=[{'color': 'green', 'value': None}, {'color': 'red', 'value': 1}]), 4, 4)
    d.add(stat('Tool failures', loki_t(f'sum(count_over_time({tf} [$__range])) or vector(0)', instant=True),
               thresholds=[{'color': 'green', 'value': None}, {'color': 'orange', 'value': 1}]), 4, 4)
    d.add(stat('Refusals', loki_t(f'sum(count_over_time({sel("api_refusal", M)} [$__range])) or vector(0)', instant=True),
               thresholds=[{'color': 'green', 'value': None}, {'color': 'orange', 'value': 1}]), 4, 4)
    d.add(stat('Rejected tool calls', loki_t(f'sum(count_over_time({sel("tool_decision")} | decision="reject" [$__range])) or vector(0)', instant=True),
               desc='Tool calls you, a hook or config rejected.'), 4, 4)

    d.add(ts('API errors by status', [loki_t(f'sum by (status) (count_over_time({ae} | label_format status=`{{{{ or .status_code "from transcript" }}}}` [$__interval]))', '{{status}}')],
             bars=True, stack=True), 12, 8)
    d.add(ts('Tool failures by tool', [loki_t(f'sum by (tool_name) (count_over_time({tf} [$__interval]))', '{{tool_name}}')],
             bars=True, stack=True), 12, 8)

    d.add(log_table('API errors', loki_t(ae), 'Newest first. Errors imported from transcripts have no status code.',
                    {'claude_profile': 'Profile', 'model': 'Model', 'status_code': 'Status', 'error': 'Error',
                     'attempt': 'Attempt', 'duration_ms': 'ms'}), 24, 9)
    d.add(log_table('Tool failures', loki_t(tf), 'Newest first. Error text is kept (OTEL_LOG_TOOL_DETAILS).',
                    {'claude_profile': 'Profile', 'tool_name': 'Tool', 'error_type': 'Kind', 'error': 'Error',
                     'tool_input': 'Input', 'duration_ms': 'ms'}), 24, 10)
    d.add(table('Failing tools ranked', [
        loki_t(f'sum by (tool_name, error_type) (count_over_time({tf} [$__range]))', instant=True)],
        transforms=[organize({'tool_name': 'Tool', 'error_type': 'Kind', 'Value': 'Failures'}, exclude=('Time',))],
        sort={'displayName': 'Failures', 'desc': True}), 8, 9)
    d.add(table('MCP connections that failed', [
        loki_t(f'sum by (server_name, status, transport_type) (count_over_time({sel("mcp_server_connection")} | status=~"failed|error" [$__range]))', instant=True)],
        transforms=[organize({'server_name': 'Server', 'status': 'Status', 'transport_type': 'Transport', 'Value': 'Count'}, exclude=('Time',))]), 8, 9)
    d.add(table('Hooks with errors or blocks', [
        loki_t(f'sum by (hook_event) (sum_over_time({sel("hook_execution_complete")} | unwrap num_non_blocking_error [$__range]))', instant=True, ref='err'),
        loki_t(f'sum by (hook_event) (sum_over_time({sel("hook_execution_complete")} | unwrap num_blocking [$__range]))', instant=True, ref='block'),
        loki_t(f'sum by (hook_event) (sum_over_time({sel("hook_execution_complete")} | unwrap num_cancelled [$__range]))', instant=True, ref='cancel')],
        transforms=[merge(), organize({'hook_event': 'Hook event', 'Value #err': 'Errors', 'Value #block': 'Blocked', 'Value #cancel': 'Cancelled'}, exclude=('Time',))]), 8, 9)
    d.add(logs('Every error event', loki_t(
        f'{sel("api_error|api_refusal|api_retries_exhausted|internal_error|tool_result|mcp_server_connection")} '
        f'| event_name!="tool_result" or success="false" | event_name!="mcp_server_connection" or status=~"failed|error"'
        f' | line_format `{{{{.event_name}}}} {{{{with .tool_name}}}}{{{{.}}}} {{{{end}}}}{{{{with .status_code}}}}{{{{.}}}} {{{{end}}}}{{{{with .error}}}}{{{{.}}}}{{{{end}}}}{{{{with .error_name}}}}{{{{.}}}}{{{{end}}}}`')),
        24, 12)
    return d


# ---- Logs ------------------------------------------------------------------------------------------

def logs_dash():
    d = Dash('claude-logs', 'Claude Code · Logs', 'Every event Claude Code logs: prompts, responses, model requests, '
             'tool runs and decisions, hooks, MCP, plugins. Expand a line for all its fields and a link to its trace.',
             vars_=('profile', 'event', 'session', 'search'))
    nav(d)
    base = ('{service_name=~"claude-code.*", claude_profile=~"$profile", event_name=~"$event"}'
            ' | session_id=~"${session:regex}.*"'
            ' | prompt=~"(?i).*${search:regex}.*" or response=~"(?i).*${search:regex}.*" or tool_input=~"(?i).*${search:regex}.*"'
            ' or error=~"(?i).*${search:regex}.*" or tool_name=~"(?i)${search:regex}.*"')
    fmt = (' | line_format `{{.event_name | trimPrefix "claude_code."}}'
           '{{with .model}} · {{.}}{{end}}{{with .tool_name}} · {{.}}{{end}}{{with .hook_event}} · {{.}}{{end}}'
           '{{with .duration_ms}} · {{.}}ms{{end}}{{with .total_duration_ms}} · {{.}}ms{{end}}'
           '{{with .cost_usd}} · ${{.}}{{end}}{{if eq .success "false"}} · FAILED{{end}}{{with .status_code}} · {{.}}{{end}}'
           '{{with .error}} · {{.}}{{end}}{{with .prompt}} · {{.}}{{end}}{{with .response}} · {{.}}{{end}}'
           '{{with .tool_input}} · {{.}}{{end}}`')
    d.add(ts('Events per interval', [loki_t(f'sum by (event_name) (count_over_time({base} [$__interval]))', '{{event_name}}')],
             bars=True, stack=True), 24, 7)
    d.add(logs('Events', loki_t(base + fmt)), 24, 22)
    d.add(log_table('Prompts', loki_t(sel('user_prompt') + ' | session_id=~"${session:regex}.*" | prompt=~"(?i).*${search:regex}.*"'),
                    'Newest first. Prompt text is kept locally (OTEL_LOG_USER_PROMPTS).',
                    {'claude_profile': 'Profile', 'prompt': 'Prompt', 'command_name': 'Command', 'prompt_length': 'Chars'}), 24, 12)
    return d


# ---- Session ---------------------------------------------------------------------------------------

def session():
    d = Dash('claude-session', 'Claude Code · Session', 'One session end to end: its prompts as traces, spend, '
             'context growth and every event. Put a session id in the box (click one anywhere else).',
             vars_=('profile', 'session', 'trace'))
    nav(d)
    api = sel('api_request', ' | session_id="$session"')
    d.add(stat('Cost', loki_t(f'sum(sum_over_time({api} | unwrap cost_usd [$__range]))', instant=True), 'currencyUSD', decimals=2), 4, 4)
    d.add(stat('Model requests', loki_t(f'sum(count_over_time({api} [$__range]))', instant=True)), 4, 4)
    d.add(stat('Prompts', loki_t(f'sum(count_over_time({sel("user_prompt")} | session_id="$session" [$__range]))', instant=True)), 4, 4)
    d.add(stat('Tool runs', loki_t(f'sum(count_over_time({sel("tool_result")} | session_id="$session" [$__range]))', instant=True)), 4, 4)
    d.add(stat('Model time', loki_t(f'sum(sum_over_time({api} | unwrap duration_ms [$__range])) / 1000', instant=True), 's', decimals=0), 4, 4)
    d.add(stat('Tool time', loki_t(f'sum(sum_over_time({sel("tool_result")} | session_id="$session" | unwrap duration_ms [$__range])) / 1000', instant=True), 's', decimals=0), 4, 4)
    d.add(traces_table('Prompts in this session', '{name="claude_code.interaction" && span.session.id="$session"} | select(span.user_prompt, span.interaction.sequence)',
                       'Click a trace id to open its waterfall below.', 200,
                       open_in='/d/claude-session?${__url_time_range}&${profile:queryparam}&${session:queryparam}'), 24, 9)
    d.add({'type': 'traces', 'title': 'Waterfall: ${trace}', 'datasource': TEMPO,
           'description': 'Pick a prompt from the table above, or paste a trace id into the Trace id box.',
           'targets': [{'refId': 'A', 'datasource': TEMPO, 'queryType': 'traceql', 'query': '${trace}', 'limit': 20}],
           'options': {}}, 24, 18)
    d.add(ts('Context per request', [loki_t(
        f'max(max_over_time({api} | label_format ctx=`{{{{ addf .input_tokens .cache_read_tokens .cache_creation_tokens }}}}` | unwrap ctx [$__interval]))', 'context tokens')],
        'short', 'Input + cache tokens of each request: how full the context was.', legend_calcs=('max',)), 12, 8)
    d.add(ts('Cost over time', [loki_t(f'sum(sum_over_time({api} | unwrap cost_usd [$__interval]))', 'cost')],
             'currencyUSD', bars=True), 12, 8)
    d.add(logs('Session events', loki_t(
        '{service_name=~"claude-code.*"} | session_id="$session"'
        ' | line_format `{{.event_name | trimPrefix "claude_code."}}{{with .model}} · {{.}}{{end}}{{with .tool_name}} · {{.}}{{end}}'
        '{{with .duration_ms}} · {{.}}ms{{end}}{{with .cost_usd}} · ${{.}}{{end}}{{if eq .success "false"}} · FAILED{{end}}'
        '{{with .error}} · {{.}}{{end}}{{with .prompt}} · {{.}}{{end}}{{with .response}} · {{.}}{{end}}{{with .tool_input}} · {{.}}{{end}}`')), 24, 18)
    return d


# ---- Tools, hooks & MCP ----------------------------------------------------------------------------

def tools():
    d = Dash('claude-tools', 'Claude Code · Tools, hooks & MCP', 'What runs between model calls: tools by count and '
             'latency, permission decisions, hooks, MCP servers, skills and plugins.', vars_=('profile',))
    nav(d)
    tr = sel('tool_result')
    d.add(bar('Runs by tool', loki_t(f'sort_desc(sum by (tool_name) (count_over_time({tr} [$__range])))', '{{tool_name}}', instant=True)), 8, 10)
    d.add(bar('p95 duration by tool', loki_t(f'sort_desc(quantile_over_time(0.95, {tr} | unwrap duration_ms [$__range]) by (tool_name))', '{{tool_name}}', instant=True), 'ms'), 8, 10)
    d.add(bar('Result size by tool (avg)', loki_t(f'sort_desc(avg_over_time({tr} | unwrap tool_result_size_bytes [$__range]) by (tool_name))', '{{tool_name}}', instant=True), 'bytes',
              'Bytes each result puts back into the context, on average.'), 8, 10)
    d.add(ts('Tool runs over time', [loki_t(f'sum by (tool_name) (count_over_time({tr} [$__interval]))', '{{tool_name}}')], bars=True, stack=True), 12, 8)
    d.add(ts('Tool p95 duration over time', [loki_t(f'quantile_over_time(0.95, {tr} | unwrap duration_ms [$__interval]) by (tool_name)', '{{tool_name}}')],
             'ms', legend_calcs=('mean', 'max')), 12, 8)
    td = sel('tool_decision')
    d.add(pie('Permission decisions', loki_t(f'sum by (decision, source) (count_over_time({td} [$__range]))', '{{decision}} · {{source}}', instant=True)), 8, 9)
    d.add(table('Bash commands', [loki_t(f'topk(30, sum by (bash_argv0) (count_over_time({sel("tool_result")} | tool_name="Bash" | tool_parameters=~".+" '
                                         f'| line_format `{{{{.tool_parameters}}}}` | json bash_argv0="bash_command" [$__range])))', instant=True)],
                'First word of each command, by count.',
                transforms=[organize({'bash_argv0': 'Command', 'Value': 'Runs'}, exclude=('Time',))],
                sort={'displayName': 'Runs', 'desc': True}), 8, 9)
    d.add(table('Skills activated', [loki_t(f'sum by (skill_name, invocation_trigger) (count_over_time({sel("skill_activated")} [$__range]))', instant=True)],
                transforms=[organize({'skill_name': 'Skill', 'invocation_trigger': 'Trigger', 'Value': 'Count'}, exclude=('Time',))],
                sort={'displayName': 'Count', 'desc': True}), 8, 9)

    d.row('Hooks')
    hc = sel('hook_execution_complete')
    d.add(bar('Hook time by event (total)', loki_t(f'sort_desc(sum by (hook_event) (sum_over_time({hc} | unwrap total_duration_ms [$__range])) / 1000)', '{{hook_event}}', instant=True), 's',
              'Time spent running hooks, per hook event.'), 8, 10)
    d.add(bar('Hook p95 by event', loki_t(f'sort_desc(quantile_over_time(0.95, {hc} | unwrap total_duration_ms [$__range]) by (hook_event))', '{{hook_event}}', instant=True), 'ms'), 8, 10)
    d.add(ts('Hook time over time', [loki_t(f'sum by (hook_event) (sum_over_time({hc} | unwrap total_duration_ms [$__interval]))', '{{hook_event}}')],
             'ms', bars=True, stack=True), 8, 10)

    d.row('MCP servers and plugins')
    mc = sel('mcp_server_connection')
    d.add(table('MCP server connections', [
        loki_t(f'sum by (server_name, status, transport_type) (count_over_time({mc} [$__range]))', instant=True, ref='n'),
        loki_t(f'avg_over_time({mc} | unwrap duration_ms [$__range]) by (server_name, status, transport_type)', instant=True, ref='ms')],
        transforms=[merge(), organize({'server_name': 'Server', 'status': 'Status', 'transport_type': 'Transport',
                                       'Value #n': 'Count', 'Value #ms': 'Avg ms'}, exclude=('Time',))],
        overrides=[{'matcher': {'id': 'byName', 'options': 'Avg ms'}, 'properties': [{'id': 'unit', 'value': 'ms'}]}]), 12, 9)
    d.add(table('Plugins loaded', [loki_t(f'count by (plugin_name, marketplace_name, plugin_version, has_hooks, has_mcp) (count_over_time({sel("plugin_loaded")} [$__range]))', instant=True)],
                transforms=[organize({'plugin_name': 'Plugin', 'marketplace_name': 'Marketplace', 'plugin_version': 'Version',
                                      'has_hooks': 'Hooks', 'has_mcp': 'MCP'}, exclude=('Time', 'Value'),
                                     order=('plugin_name', 'plugin_version', 'marketplace_name', 'has_hooks', 'has_mcp'))]), 12, 9)
    return d


def main():
    os.makedirs(OUT, exist_ok=True)
    built = [overview(), traces(), time_goes(), errors(), logs_dash(), session(), tools()]
    names = {'claude-overview': 'overview', 'claude-traces': 'traces', 'claude-time': 'time', 'claude-errors': 'errors',
             'claude-logs': 'logs', 'claude-session': 'session', 'claude-tools': 'tools'}
    for f in os.listdir(OUT):
        if f.endswith('.json'):
            os.remove(os.path.join(OUT, f))
    for d in built:
        with open(os.path.join(OUT, names[d.uid] + '.json'), 'w') as fh:
            json.dump(d.json(), fh, indent=1)
            fh.write('\n')
    print(f'wrote {len(built)} dashboards to {os.path.relpath(OUT)}')


if __name__ == '__main__':
    main()
