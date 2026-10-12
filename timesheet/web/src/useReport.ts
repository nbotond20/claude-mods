import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Report } from './api';
import { useJobs } from './jobs';

/** Last response per request, so going back to a range paints instantly while it revalidates. */
const cache = new Map<string, Report>();

/** Fired after settings are saved: every cached report may now be stale. */
export const CONFIG_SAVED = 'timesheet:config-saved';

export interface ReportState {
  report: Report | null;
  /** First load of this range (nothing to show yet) */
  loading: boolean;
  /** Refetching with something already on screen */
  refreshing: boolean;
  error: string | null;
  reload: (opts?: { refresh?: boolean }) => Promise<void>;
}

/**
 * Loads a report without blocking on computation: the server answers with what is cached
 * and queues the rest; this hook refetches whenever background jobs make progress.
 */
export function useReport(body: Record<string, unknown> | null): ReportState {
  const key = body ? JSON.stringify(body) : '';
  const [report, setReport] = useState<Report | null>(() => cache.get(key) ?? null);
  const [loading, setLoading] = useState(!cache.has(key));
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const { version, poke } = useJobs();

  const reload = useCallback(
    async (opts: { refresh?: boolean } = {}) => {
      if (!body) return;
      const id = ++seq.current;
      setRefreshing(true);
      try {
        const r = await api<Report>('/api/report', { body: { ...body, refresh: opts.refresh || undefined } });
        if (id !== seq.current) return;
        cache.set(key, r);
        setReport(r);
        setError(null);
        if (r.jobs.length) poke();
      } catch (e) {
        if (id === seq.current) setError((e as Error).message);
      } finally {
        if (id === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    // body is represented by key
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, poke],
  );

  // New range: show its cached copy (if any) immediately, then revalidate.
  useEffect(() => {
    const cached = cache.get(key) ?? null;
    setReport(cached);
    setLoading(!cached);
    setError(null);
    reload();
  }, [key, reload]);

  // Background progress: refetch only when this range still has something pending.
  const pendingRef = useRef(false);
  pendingRef.current = !!report?.pending.length;
  const firstVersion = useRef(version);
  useEffect(() => {
    if (version === firstVersion.current) return;
    if (pendingRef.current) reload();
  }, [version, reload]);

  // Settings changed: the server queues the days they made stale once asked for the report again.
  useEffect(() => {
    const on = () => {
      cache.clear();
      reload();
    };
    window.addEventListener(CONFIG_SAVED, on);
    return () => window.removeEventListener(CONFIG_SAVED, on);
  }, [reload]);

  return { report, loading, refreshing, error, reload };
}
