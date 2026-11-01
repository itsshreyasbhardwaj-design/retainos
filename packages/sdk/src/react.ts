/**
 * React integration.
 *
 * Kept deliberately thin: a context holding one client, a hook to reach it, and
 * a hook for experiment variants that records exposure where the variant is
 * actually rendered.
 *
 * React is a peer dependency. This module is a separate entry point so an
 * application that does not use React never loads it.
 */
import {
  createContext, createElement, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { RetainOSClient } from "./client.ts";
import type { EventProperties, RetainOSOptions } from "./types.ts";

const RetainOSContext = createContext<RetainOSClient | null>(null);

export function RetainOSProvider({
  options, children,
}: { options: RetainOSOptions; children: ReactNode }) {
  // One client for the lifetime of the provider. Re-initialising on every
  // render would issue a new anonymous id each time.
  const client = useMemo(() => new RetainOSClient(options), []);

  useEffect(() => () => client.shutdown(), [client]);

  return createElement(RetainOSContext.Provider, { value: client }, children);
}

/** The client, or null outside a provider. Never throws. */
export function useRetainOS(): RetainOSClient | null {
  return useContext(RetainOSContext);
}

/**
 * Track an event once, when `when` first becomes true.
 *
 * The guard matters: without it a component that re-renders on every keystroke
 * would fire its event on every keystroke.
 */
export function useTrackOnce(name: string, when = true, properties?: EventProperties): void {
  const client = useRetainOS();
  const fired = useRef(false);
  useEffect(() => {
    if (!when || fired.current || !client) return;
    fired.current = true;
    client.track(name, properties);
    // `properties` is intentionally excluded: a new object literal on every
    // render would re-fire an event that is meant to happen once.
  }, [client, name, when]);
}

/** Page view on mount, and on every path change. */
export function usePageView(path?: string): void {
  const client = useRetainOS();
  useEffect(() => {
    client?.page(path);
  }, [client, path]);
}

export interface VariantState {
  variant: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Resolve an experiment variant and record exposure.
 *
 * Exposure is recorded here, where the variant is about to be rendered, rather
 * than at assignment. A user who never reached this component tells you nothing
 * about the change, and counting them dilutes any real effect towards zero.
 */
export function useExperiment(experimentKey: string): VariantState {
  const client = useRetainOS();
  const [state, setState] = useState<VariantState>({ variant: null, loading: true, error: null });
  const exposed = useRef(false);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const diagnostics = client.diagnostics();
    const body = JSON.stringify({
      anonymousId: diagnostics.anonymousId,
      userId: diagnostics.userId,
    });
    const base = (client as unknown as { options: RetainOSOptions }).options;
    const url = `${base.endpoint.replace(/\/+$/, "")}/api/v1`;
    const headers = { "content-type": "application/json", "x-retainos-key": base.projectKey };

    (async () => {
      try {
        const res = await fetch(`${url}/experiments/assign`, { method: "POST", headers, body });
        if (!res.ok) throw new Error(`assignment failed with status ${res.status}`);
        const data = (await res.json()) as { assignments: Record<string, string> };
        const variant = data.assignments[experimentKey] ?? null;
        if (cancelled) return;
        setState({ variant, loading: false, error: null });

        if (variant && !exposed.current) {
          exposed.current = true;
          await fetch(`${url}/experiments/expose`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              experiment: experimentKey,
              variant,
              anonymousId: diagnostics.anonymousId,
              userId: diagnostics.userId,
            }),
          });
        }
      } catch (e) {
        if (cancelled) return;
        // An experiment that cannot resolve must not break the page: the
        // caller renders the control.
        setState({ variant: null, loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => { cancelled = true; };
  }, [client, experimentKey]);

  return state;
}
