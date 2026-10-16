import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, dayToIso, messageQuery } from "../api";
import { bus } from "../bus";
import { dayLabel, parseIso, sameDay } from "../format";
import { Icon } from "../icons";
import type { Channel, Message, MessageFilters, Status, Webhook } from "../types";
import { emptyFilters } from "../types";
import { MessageItem } from "./MessageItem";
import { Confirm, Empty, Spinner, useToast } from "./ui";

const STATUSES: Status[] = ["info", "success", "warning", "error"];
const KINDS = [
  ["text", "Text"],
  ["rich", "Rich"],
  ["json", "JSON"],
  ["file", "Files"],
] as const;

/** Client-side check for live messages, mirroring the server filters closely enough to place them. */
export function matchesView(m: Message, channelId: number | null, f: MessageFilters): boolean {
  if (channelId !== null && m.channel_id !== channelId) return false;
  if (f.webhookId !== null && m.webhook_id !== f.webhookId) return false;
  if (f.status.length && (!m.status || !f.status.includes(m.status))) return false;
  if (f.kind.length && !f.kind.includes(m.kind)) return false;
  if (f.hasAttachments && m.attachments.length === 0) return false;
  if (f.pinned && !m.pinned) return false;
  if (f.unread && m.read) return false;
  if (f.archived === "only" && !m.archived) return false;
  if (f.archived === "exclude" && m.archived) return false;
  const created = parseIso(m.created_at)?.getTime() ?? 0;
  if (f.since && created < new Date(dayToIso(f.since)).getTime()) return false;
  if (f.until && created >= new Date(dayToIso(f.until, true)).getTime()) return false;
  if (f.q.trim()) {
    const hay = JSON.stringify([m.content, m.embeds, m.data, m.tags, m.sender.name, m.attachments.map((a) => a.filename)]).toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t))) return false;
  }
  return true;
}

function activeFilterCount(f: MessageFilters): number {
  return (
    f.status.length + f.kind.length + (f.hasAttachments ? 1 : 0) + (f.pinned ? 1 : 0) + (f.unread ? 1 : 0) +
    (f.archived !== "exclude" ? 1 : 0) + (f.since ? 1 : 0) + (f.until ? 1 : 0) + (f.webhookId !== null ? 1 : 0)
  );
}

interface FeedProps {
  channel: Channel | null;
  channels: Channel[];
  webhooks: Webhook[];
  selectedId: number | null;
  onSelect: (m: Message | null) => void;
  onMessageChange: (m: Message) => void;
  onOpenSidebar: () => void;
  onNewWebhook: () => void;
  onEditChannel: (c: Channel) => void;
  initialWebhookId?: number | null;
}

