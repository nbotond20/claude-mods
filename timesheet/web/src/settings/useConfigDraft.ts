import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Config } from '../api';
import { CONFIG_SAVED } from '../useReport';

export interface ConfigState {
  config: Config;
  exists: boolean;
  path: string;
}

/** Loads the config, keeps an editable draft, and saves it through server-side validation. */
export function useConfigDraft() {
  const [loaded, setLoaded] = useState<ConfigState | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await api<ConfigState>('/api/config');
      setLoaded(r);
      setDraft(r.config);
      setErrors([]);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const update = useCallback((patch: Partial<Config>) => setDraft((d) => (d ? { ...d, ...patch } : d)), []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    setSaving(true);
    try {
      await api('/api/config', { method: 'PUT', body: { config: draft } });
      setErrors([]);
      window.dispatchEvent(new Event(CONFIG_SAVED));
      await load();
      return true;
    } catch (e) {
      setErrors(e instanceof ApiError && e.errors.length ? e.errors : [(e as Error).message]);
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  const dirty = !!loaded && !!draft && JSON.stringify(loaded.config) !== JSON.stringify(draft);
  const reset = () => {
    if (loaded) setDraft(loaded.config);
    setErrors([]);
  };
  return { loaded, draft, setDraft, update, save, saving, errors, loadError, reload: load, dirty, reset };
}
