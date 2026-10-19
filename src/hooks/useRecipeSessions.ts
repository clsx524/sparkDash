import { useCallback, useEffect, useRef, useState } from "react";
import {
  activateRecipe, fetchCurrentRecipeSession, fetchRecipeSession,
  fetchRecipeSessions, fetchRecipes,
} from "../api/client";
import type { RecipeListResponse, RecipeSessionDetail, RecipeSessionSummary } from "../api/types";

const SELECTION_KEY = "recipe-apply-history-selection";

/** Incremental responses include all stage metadata, but only new log lines. */
export function mergeRecipeSession(
  previous: RecipeSessionDetail | undefined,
  incoming: RecipeSessionDetail,
): RecipeSessionDetail {
  if (!previous || previous.id !== incoming.id) return incoming;
  const newest = incoming.version >= previous.version ? incoming : previous;
  const other = newest === incoming ? previous : incoming;
  return {
    ...newest,
    stages: newest.stages.map((stage) => {
      const oldStage = other.stages.find((candidate) => candidate.id === stage.id);
      const lines = new Map([...(oldStage?.logs ?? []), ...stage.logs].map((line) => [line.seq, line]));
      return { ...stage, logs: [...lines.values()].filter((line) => line.seq >= newest.firstSeq).sort((a, b) => a.seq - b.seq) };
    }),
  };
}

export function useRecipeSessions(open: boolean, wireSummary: RecipeSessionSummary | null | undefined) {
  const [data, setData] = useState<RecipeListResponse | null>(null);
  const [current, setCurrent] = useState<RecipeSessionDetail | null>(null);
  const [history, setHistory] = useState<RecipeSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return localStorage.getItem(SELECTION_KEY); } catch { return null; }
  });
  const [selected, setSelected] = useState<RecipeSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const cache = useRef(new Map<string, RecipeSessionDetail>());
  const latest = useRef<RecipeSessionDetail | null>(null);
  const selection = useRef(selectedId);
  const wire = useRef(wireSummary);
  wire.current = wireSummary;
  const active = useRef(false);
  const epoch = useRef(0);
  const requestPending = useRef(false);
  const hydrated = useRef(false);
  const awaitingSession = useRef<string | null>(null);
  const refresh = useRef<(discover?: boolean, recipes?: boolean) => Promise<void>>(async () => {});

  const selectHistory = useCallback((id: string) => {
    selection.current = id;
    setSelectedId(id);
    setSelected(cache.current.get(id) ?? null);
    setSelectionError(null);
    try { localStorage.setItem(SELECTION_KEY, id); } catch { /* Storage can be disabled. */ }
    void refresh.current();
  }, []);

  useEffect(() => {
    if (!open) return;
    active.current = true;
    hydrated.current = false;
    setReady(false);
    const generation = ++epoch.current;
    let busy = false;
    let queued = false;
    let discoverNext = false;
    let recipesNext = false;
    let polls = 0;
    const valid = () => active.current && epoch.current === generation;
    const save = (detail: RecipeSessionDetail) => {
      const merged = mergeRecipeSession(cache.current.get(detail.id), detail);
      cache.current.set(detail.id, merged);
      return merged;
    };
    const run = async (discover = false, recipes = false) => {
      discoverNext ||= discover;
      recipesNext ||= recipes;
      if (busy) { queued = true; return; }
      busy = true;
      do {
        queued = false;
        const shouldDiscover = discoverNext || !latest.current;
        const shouldLoadRecipes = recipesNext;
        discoverNext = false;
        recipesNext = false;
        try {
          const previous = latest.current;
          const [currentResponse, historyResponse, recipeResponse] = await Promise.all([
            shouldDiscover
              ? fetchCurrentRecipeSession()
              : fetchRecipeSession(previous!.id, previous!.lastSeq),
            fetchRecipeSessions(),
            shouldLoadRecipes ? fetchRecipes() : Promise.resolve(null),
          ]);
          if (!valid()) return;
          const detail = currentResponse.session;
          hydrated.current = true;
          setReady(true);
          if (!requestPending.current && !awaitingSession.current) setPendingId(null);
          if (detail) {
            const merged = save(detail);
            // Never let an older response replace a newer Apply learned from a prior request.
            if (!latest.current || merged.id === latest.current.id || merged.startedAt >= latest.current.startedAt) {
              latest.current = merged;
              setCurrent(merged);
              if (awaitingSession.current === merged.id || (awaitingSession.current && merged.startedAt > (cache.current.get(awaitingSession.current)?.startedAt ?? Infinity))) {
                awaitingSession.current = null;
                if (!requestPending.current) setPendingId(null);
              }
            }
            if (previous?.status === "running" && merged.status !== "running") recipesNext = true;
          } else if (!latest.current) {
            setCurrent(null);
          }
          setHistory(historyResponse.sessions);
          if (recipeResponse) setData(recipeResponse);
          if (selection.current) {
            const id = selection.current;
            const cached = cache.current.get(id);
            try {
              const response = await fetchRecipeSession(id, cached?.lastSeq);
              if (!valid()) return;
              const merged = save(response.session);
              if (selection.current === id) {
                setSelected(merged);
                setSelectionError(null);
              }
            } catch (cause) {
              if (!valid()) return;
              if (selection.current === id) setSelectionError(cause instanceof Error ? cause.message : String(cause));
            }
          }
          setError(null);
          setLoading(false);
          queued ||= recipesNext;
        } catch (cause) {
          if (!valid()) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      } while (queued && valid());
      busy = false;
    };
    refresh.current = run;
    setLoading(true);
    void run(true, true);
    // Incremental catch-up while live; periodically rediscover Current even without WS.
    const timer = setInterval(() => { void run(++polls % 4 === 0); }, 1500);
    return () => {
      active.current = false;
      ++epoch.current;
      clearInterval(timer);
      refresh.current = async () => {};
    };
  }, [open]);

  useEffect(() => {
    if (!open || !wireSummary) return;
    const known = latest.current;
    if (!known || known.id !== wireSummary.id || known.version < wireSummary.version) {
      void refresh.current(known?.id !== wireSummary.id, wireSummary.status !== "running");
    }
  }, [open, wireSummary?.id, wireSummary?.version, wireSummary?.status]);

  const apply = useCallback(async (targetId: string) => {
    const cached = latest.current;
    const announced = wire.current;
    const authoritative = announced && (!cached || announced.startedAt > cached.startedAt || (announced.id === cached.id && announced.version > cached.version))
      ? announced : cached;
    if (!active.current || !hydrated.current || requestPending.current || awaitingSession.current || authoritative?.status === "running") return;
    requestPending.current = true;
    setPendingId(targetId);
    setActionError(null);
    try {
      const response = await activateRecipe(targetId);
      awaitingSession.current = response.sessionId;
      if (cache.current.has(response.sessionId)) awaitingSession.current = null;
      if (active.current) await refresh.current(true, true);
    } catch (cause) {
      if (active.current) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      requestPending.current = false;
      if (active.current && !awaitingSession.current) setPendingId(null);
    }
  }, []);

  // A terminal WS update can supersede a running cached detail before catch-up arrives.
  const authority = wireSummary && (!current || wireSummary.startedAt > current.startedAt || (wireSummary.id === current.id && wireSummary.version > current.version))
    ? wireSummary : current;
  return {
    data, current, history: history.filter((session) => session.id !== current?.id),
    selectedId, selected, selectHistory, selectionError, error: actionError ?? error, loading, ready, pendingId, apply,
    running: authority?.status === "running",
    retry: () => { void refresh.current(true, true); },
  };
}