export function Feed({ channel, channels, webhooks, selectedId, onSelect, onMessageChange, onOpenSidebar, onNewWebhook, onEditChannel, initialWebhookId = null }: FeedProps) {
  const channelId = channel?.id ?? null;
  const [filters, setFilters] = useState<MessageFilters>({ ...emptyFilters, webhookId: initialWebhookId });
  const [search, setSearch] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "archive" | "delete">(null);
  const [newBelow, setNewBelow] = useState(0);
  const [firstUnreadId, setFirstUnreadId] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const preserve = useRef<{ height: number; top: number } | null>(null);
  const reqSeq = useRef(0);
  const toast = useToast();

  const channelNames = useMemo(() => new Map(channels.map((c) => [c.id, c.name])), [channels]);
  const scopeHooks = useMemo(() => webhooks.filter((w) => channelId === null || w.channel_id === channelId), [webhooks, channelId]);

  // Reset filters when switching channel; keep a webhook filter only if it was asked for.
  useEffect(() => {
    setFilters({ ...emptyFilters, webhookId: initialWebhookId });
    setSearch("");
  }, [channelId, initialWebhookId]);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 250);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.messages(messageQuery(channelId, filters));
      if (seq !== reqSeq.current) return;
      const list = [...res.messages].reverse();
      setMessages(list);
      setHasMore(res.has_more);
      setFirstUnreadId(list.find((m) => !m.read)?.id ?? null);
      setNewBelow(0);
      atBottom.current = true;
    } catch (e) {
      if (seq === reqSeq.current) setError(e instanceof ApiError ? e.message : "Couldn't load messages.");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [channelId, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || loadingOlder || messages.length === 0) return;
    setLoadingOlder(true);
    const el = scroller.current;
    try {
      const res = await api.messages(messageQuery(channelId, filters, { before_id: messages[0].id }));
      if (el) preserve.current = { height: el.scrollHeight, top: el.scrollTop };
      setMessages((cur) => {
        const known = new Set(cur.map((m) => m.id));
        return [...res.messages.filter((m) => !known.has(m.id)).reverse(), ...cur];
      });
      setHasMore(res.has_more);
    } catch {
      toast("Couldn't load older messages.", "error");
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMore, loadingOlder, messages, channelId, filters, toast]);

  // Keep the viewport anchored: stick to the bottom for new messages, hold position when older ones load.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (preserve.current) {
      el.scrollTop = el.scrollHeight - preserve.current.height + preserve.current.top;
      preserve.current = null;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Live events
  useEffect(() => {
    return bus.on((type, data) => {
      if (type === "message.created") {
        const m = (data as { message: Message }).message;
        if (!matchesView(m, channelId, filters)) return;
        setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
        if (!atBottom.current) setNewBelow((n) => n + 1);
      } else if (type === "message.updated") {
        const m = (data as { message: Message }).message;
        setMessages((cur) => {
          if (!cur.some((x) => x.id === m.id)) return cur;
          return matchesView(m, channelId, filters) || selectedId === m.id
            ? cur.map((x) => (x.id === m.id ? m : x))
            : cur.filter((x) => x.id !== m.id);
        });
      } else if (type === "message.deleted") {
        const id = (data as { id: number }).id;
        setMessages((cur) => cur.filter((x) => x.id !== id));
      } else if (type === "messages.bulk") {
        const d = data as { channel_id: number | null; action: string; ids?: number[] | null };
        if (d.action === "mark_read") {
          setMessages((cur) =>
            cur.map((x) => ((d.ids ? d.ids.includes(x.id) : d.channel_id === null || x.channel_id === d.channel_id) ? { ...x, read: true } : x)),
          );
        } else if (channelId === null || d.channel_id === channelId) {
          void load();
        }
      } else if (type === "resync") {
        void load();
      }
    });
  }, [channelId, filters, load, selectedId]);

  // Mark what's on screen as read once the viewer is actually looking at the bottom of the feed.
  useEffect(() => {
    const unread = messages.filter((m) => !m.read).map((m) => m.id);
    if (!unread.length || filters.unread) return;
    const t = setTimeout(() => {
      if (document.visibilityState !== "visible" || !atBottom.current) return;
      api.markRead({ ids: unread.slice(-500) }).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [messages, filters.unread]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom.current && newBelow) setNewBelow(0);
    if (el.scrollTop < 120) void loadOlder();
  };

  const jumpToBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setNewBelow(0);
  };

  const patchMessage = async (m: Message, change: { read?: boolean; pinned?: boolean }) => {
    try {
      const res = await api.updateMessage(m.id, change);
      setMessages((cur) => cur.map((x) => (x.id === m.id ? res.message : x)));
      onMessageChange(res.message);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Update failed", "error");
    }
  };
  const togglePin = useCallback((m: Message) => void patchMessage(m, { pinned: !m.pinned }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleRead = useCallback((m: Message) => void patchMessage(m, { read: !m.read }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const history = async (action: "archive" | "delete" | "mark_read") => {
    if (!channel) return;
    const res = await api.channelHistory(channel.id, action);
    toast(action === "mark_read" ? "Marked as read" : `${res.affected} message${res.affected === 1 ? "" : "s"} ${action === "archive" ? "archived" : "deleted"}`);
    if (action !== "mark_read") onSelect(null);
  };

  const markAllRead = async () => {
    setMenuOpen(false);
    try {
      if (channel) await history("mark_read");
      else {
        const ids = messages.filter((m) => !m.read).map((m) => m.id);
        if (ids.length) await api.markRead({ ids });
        toast("Marked as read");
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed", "error");
    }
  };

  const nFilters = activeFilterCount(filters);
  const toggleIn = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const filtered = nFilters > 0 || !!filters.q;

  return (
    <section className="feed" aria-label="Message feed">
      <header className="feed-head">
        <button type="button" className="btn btn-icon only-mobile" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Icon name="menu" />
        </button>
        <div className="feed-title">
          <span className="feed-title-icon" style={{ color: channel?.color ?? "var(--accent)" }}>
            <Icon name={channel?.icon ?? "inbox"} size={18} />
          </span>
          <div className="feed-title-text">
            <h1>{channel?.name ?? "All messages"}</h1>
            <p>{channel?.description || (channel ? `${scopeHooks.length} source${scopeHooks.length === 1 ? "" : "s"}` : "Every channel, newest at the bottom")}</p>
          </div>
        </div>
        <div className="feed-tools">
          <div className="search">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder={`Search ${channel ? channel.name : "all messages"}`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search messages"
              maxLength={200}
            />
          </div>
          <button type="button" className={`btn btn-ghost ${showFilters || nFilters ? "is-active" : ""}`} onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
            <Icon name="filter" size={15} />
            <span className="hide-sm">Filters</span>
            {nFilters > 0 && <span className="count">{nFilters}</span>}
          </button>
          <div className="menu-wrap">
            <button type="button" className="btn btn-icon" onClick={() => setMenuOpen(!menuOpen)} aria-label="Channel actions" aria-expanded={menuOpen}>
              <Icon name="settings" size={17} />
            </button>
            {menuOpen && (
              <div className="menu" role="menu" onMouseLeave={() => setMenuOpen(false)}>
                <button type="button" role="menuitem" onClick={markAllRead}>
                  <Icon name="check" size={15} /> Mark all as read
                </button>
                {channel && (
                  <>
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onEditChannel(channel); }}>
                      <Icon name="edit" size={15} /> Edit channel
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setConfirm("archive"); }}>
                      <Icon name="archive" size={15} /> Archive history
                    </button>
                    <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); setConfirm("delete"); }}>
                      <Icon name="trash" size={15} /> Clear history
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {showFilters && (
        <div className="filters">
          <div className="filter-group">
            <span className="filter-label">Status</span>
            {STATUSES.map((s) => (
              <button key={s} type="button" className={`chip chip-${s} ${filters.status.includes(s) ? "is-on" : ""}`} aria-pressed={filters.status.includes(s)} onClick={() => setFilters({ ...filters, status: toggleIn(filters.status, s) })}>
                <Icon name={s} size={13} /> {s}
              </button>
            ))}
          </div>
          <div className="filter-group">
            <span className="filter-label">Type</span>
            {KINDS.map(([k, label]) => (
              <button key={k} type="button" className={`chip ${filters.kind.includes(k) ? "is-on" : ""}`} aria-pressed={filters.kind.includes(k)} onClick={() => setFilters({ ...filters, kind: toggleIn(filters.kind, k) })}>
                {label}
              </button>
            ))}
            <button type="button" className={`chip ${filters.hasAttachments ? "is-on" : ""}`} aria-pressed={filters.hasAttachments} onClick={() => setFilters({ ...filters, hasAttachments: !filters.hasAttachments })}>
              <Icon name="file" size={13} /> Has files
            </button>
            <button type="button" className={`chip ${filters.pinned ? "is-on" : ""}`} aria-pressed={filters.pinned} onClick={() => setFilters({ ...filters, pinned: !filters.pinned })}>
              <Icon name="pin" size={13} /> Pinned
            </button>
            <button type="button" className={`chip ${filters.unread ? "is-on" : ""}`} aria-pressed={filters.unread} onClick={() => setFilters({ ...filters, unread: !filters.unread })}>
              Unread
            </button>
          </div>
          <div className="filter-group">
            <label className="filter-inline">
              <span className="filter-label">From</span>
              <input type="date" value={filters.since} max={filters.until || undefined} onChange={(e) => setFilters({ ...filters, since: e.target.value })} />
            </label>
            <label className="filter-inline">
              <span className="filter-label">To</span>
              <input type="date" value={filters.until} min={filters.since || undefined} onChange={(e) => setFilters({ ...filters, until: e.target.value })} />
            </label>
            <label className="filter-inline">
              <span className="filter-label">Source</span>
              <select value={filters.webhookId ?? ""} onChange={(e) => setFilters({ ...filters, webhookId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">All sources</option>
                {scopeHooks.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </label>
            <label className="filter-inline">
              <span className="filter-label">Archive</span>
              <select value={filters.archived} onChange={(e) => setFilters({ ...filters, archived: e.target.value as MessageFilters["archived"] })}>
                <option value="exclude">Hide archived</option>
                <option value="include">Include archived</option>
                <option value="only">Only archived</option>
              </select>
            </label>
            {nFilters > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters({ ...emptyFilters, q: filters.q })}>
                Clear filters
              </button>
            )}
          </div>
        </div>
      )}

      <div className="feed-scroll" ref={scroller} onScroll={onScroll}>
        {loading ? (
          <div className="feed-skeleton" aria-busy="true" aria-label="Loading messages">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skel-msg" style={{ animationDelay: `${i * 90}ms` }}>
                <span className="skel skel-avatar" />
                <span className="skel-lines">
                  <span className="skel skel-line w30" />
                  <span className="skel skel-line w80" />
                  <span className="skel skel-line w60" />
                </span>
              </div>
            ))}
          </div>
        ) : error ? (
          <Empty icon="error" title="Couldn't load messages">
            <p>{error}</p>
            <button type="button" className="btn btn-primary" onClick={() => void load()}>
              <Icon name="refresh" size={15} /> Try again
            </button>
          </Empty>
        ) : messages.length === 0 ? (
          filtered ? (
            <Empty icon="search" title="No messages match">
              <p>Try a different search or clear the filters.</p>
            </Empty>
          ) : (
            <Empty icon="inbox" title={channel ? `Nothing in ${channel.name} yet` : "No messages yet"}>
              <p>{scopeHooks.length ? "Messages appear here the moment a source posts to its webhook URL." : "Create a webhook, paste its URL and secret into your app, and messages will stream in here."}</p>
              <button type="button" className="btn btn-primary" onClick={onNewWebhook}>
                <Icon name="plus" size={15} /> New webhook
              </button>
            </Empty>
          )
        ) : (
          <div className="feed-list">
            {hasMore ? (
              <div className="feed-older">
                {loadingOlder ? <Spinner /> : <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadOlder()}>Load older messages</button>}
              </div>
            ) : (
              <div className="feed-start">
                <Icon name="spark" size={14} /> Start of {channel ? channel.name : "your history"}
              </div>
            )}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const newDay = !prev || !sameDay(prev.created_at, m.created_at);
              const grouped =
                !!prev && !newDay && prev.webhook_id === m.webhook_id && prev.sender.name === m.sender.name && prev.status === m.status && !m.pinned &&
                (parseIso(m.created_at)!.getTime() - parseIso(prev.created_at)!.getTime()) < 5 * 60 * 1000 && m.id !== firstUnreadId;
              return (
                <div key={m.id} className="feed-row">
                  {newDay && (
                    <div className="day-sep">
                      <span>{dayLabel(m.created_at)}</span>
                    </div>
                  )}
                  {m.id === firstUnreadId && (
                    <div className="new-sep">
                      <span>New</span>
                    </div>
                  )}
                  <MessageItem
                    message={m}
                    selected={m.id === selectedId}
                    compactHeader={grouped}
                    onSelect={onSelect}
                    onTogglePin={togglePin}
                    onToggleRead={toggleRead}
                    channelName={channelId === null ? channelNames.get(m.channel_id) : undefined}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {newBelow > 0 && (
        <button type="button" className="jump" onClick={jumpToBottom}>
          <Icon name="chevron-down" size={15} /> {newBelow} new message{newBelow === 1 ? "" : "s"}
        </button>
      )}

      {confirm && channel && (
        <Confirm
          title={confirm === "archive" ? `Archive ${channel.name}?` : `Clear ${channel.name}?`}
          danger={confirm === "delete"}
          confirmLabel={confirm === "archive" ? "Archive history" : "Delete messages"}
          body={
            confirm === "archive" ? (
              <p>Every message in this channel moves to the archive and is marked read. Pinned messages stay. Archived messages stay searchable with the Archive filter.</p>
            ) : (
              <p>This permanently deletes every unpinned message in <strong>{channel.name}</strong> and its stored files. This can't be undone.</p>
            )
          }
          onConfirm={async () => {
            try {
              await history(confirm);
            } catch (e) {
              toast(e instanceof ApiError ? e.message : "Failed", "error");
            }
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </section>
  );
}
