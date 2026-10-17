import { useEffect, useRef, useState } from "react";

export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";

export interface LiveHandlers {
  /** Any named server event: message.created, message.updated, channels.changed, ... */
  onEvent: (type: string, data: unknown) => void;
  /** The connection came back after a gap, or the server asked for it: refetch what may have been missed. */
  onResync: () => void;
  onSignedOut?: () => void;
}

const EVENTS = [
  "message.created",
  "message.updated",
  "message.deleted",
  "messages.bulk",
  "channels.changed",
  "webhooks.changed",
  "delivery",
];

/** How long an open stream may stay silent before we decide something in between is buffering it. */
export const HELLO_TIMEOUT_MS = 8000;

const backoff = (attempt: number) => Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;

/**
 * Live updates. Server-Sent Events first; the browser retries on its own while the server is merely
 * unreachable, and we reopen with backoff if the stream is closed for good. Some proxies (Cloudflare
 * quick tunnels, corporate gateways) buffer event streams: the stream "opens" but nothing arrives.
 * If the server's hello doesn't show up in time we switch to long-polling /api/app/events.
 */
export function useLiveStream(enabled: boolean, handlers: LiveHandlers): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let helloTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let lastId = "";
    let hadGap = false;
    let stopped = false;
    let polling = false;
    const abort = new AbortController();

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        retryTimer = setTimeout(resolve, ms);
      });

    const startPolling = async () => {
      if (polling || stopped) return;
      polling = true;
      es?.close();
      clearTimeout(helloTimer);
      clearTimeout(retryTimer);
      let cursor: number | null = null;
      let failures = 0;
      let first = true;
      while (!stopped) {
        try {
          const url: string = cursor === null ? "/api/app/events" : `/api/app/events?after=${cursor}&wait=25`;
          const res = await fetch(url, { credentials: "same-origin", signal: abort.signal, headers: { Accept: "application/json" } });
          if (res.status === 401) {
            stopped = true;
            ref.current.onSignedOut?.();
            return;
          }
          if (!res.ok) throw new Error(`events ${res.status}`);
          const body = (await res.json()) as { last_id: number; events: { id: number; type: string; data: unknown }[]; resync: boolean };
          setStatus("live");
          // Whatever happened before the first poll (or during an outage) wasn't delivered: catch up.
          if (first || failures > 0 || body.resync) ref.current.onResync();
          first = false;
          failures = 0;
          for (const ev of body.events) if (EVENTS.includes(ev.type)) ref.current.onEvent(ev.type, ev.data);
          cursor = body.last_id;
        } catch {
          if (stopped) return;
          setStatus(navigator.onLine ? "reconnecting" : "offline");
          await sleep(backoff(failures++));
        }
      }
    };

    const connect = () => {
      if (stopped || polling) return;
      if (typeof EventSource === "undefined") {
        void startPolling();
        return;
      }
      const url = lastId ? `/api/app/stream?last_event_id=${encodeURIComponent(lastId)}` : "/api/app/stream";
      es = new EventSource(url, { withCredentials: true });
      clearTimeout(helloTimer);
      helloTimer = setTimeout(() => void startPolling(), HELLO_TIMEOUT_MS);
      es.onopen = () => {
        attempt = 0;
      };
      es.onerror = () => {
        hadGap = true;
        clearTimeout(helloTimer);
        setStatus(navigator.onLine ? "reconnecting" : "offline");
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          retryTimer = setTimeout(connect, backoff(attempt++));
        } else {
          // The browser reconnects by itself; give the new attempt its own hello deadline.
          helloTimer = setTimeout(() => void startPolling(), HELLO_TIMEOUT_MS + 5000);
        }
      };
      es.addEventListener("hello", () => {
        clearTimeout(helloTimer);
        setStatus("live");
        if (hadGap) ref.current.onResync();
        hadGap = false;
      });
      for (const type of EVENTS) {
        es.addEventListener(type, (e) => {
          const me = e as MessageEvent;
          if (me.lastEventId) lastId = me.lastEventId;
          let data: unknown = null;
          try {
            data = me.data ? JSON.parse(me.data) : null;
          } catch {
            return;
          }
          ref.current.onEvent(type, data);
        });
      }
      es.addEventListener("resync", () => ref.current.onResync());
      es.addEventListener("signed_out", () => {
        stopped = true;
        es?.close();
        ref.current.onSignedOut?.();
      });
    };

    const goOffline = () => setStatus("offline");
    const goOnline = () => {
      if (!polling && es && es.readyState === EventSource.CLOSED) {
        clearTimeout(retryTimer);
        attempt = 0;
        connect();
      }
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(helloTimer);
      abort.abort();
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      es?.close();
    };
  }, [enabled]);

  return status;
}
