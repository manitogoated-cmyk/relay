import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { bus } from "./bus";
import { AuditView } from "./components/AuditView";
import { AuthScreen } from "./components/AuthScreen";
import { ChannelDialog } from "./components/ChannelDialog";
import { MessageDetails } from "./components/DetailsPanel";
import { DocsPanel } from "./components/DocsPanel";
import { Feed } from "./components/Feed";
import { Sidebar } from "./components/Sidebar";
import { Spinner, useToast } from "./components/ui";
import { WebhookCenter } from "./components/WebhookCenter";
import { SecretReveal, WebhookDialog } from "./components/WebhookDialog";
import { BrandMark } from "./icons";
import { useLiveStream } from "./live";
import { parseRoute, routeHash, type Route } from "./route";
import type { AppConfig, AuthState, Channel, Message, Overview, User, Webhook } from "./types";

type Theme = "dark" | "light";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem("relay.theme");
    if (t === "dark" || t === "light") return t;
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function useDebounced(fn: () => void, ms: number): () => void {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => ref.current(), ms);
  }, [ms]);
}

function Workspace({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [channels, setChannels] = useState<Channel[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [hooksLoaded, setHooksLoaded] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selected, setSelected] = useState<Message | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newWebhook, setNewWebhook] = useState(false);
  const [revealed, setRevealed] = useState<{ webhook: Webhook; secret: string } | null>(null);
  const [channelDialog, setChannelDialog] = useState<{ existing?: Channel } | null>(null);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const toast = useToast();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("relay.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((r: Route) => {
    const h = routeHash(r);
    if (window.location.hash !== h) window.location.hash = h;
    setRoute(r);
    setSidebarOpen(false);
    setSelected(null);
  }, []);

  const handleAuthError = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onSignedOut();
    },
    [onSignedOut],
  );

  const loadChannels = useCallback(() => api.channels().then((r) => setChannels(r.channels)).catch(handleAuthError), [handleAuthError]);
  const loadWebhooks = useCallback(
    () => api.webhooks().then((r) => { setWebhooks(r.webhooks); setHooksLoaded(true); }).catch(handleAuthError),
    [handleAuthError],
  );
  const loadOverview = useCallback(() => api.overview().then(setOverview).catch(() => {}), []);

  useEffect(() => {
    void loadChannels();
    void loadWebhooks();
    void loadOverview();
    api.config().then(setConfig).catch(() => {});
  }, [loadChannels, loadWebhooks, loadOverview]);

  const refreshChannels = useDebounced(() => void loadChannels(), 250);
  const refreshWebhooks = useDebounced(() => void loadWebhooks(), 400);
  const refreshOverview = useDebounced(() => void loadOverview(), 800);

  const live = useLiveStream(true, {
    onEvent: (type, data) => {
      bus.emit(type, data);
      if (type === "message.created" || type === "channels.changed" || type === "message.deleted") {
        refreshChannels();
        refreshOverview();
      }
      if (type === "webhooks.changed" || type === "delivery" || type === "message.created") refreshWebhooks();
      if (type === "message.updated") {
        const m = (data as { message: Message }).message;
        setSelected((cur) => (cur && cur.id === m.id ? m : cur));
      }
      if (type === "message.deleted") {
        const id = (data as { id: number }).id;
        setSelected((cur) => (cur && cur.id === id ? null : cur));
      }
    },
    onResync: () => {
      void loadChannels();
      void loadWebhooks();
      void loadOverview();
      bus.emit("resync", null);
    },
    onSignedOut,
  });

  const unread = channels.reduce((n, c) => n + c.unread, 0);
  useEffect(() => {
    document.title = unread ? `(${unread > 99 ? "99+" : unread}) Relay` : "Relay · Webhook Center";
  }, [unread]);

  const channel = route.view === "feed" && route.channelId !== null ? channels.find((c) => c.id === route.channelId) ?? null : null;
  const defaultChannelId = channel?.id ?? null;

  const upsertWebhook = useCallback((w: Webhook) => {
    setWebhooks((cur) => (cur.some((x) => x.id === w.id) ? cur.map((x) => (x.id === w.id ? w : x)) : [...cur, w]));
  }, []);

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      onSignedOut();
    }
  };

  const feedKey = useMemo(() => (route.view === "feed" ? `${route.channelId}-${route.webhookId ?? ""}` : ""), [route]);

  let center;
  if (route.view === "webhooks") {
    center = (
      <WebhookCenter
        webhooks={webhooks}
        channels={channels}
        overview={overview}
        loading={!hooksLoaded}
        selectedId={route.webhookId}
        onSelect={(id) => navigate({ view: "webhooks", webhookId: id })}
        onNew={() => setNewWebhook(true)}
        onChanged={upsertWebhook}
        onOpenFeed={(w) => navigate({ view: "feed", channelId: null, webhookId: w.id })}
        onDeleted={() => {
          void loadWebhooks();
          void loadChannels();
        }}
        onOpenSidebar={() => setSidebarOpen(true)}
      />
    );
  } else if (route.view === "docs") {
    center = <DocsPanel webhooks={webhooks} config={config} onOpenSidebar={() => setSidebarOpen(true)} />;
  } else if (route.view === "audit") {
    center = <AuditView onOpenSidebar={() => setSidebarOpen(true)} />;
  } else if (route.channelId !== null && !channel && channels.length) {
    center = (
      <section className="center">
        <div className="empty"><h3>That channel doesn't exist anymore.</h3><button type="button" className="btn btn-primary" onClick={() => navigate({ view: "feed", channelId: null })}>Go to all messages</button></div>
      </section>
    );
  } else {
    center = (
      <Feed
        key={feedKey}
        channel={channel}
        channels={channels}
        webhooks={webhooks}
        selectedId={selected?.id ?? null}
        onSelect={setSelected}
        onMessageChange={(m) => setSelected((cur) => (cur && cur.id === m.id ? m : cur))}
        onOpenSidebar={() => setSidebarOpen(true)}
        onNewWebhook={() => setNewWebhook(true)}
        onEditChannel={(c) => setChannelDialog({ existing: c })}
        initialWebhookId={route.webhookId ?? null}
      />
    );
  }

  return (
    <div className={`shell ${selected ? "has-details" : ""} ${sidebarOpen ? "sidebar-open" : ""}`}>
      <Sidebar
        route={route}
        channels={channels}
        webhooks={webhooks}
        user={user}
        live={live}
        theme={theme}
        onNavigate={navigate}
        onNewChannel={() => setChannelDialog({})}
        onNewWebhook={() => setNewWebhook(true)}
        onLogout={logout}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="scrim" onClick={() => { setSidebarOpen(false); setSelected(null); }} aria-hidden />
      <main className="main">
        {live !== "live" && live !== "connecting" && (
          <div className={`conn-banner conn-${live}`} role="status">
            <Spinner size={12} /> {live === "offline" ? "You're offline. New messages will appear when the connection returns." : "Live updates interrupted. Reconnecting…"}
          </div>
        )}
        {center}
      </main>
      {selected && (
        <MessageDetails
          message={selected}
          channels={channels}
          webhooks={webhooks}
          onClose={() => setSelected(null)}
          onChanged={(m) => {
            setSelected(m);
            bus.emit("message.updated", { message: m });
          }}
          onDeleted={(id) => {
            setSelected(null);
            bus.emit("message.deleted", { id });
          }}
          onOpenWebhook={(id) => navigate({ view: "webhooks", webhookId: id })}
        />
      )}

      {newWebhook && (
        <WebhookDialog
          channels={channels}
          defaultChannelId={defaultChannelId}
          onClose={() => setNewWebhook(false)}
          onSaved={(w, secret) => {
            setNewWebhook(false);
            upsertWebhook(w);
            if (secret) setRevealed({ webhook: w, secret });
          }}
        />
      )}
      {revealed && (
        <SecretReveal
          webhook={revealed.webhook}
          secret={revealed.secret}
          onDone={() => {
            const id = revealed.webhook.id;
            setRevealed(null);
            navigate({ view: "webhooks", webhookId: id });
          }}
        />
      )}
      {channelDialog && (
        <ChannelDialog
          existing={channelDialog.existing}
          channels={channels}
          onClose={() => setChannelDialog(null)}
          onSaved={(c) => {
            setChannelDialog(null);
            void loadChannels();
            toast(channelDialog.existing ? "Channel saved" : `Created ${c.name}`);
            if (!channelDialog.existing) navigate({ view: "feed", channelId: c.id });
          }}
          onDeleted={() => {
            setChannelDialog(null);
            void loadChannels();
            void loadWebhooks();
            toast("Channel deleted");
            navigate({ view: "feed", channelId: null });
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const check = useCallback(() => {
    setFailed(null);
    api.authState().then(setAuth).catch((e) => setFailed(e instanceof ApiError ? e.message : "Can't reach the server."));
  }, []);
  useEffect(check, [check]);

  if (failed) {
    return (
      <main className="auth">
        <div className="auth-card">
          <div className="auth-brand"><BrandMark size={40} /><div><h1>Relay</h1><p>Webhook Center</p></div></div>
          <p className="form-error">{failed}</p>
          <button type="button" className="btn btn-primary btn-block" onClick={check}>Retry</button>
        </div>
      </main>
    );
  }
  if (!auth) {
    return (
      <div className="boot" aria-busy="true">
        <BrandMark size={44} />
      </div>
    );
  }
  if (!auth.user) {
    return (
      <AuthScreen
        mode={auth.setup_required ? "setup" : "login"}
        needsToken={auth.setup_needs_token}
        onDone={(user) => setAuth({ ...auth, setup_required: false, user })}
      />
    );
  }
  return <Workspace user={auth.user} onSignedOut={() => setAuth({ ...auth, user: null, setup_required: false })} />;
}
