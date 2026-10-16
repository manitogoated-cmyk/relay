import { useEffect, useRef, useState } from "react";

export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";

export interface LiveHandlers {
  /** Any named server event: message.created, message.updated, channels.changed, ... */
  onEvent: (type: string, data: unknown) => void;
  /** The stream (re)connected after a gap, or the server asked for it: refetch what may have been missed. */
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

/** Server-Sent Events with reconnection. The browser retries on its own while the server is merely
 * unreachable; if the stream is closed for good (e.g. a restart answered 5xx), we retry with backoff. */
export function useLiveStream(enabled: boolean, handlers: LiveHandlers): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let lastId = "";
    let hadGap = false;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const url = lastId ? `/api/app/stream?last_event_id=${encodeURIComponent(lastId)}` : "/api/app/stream";
      es = new EventSource(url, { withCredentials: true });
      es.onopen = () => {
        attempt = 0;
        setStatus("live");
        if (hadGap) ref.current.onResync();
        hadGap = false;
      };
      es.onerror = () => {
        hadGap = true;
        if (!navigator.onLine) setStatus("offline");
        else setStatus("reconnecting");
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          const delay = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
          attempt += 1;
          retryTimer = setTimeout(connect, delay);
        }
      };
      const track = (e: MessageEvent) => {
        if (e.lastEventId) lastId = e.lastEventId;
      };
      for (const type of EVENTS) {
        es.addEventListener(type, (e) => {
          const me = e as MessageEvent;
          track(me);
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
      if (es && es.readyState === EventSource.CLOSED) {
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
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      es?.close();
    };
  }, [enabled]);

  return status;
}
