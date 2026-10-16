import { BrandMark, Icon } from "../icons";
import type { LiveStatus } from "../live";
import type { Channel, User, Webhook } from "../types";
import { Avatar } from "./ui";
import type { Route } from "../route";

const LIVE_TEXT: Record<LiveStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

export function Sidebar({ route, channels, webhooks, user, live, theme, onNavigate, onNewChannel, onNewWebhook, onLogout, onToggleTheme, onClose }: {
  route: Route;
  channels: Channel[];
  webhooks: Webhook[];
  user: User;
  live: LiveStatus;
  theme: "dark" | "light";
  onNavigate: (r: Route) => void;
  onNewChannel: () => void;
  onNewWebhook: () => void;
  onLogout: () => void;
  onToggleTheme: () => void;
  onClose: () => void;
}) {
  const totalUnread = channels.reduce((n, c) => n + c.unread, 0);
  const isFeed = route.view === "feed";
  return (
    <nav className="sidebar" aria-label="Channels and sources">
      <div className="side-brand">
        <BrandMark />
        <div className="side-brand-text">
          <strong>Relay</strong>
          <span>Webhook Center</span>
        </div>
        <button type="button" className="btn btn-icon only-mobile" onClick={onClose} aria-label="Close sidebar">
          <Icon name="x" />
        </button>
      </div>

      <div className="side-scroll">
        <div className="side-section">
          <button type="button" className={`side-item ${isFeed && route.channelId === null ? "is-on" : ""}`} onClick={() => onNavigate({ view: "feed", channelId: null })}>
            <Icon name="inbox" size={17} />
            <span className="side-label">All messages</span>
            {totalUnread > 0 && <span className="unread">{totalUnread > 999 ? "999+" : totalUnread}</span>}
          </button>
          <button type="button" className={`side-item ${route.view === "webhooks" ? "is-on" : ""}`} onClick={() => onNavigate({ view: "webhooks", webhookId: null })}>
            <Icon name="zap" size={17} />
            <span className="side-label">Webhook Center</span>
          </button>
          <button type="button" className={`side-item ${route.view === "docs" ? "is-on" : ""}`} onClick={() => onNavigate({ view: "docs" })}>
            <Icon name="book" size={17} />
            <span className="side-label">Docs</span>
          </button>
          <button type="button" className={`side-item ${route.view === "audit" ? "is-on" : ""}`} onClick={() => onNavigate({ view: "audit" })}>
            <Icon name="shield" size={17} />
            <span className="side-label">Audit log</span>
          </button>
        </div>

        <div className="side-section">
          <div className="side-heading">
            <span>Channels</span>
            <button type="button" className="btn btn-icon btn-xs" onClick={onNewChannel} aria-label="New channel" title="New channel">
              <Icon name="plus" size={14} />
            </button>
          </div>
          {channels.map((c) => {
            const on = isFeed && route.channelId === c.id;
            return (
              <button key={c.id} type="button" className={`side-item ${on ? "is-on" : ""} ${c.unread ? "has-unread" : ""}`} onClick={() => onNavigate({ view: "feed", channelId: c.id })} title={c.description || c.name}>
                <span className="side-chan-icon" style={{ color: c.color }}>
                  <Icon name={c.icon} size={16} />
                </span>
                <span className="side-label">{c.name}</span>
                {c.unread > 0 && <span className="unread">{c.unread > 999 ? "999+" : c.unread}</span>}
              </button>
            );
          })}
        </div>

        <div className="side-section">
          <div className="side-heading">
            <span>Sources</span>
            <button type="button" className="btn btn-icon btn-xs" onClick={onNewWebhook} aria-label="New webhook" title="New webhook">
              <Icon name="plus" size={14} />
            </button>
          </div>
          {webhooks.length === 0 && <p className="side-empty">No webhooks yet.</p>}
          {webhooks.map((w) => {
            const on = route.view === "webhooks" && route.webhookId === w.id;
            return (
              <button key={w.id} type="button" className={`side-item side-source ${on ? "is-on" : ""} ${w.enabled ? "" : "is-off"}`} onClick={() => onNavigate({ view: "webhooks", webhookId: w.id })}>
                <Avatar icon={w.icon} color={w.color} size={22} />
                <span className="side-label">{w.name}</span>
                <span className={`src-dot ${!w.enabled ? "off" : !w.has_secret ? "warn" : (w.stats.errors_24h ?? 0) > 0 ? "warn" : w.last_used_at ? "ok" : "idle"}`} aria-hidden />
              </button>
            );
          })}
        </div>
      </div>

      <div className="side-foot">
        <span className={`live live-${live}`} title="Real-time connection">
          <span className="dot" /> {LIVE_TEXT[live]}
        </span>
        <div className="side-user">
          <span className="side-user-name" title={user.username}>{user.display_name}</span>
          <button type="button" className="btn btn-icon btn-xs" onClick={onToggleTheme} aria-label="Toggle theme" title="Toggle theme">
            <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
          </button>
          <button type="button" className="btn btn-icon btn-xs" onClick={onLogout} aria-label="Sign out" title="Sign out">
            <Icon name="logout" size={15} />
          </button>
        </div>
      </div>
    </nav>
  );
}
