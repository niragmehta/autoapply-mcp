import { useCallback, useEffect, useRef, useState } from "./html.js";

/**
 * Loads data and keeps it fresh. A newer request always wins over an older
 * one, and polling pauses while the tab is hidden.
 */
export function useResource(load, deps = [], { interval = 0 } = {}) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true });
  const sequence = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async ({ quiet = false } = {}) => {
    const id = ++sequence.current;
    if (!quiet) setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const data = await loader.current();
      if (id === sequence.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === sequence.current) setState((previous) => ({ ...previous, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, deps);

  useEffect(() => {
    if (!interval) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload({ quiet: true });
    }, interval);
    return () => clearInterval(timer);
  }, [interval, reload]);

  return { ...state, reload };
}

/** The value, settled for `ms` before it changes. */
export function useDebounced(value, ms = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Re-renders every `ms`, for clocks and relative times. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function useTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} - autoapply` : "autoapply";
  }, [title]);
}

/** Runs an async action with busy state and a toast on failure; resolves to the result or null. */
export function useAction(notify) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (action, { success } = {}) => {
      setBusy(true);
      try {
        const result = await action();
        if (success) notify(typeof success === "function" ? success(result) : success);
        return result;
      } catch (error) {
        notify(error?.message ?? String(error), { tone: "bad" });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );
  return [busy, run];
}
