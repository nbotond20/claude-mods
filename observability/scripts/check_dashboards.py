#!/usr/bin/env python3
"""Runs every panel query of the generated dashboards through Grafana and reports errors and empty results.

    python3 observability/scripts/check_dashboards.py [--url http://127.0.0.1:3301] [--hours 24] [--session ID]
"""
import argparse, json, os, re, sys, time, urllib.request, urllib.error

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'stack', 'dashboards')
ap = argparse.ArgumentParser()
ap.add_argument('--url', default='http://127.0.0.1:3301')
ap.add_argument('--hours', type=float, default=24)
ap.add_argument('--session', default='')
ap.add_argument('--trace', default='')
a = ap.parse_args()

VARS = {'profile': '.*', 'model': '.*', 'event': '.+', 'search': '', 'session': a.session, 'trace': a.trace}


def interp(s):
    s = re.sub(r'\$\{(\w+):regex\}', lambda m: VARS.get(m.group(1), m.group(0)), s)
    s = re.sub(r'\$\{(\w+)\}', lambda m: VARS.get(m.group(1), m.group(0)), s)
    return re.sub(r'\$(profile|model|event|search|session|trace)\b', lambda m: VARS[m.group(1)], s)


now = int(time.time() * 1000)
frm = now - int(a.hours * 3600e3)
bad = empty = ok = 0
for f in sorted(os.listdir(DIR)):
    d = json.load(open(os.path.join(DIR, f)))
    for p in d['panels']:
        for t in p.get('targets', []):
            q = dict(t)
            for k in ('expr', 'query'):
                if isinstance(q.get(k), str):
                    q[k] = interp(q[k])
            if q.get('datasource', {}).get('type') == 'tempo' and not q.get('query'):
                continue
            q['intervalMs'], q['maxDataPoints'] = 60000, 500
            body = json.dumps({'queries': [q], 'from': str(frm), 'to': str(now)}).encode()
            req = urllib.request.Request(a.url + '/api/ds/query', body, {'Content-Type': 'application/json'})
            try:
                r = json.load(urllib.request.urlopen(req, timeout=60))
                res = r['results'][t['refId']]
                err = res.get('error')
                n = sum(len(fr.get('data', {}).get('values', [[]])[0]) if fr.get('data', {}).get('values') else 0
                        for fr in res.get('frames', []))
            except urllib.error.HTTPError as e:
                err, n = e.read().decode()[:300], 0
            label = f"{f[:-5]:9} {p.get('title','')[:48]:48} {t['refId']}"
            if err:
                bad += 1
                print(f'ERROR  {label}: {err[:400]}')
            elif n == 0:
                empty += 1
                print(f'empty  {label}')
            else:
                ok += 1
print(f'\n{ok} with data, {empty} empty, {bad} errors')
sys.exit(1 if bad else 0)
