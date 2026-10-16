import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { api, ApiError, messageQuery } from "../api";
import { matchesView } from "../components/Feed";
import { formatBytes, relative, safeColor, safeUrl } from "../format";
import { useLiveStream } from "../live";
import { parseRoute, routeHash } from "../route";
import { emptyFilters, type Message } from "../types";

const m = (over: Partial<Message> = {}): Message => ({
  id: 1, channel_id: 1, webhook_id: 9, request_id: "r", kind: "text", status: "warning",
  sender: { name: "Agent", icon: "bot", color: "#5eead4", avatar_url: null },
  content: "Disk almost full", embeds: [], data: null, tags: [], attachments: [],
  created_at: new Date().toISOString(), read: false, pinned: false, archived: false, ...over,
});

describe("routes", () => {
  it("round-trips", () => {
    for (const h of ["#/", "#/channel/4", "#/source/2", "#/webhooks", "#/webhooks/7", "#/docs", "#/audit"]) {
      expect(routeHash(parseRoute(h))).toBe(h);
    }
    expect(parseRoute("#/nonsense")).toEqual({ view: "feed", channelId: null });
  });
});

describe("format", () => {
  it("formats bytes and urls safely", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("https://x.y/z")).toBe("https://x.y/z");
    expect(safeColor("#AbCdEf")).toBe("#AbCdEf");
    expect(safeColor("red")).toBe("var(--accent)");
    expect(relative(null)).toBe("never");
  });
});

describe("matchesView", () => {
  it("places live messages only where they belong", () => {
    const f = { ...emptyFilters };
    expect(matchesView(m(), null, f)).toBe(true);
    expect(matchesView(m(), 2, f)).toBe(false);
    expect(matchesView(m(), 1, { ...f, status: ["error"] })).toBe(false);
    expect(matchesView(m(), 1, { ...f, q: "disk FULL" })).toBe(true);
    expect(matchesView(m(), 1, { ...f, q: "cpu" })).toBe(false);
    expect(matchesView(m(), 1, { ...f, webhookId: 3 })).toBe(false);
    expect(matchesView(m(), 1, { ...f, pinned: true })).toBe(false);
    expect(matchesView(m(), 1, { ...f, archived: "only" })).toBe(false);
    expect(matchesView(m(), 1, { ...f, until: "2000-01-01" })).toBe(false);
  });
});

describe("api client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the CSRF header on writes and parses errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: { code: "validation_failed", message: "bad", details: [{ field: "name", message: "too long" }] }, request_id: "req_1" }), { status: 422 }),
    );
    const err = await api.createChannel({ name: "x", description: "", icon: "hash", color: "#000000" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("validation_failed");
    expect(err.requestId).toBe("req_1");
    expect(err.details[0].field).toBe("name");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Relay-Request"]).toBe("1");
  });

  it("reports network failures clearly", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.channels()).rejects.toMatchObject({ code: "network_error" });
  });

  it("builds message queries", () => {
    const q = messageQuery(3, { ...emptyFilters, q: " disk ", status: ["error", "warning"], pinned: true }, { before_id: 10 });
    const p = new URLSearchParams(q.slice(1));
    expect(p.get("channel_id")).toBe("3");
    expect(p.get("q")).toBe("disk");
    expect(p.get("status")).toBe("error,warning");
    expect(p.get("pinned")).toBe("true");
    expect(p.get("before_id")).toBe("10");
    expect(p.has("unread")).toBe(false);
  });
});

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(type: string, data: unknown, id = "") {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id }));
  }
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.();
  }
}

describe("useLiveStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("delivers events, resyncs after a gap and reconnects with backoff when closed", () => {
    const onEvent = vi.fn();
    const onResync = vi.fn();
    const { result, unmount } = renderHook(() => useLiveStream(true, { onEvent, onResync }));
    const es = FakeEventSource.instances[0];
    expect(result.current).toBe("connecting");
    act(() => es.open());
    expect(result.current).toBe("live");
    expect(onResync).not.toHaveBeenCalled();

    act(() => es.emit("message.created", { message: { id: 5 } }, "41"));
    expect(onEvent).toHaveBeenCalledWith("message.created", { message: { id: 5 } });

    // Transient drop: the browser retries by itself; we resync once it's back.
    act(() => es.fail(false));
    expect(result.current).toBe("reconnecting");
    act(() => es.open());
    expect(onResync).toHaveBeenCalledTimes(1);

    // Closed for good (e.g. server restart answered 502): we open a new stream ourselves.
    act(() => es.fail(true));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(2000));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain("last_event_id=41");
    act(() => FakeEventSource.instances[1].open());
    expect(result.current).toBe("live");
    expect(onResync).toHaveBeenCalledTimes(2);
    unmount();
    expect(FakeEventSource.instances[1].readyState).toBe(2);
  });

  it("asks the server-requested resync", () => {
    const onResync = vi.fn();
    renderHook(() => useLiveStream(true, { onEvent: vi.fn(), onResync }));
    act(() => FakeEventSource.instances[0].emit("resync", {}));
    expect(onResync).toHaveBeenCalled();
  });
});
