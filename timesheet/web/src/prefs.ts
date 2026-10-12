import { useEffect, useState } from 'react';

function read(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v !== '0';
  } catch {
    return fallback;
  }
}

/** A remembered on/off preference, kept in sync across every component (and tab view) using it. */
function usePref(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => read(key, fallback));
  useEffect(() => {
    const on = () => setValue(read(key, fallback));
    window.addEventListener(key, on);
    return () => window.removeEventListener(key, on);
  }, [key, fallback]);
  const set = (v: boolean) => {
    try {
      localStorage.setItem(key, v ? '1' : '0');
    } catch {
      /* private mode */
    }
    setValue(v);
    window.dispatchEvent(new Event(key));
  };
  return [value, set];
}

/** Whether personal and unassigned activity is shown; shared by the calendar and the timesheet. */
export const useShowOther = () => usePref('ts-show-other', true);

/** Whether recorded minutes (timestamps only, nothing assumed or rounded) are shown next to hours. */
export const useShowRecorded = () => usePref('ts-show-recorded', false);
