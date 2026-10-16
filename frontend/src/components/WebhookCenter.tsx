import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { bus } from "../bus";
import { formatBytes, fullTime, relative, safeColor } from "../format";
import { Icon } from "../icons";
import type { Channel, Delivery, Overview, Webhook } from "../types";
import { Avatar, Confirm, CopyButton, Empty, Sparkline, Spinner, useToast } from "./ui";
import { SecretReveal, WebhookDialog } from "./WebhookDialog";

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "error" | "ok" }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? "is-on" : ""}`} onClick={(e) => { e.stopPropagation(); onChange(!on); }}>
      <span className="toggle-knob" />
    </button>
  );
}

function healthOf(w: Webhook): { tone: "ok" | "warn" | "off" | "idle"; text: string } {
  if (!w.enabled) return { tone: "off", text: "Disabled" };
  if (!w.has_secret) return { tone: "warn", text: "No credential" };
  const errs = w.stats.errors_24h ?? 0;
  const n = w.stats.deliveries_24h ?? 0;
  if (n === 0) return { tone: "idle", text: w.last_used_at ? "Quiet today" : "Waiting for first message" };
  if (errs / n > 0.2) return { tone: "warn", text: `${errs} failed today` };
  return { tone: "ok", text: "Delivering" };
}

function DeliveryRow({ d }: { d: Delivery }) {
  return (
    <tr className={d.ok ? "" : "is-error"}>
      <td>
        <span className={`code-badge ${d.ok ? "ok" : d.status_code >= 500 ? "err" : "warn"}`}>{d.status_code}</span>
      </td>
      <td title={fullTime(d.received_at)}>{relative(d.received_at)}</td>
      <td className="mono small">{d.request_id}</td>
      <td className="truncate">{d.error_code ? <span title={d.error_detail ?? ""}>{d.error_code}{d.error_detail ? ` · ${d.error_detail}` : ""}</span> : d.duplicate ? "duplicate (replayed)" : `${d.attachment_count ? `${d.attachment_count} file${d.attachment_count > 1 ? "s" : ""} · ` : ""}${formatBytes(d.body_bytes)}`}</td>
      <td className="num">{d.duration_ms} ms</td>
      <td className="truncate hide-md small muted">{d.source_ip}</td>
    </tr>
  );
}

export function WebhookDetail({ webhook, channels, onBack, onChanged, onOpenFeed, onDeleted }: {
  webhook: Webhook;
  channels: Channel[];
  onBack?: () => void;
  onChanged: (w: Webhook) => void;
  onOpenFeed: (w: Webhook) => void;
  onDeleted: () => void;
}) {
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<null | "rotate" | "revoke" | "url" | "delete">(null);
  const [deleteMessages, setDeleteMessages] = useState(false);
  const [testing, setTesting] = useState(false);
  const toast = useToast();
  const channel = channels.find((c) => c.id === webhook.channel_id);
  const health = healthOf(webhook);

  const loadDeliveries = useCallback(async () => {
    try {
      setDeliveries((await api.deliveries(webhook.id, errorsOnly)).deliveries);
    } catch {
      setDeliveries([]);
    }
  }, [webhook.id, errorsOnly]);

  useEffect(() => {
    setDeliveries(null);
    void loadDeliveries();
  }, [loadDeliveries]);

  useEffect(
    () =>
      bus.on((type, data) => {
        if (type === "delivery" && (data as { webhook_id: number }).webhook_id === webhook.id) void loadDeliveries();
      }),
    [webhook.id, loadDeliveries],
  );

  const act = async (fn: () => Promise<{ webhook: Webhook; secret?: string }>, done: string) => {
    try {
      const res = await fn();
      onChanged(res.webhook);
      if (res.secret) setSecret(res.secret);
      else toast(done);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Action failed", "error");
    }
  };

  const s = webhook.stats;
  return (
    <div className="hook-detail">
      <div className="hook-detail-head">
        {onBack && (
          <button type="button" className="btn btn-icon" onClick={onBack} aria-label="Back to webhooks">
            <Icon name="chevron-right" style={{ transform: "rotate(180deg)" }} />
          </button>
        )}
        <Avatar icon={webhook.icon} color={webhook.color} size={46} />
        <div className="hook-detail-title">
          <h2>{webhook.name}</h2>
          <p className="muted">
            {webhook.description || "No description"} · posts to <strong>{channel?.name ?? "?"}</strong>
          </p>
        </div>
        <div className="hook-detail-actions">
          <span className={`health health-${health.tone}`}>
            <span className="dot" /> {health.text}
          </span>
          <Toggle on={webhook.enabled} label={webhook.enabled ? "Disable webhook" : "Enable webhook"} onChange={(v) => act(() => api.updateWebhook(webhook.id, { enabled: v }), v ? "Webhook enabled" : "Webhook disabled")} />
        </div>
      </div>

      <div className="hook-grid">
        <section className="card">
          <h3 className="card-title"><Icon name="link" size={15} /> Endpoint</h3>
          <div className="copy-row">
            <code className="mono-box">{webhook.url}</code>
            <CopyButton text={webhook.url} label="Copy URL" />
          </div>
          <div className="kv">
            <span>Secret</span>
            <span>
              {webhook.has_secret ? (
                <>
                  <code className="mono">rls_••••••••{webhook.secret_hint}</code>
                  <span className="muted small"> · issued {relative(webhook.secret_rotated_at)}</span>
                </>
              ) : (
                <span className="text-warn">Revoked. Requests are refused until you issue a new secret.</span>
              )}
            </span>
            <span>Last used</span>
            <span title={fullTime(webhook.last_used_at)}>{relative(webhook.last_used_at)}</span>
            <span>Created</span>
            <span>{fullTime(webhook.created_at)}</span>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm("rotate")}>
              <Icon name="key" size={15} /> {webhook.has_secret ? "Rotate secret" : "Issue new secret"}
            </button>
            {webhook.has_secret && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm("revoke")}>
                <Icon name="power" size={15} /> Revoke
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm("url")}>
              <Icon name="refresh" size={15} /> New URL
            </button>
          </div>
        </section>

        <section className="card">
          <h3 className="card-title"><Icon name="activity" size={15} /> Last 24 hours</h3>
          <div className="stats">
            <Stat label="requests" value={s.deliveries_24h ?? 0} />
            <Stat label="failed" value={s.errors_24h ?? 0} tone={(s.errors_24h ?? 0) > 0 ? "error" : undefined} />
            <Stat label="success" value={s.success_rate_24h == null ? "—" : `${s.success_rate_24h}%`} tone={s.success_rate_24h != null && s.success_rate_24h >= 99 ? "ok" : undefined} />
            <Stat label="avg latency" value={s.avg_ms_24h == null ? "—" : `${Math.round(s.avg_ms_24h)} ms`} />
          </div>
          <Sparkline values={s.hourly ?? []} color={safeColor(webhook.color)} height={44} />
          <div className="spark-axis"><span>24h ago</span><span>{s.messages ?? 0} messages stored</span><span>now</span></div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                try {
                  await api.sendTest(webhook.id);
                  toast("Test message sent");
                } catch (e) {
                  toast(e instanceof ApiError ? e.message : "Failed", "error");
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? <Spinner /> : <Icon name="send" size={15} />} Send test message
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenFeed(webhook)}>
              <Icon name="list" size={15} /> View messages
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
              <Icon name="edit" size={15} /> Edit
            </button>
            <button type="button" className="btn btn-ghost btn-sm danger" onClick={() => setConfirm("delete")}>
              <Icon name="trash" size={15} /> Delete
            </button>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-title-row">
          <h3 className="card-title"><Icon name="clock" size={15} /> Recent requests</h3>
          <div className="seg">
            <button type="button" className={!errorsOnly ? "is-on" : ""} onClick={() => setErrorsOnly(false)}>All</button>
            <button type="button" className={errorsOnly ? "is-on" : ""} onClick={() => setErrorsOnly(true)}>Errors</button>
          </div>
        </div>
        {deliveries === null ? (
          <div className="center-pad"><Spinner /></div>
        ) : deliveries.length === 0 ? (
          <p className="muted center-pad">{errorsOnly ? "No failed requests. Nice." : "No requests yet. Send one with the example in Docs."}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>When</th>
                  <th>Request ID</th>
                  <th>Result</th>
                  <th className="num">Time</th>
                  <th className="hide-md">Source IP</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <DeliveryRow key={d.id} d={d} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {secret && <SecretReveal webhook={webhook} secret={secret} rotated onDone={() => setSecret(null)} />}
      {editing && (
        <WebhookDialog channels={channels} existing={webhook} onClose={() => setEditing(false)} onSaved={(w) => { onChanged(w); setEditing(false); toast("Saved"); }} />
      )}
      {confirm === "rotate" && (
        <Confirm title={webhook.has_secret ? "Rotate secret?" : "Issue a new secret?"} confirmLabel={webhook.has_secret ? "Rotate now" : "Issue secret"} onClose={() => setConfirm(null)}
          body={<p>{webhook.has_secret ? "The current secret stops working immediately. Update every app that uses it with the new one." : "A new secret will be generated and shown once."}</p>}
          onConfirm={() => act(() => api.rotateSecret(webhook.id), "Secret rotated")} />
      )}
      {confirm === "revoke" && (
        <Confirm title="Revoke secret?" danger confirmLabel="Revoke" onClose={() => setConfirm(null)}
          body={<p>All requests to this webhook will be refused with 401 until you issue a new secret. Its history stays.</p>}
          onConfirm={() => act(() => api.revokeSecret(webhook.id), "Secret revoked")} />
      )}
      {confirm === "url" && (
        <Confirm title="Generate a new URL?" confirmLabel="Generate" onClose={() => setConfirm(null)}
          body={<p>The current URL stops working right away. The secret doesn't change.</p>}
          onConfirm={() => act(() => api.regenerateUrl(webhook.id), "New URL generated")} />
      )}
      {confirm === "delete" && (
        <Confirm title={`Delete ${webhook.name}?`} danger confirmLabel="Delete webhook" onClose={() => setConfirm(null)}
          body={<p>Its URL and secret stop working permanently.</p>}
          onConfirm={async () => {
            try {
              await api.deleteWebhook(webhook.id, deleteMessages);
              toast("Webhook deleted");
              onDeleted();
            } catch (e) {
              toast(e instanceof ApiError ? e.message : "Failed", "error");
            }
          }}>
          <label className="check">
            <input type="checkbox" checked={deleteMessages} onChange={(e) => setDeleteMessages(e.target.checked)} />
            <span>Also delete its {s.messages ?? 0} message{s.messages === 1 ? "" : "s"} and files</span>
          </label>
        </Confirm>
      )}
    </div>
  );
}

export function WebhookCenter({ webhooks, channels, overview, selectedId, onSelect, onNew, onChanged, onOpenFeed, onDeleted, onOpenSidebar, loading }: {
  webhooks: Webhook[];
  channels: Channel[];
  overview: Overview | null;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onNew: () => void;
  onChanged: (w: Webhook) => void;
  onOpenFeed: (w: Webhook) => void;
  onDeleted: () => void;
  onOpenSidebar: () => void;
  loading: boolean;
}) {
  const selected = webhooks.find((w) => w.id === selectedId) ?? null;
  const toast = useToast();
  const channelName = (id: number) => channels.find((c) => c.id === id)?.name ?? "—";

  return (
    <section className="center" aria-label="Webhook Center">
      <header className="feed-head">
        <button type="button" className="btn btn-icon only-mobile" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Icon name="menu" />
        </button>
        <div className="feed-title">
          <span className="feed-title-icon"><Icon name="zap" size={18} /></span>
          <div className="feed-title-text">
            <h1>Webhook Center</h1>
            <p>Endpoints, credentials and delivery health</p>
          </div>
        </div>
        <div className="feed-tools">
          <button type="button" className="btn btn-primary" onClick={onNew}>
            <Icon name="plus" size={15} /> <span>New webhook</span>
          </button>
        </div>
      </header>
      <div className="center-scroll">
        {selected ? (
          <WebhookDetail key={selected.id} webhook={selected} channels={channels} onBack={() => onSelect(null)} onChanged={onChanged} onOpenFeed={onOpenFeed} onDeleted={() => { onSelect(null); onDeleted(); }} />
        ) : (
          <>
            {overview && (
              <div className="overview">
                <Stat label="webhooks active" value={`${overview.webhooks_enabled}/${overview.webhooks}`} />
                <Stat label="messages today" value={overview.messages_24h} />
                <Stat label="requests today" value={overview.deliveries_24h} />
                <Stat label="failed today" value={overview.errors_24h} tone={overview.errors_24h ? "error" : undefined} />
                <Stat label="unread" value={overview.unread} />
              </div>
            )}
            {loading ? (
              <div className="center-pad"><Spinner size={20} /></div>
            ) : webhooks.length === 0 ? (
              <Empty icon="zap" title="Create your first webhook">
                <p>Each webhook gets its own URL and secret. Anything that can make an HTTP request (a script, a CI job, an AI agent) can post messages and files to it.</p>
                <button type="button" className="btn btn-primary" onClick={onNew}><Icon name="plus" size={15} /> New webhook</button>
              </Empty>
            ) : (
              <div className="hook-cards">
                {webhooks.map((w) => {
                  const h = healthOf(w);
                  return (
                    <div key={w.id} className={`hook-card ${w.enabled ? "" : "is-off"}`} role="button" tabIndex={0} onClick={() => onSelect(w.id)} onKeyDown={(e) => e.key === "Enter" && onSelect(w.id)}>
                      <div className="hook-card-head">
                        <Avatar icon={w.icon} color={w.color} size={38} />
                        <div className="hook-card-title">
                          <strong>{w.name}</strong>
                          <span className="muted small"># {channelName(w.channel_id)}</span>
                        </div>
                        <Toggle on={w.enabled} label={w.enabled ? `Disable ${w.name}` : `Enable ${w.name}`} onChange={async (v) => {
                          try {
                            onChanged((await api.updateWebhook(w.id, { enabled: v })).webhook);
                          } catch (e) {
                            toast(e instanceof ApiError ? e.message : "Failed", "error");
                          }
                        }} />
                      </div>
                      {w.description && <p className="hook-card-desc">{w.description}</p>}
                      <Sparkline values={w.stats.hourly ?? []} color={safeColor(w.color)} />
                      <div className="hook-card-foot">
                        <span className={`health health-${h.tone}`}><span className="dot" /> {h.text}</span>
                        <span className="muted small">{w.stats.messages ?? 0} msgs · {relative(w.last_used_at)}</span>
                      </div>
                      <div className="hook-card-url" onClick={(e) => e.stopPropagation()}>
                        <code className="mono truncate">{w.url}</code>
                        <CopyButton text={w.url} compact label="Copy URL" />
                      </div>
                    </div>
                  );
                })}
                <button type="button" className="hook-card hook-card-new" onClick={onNew}>
                  <Icon name="plus" size={22} />
                  <span>New webhook</span>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
