import { useEffect, useState } from "react";
import { api } from "../api";
import { fullTime, relative } from "../format";
import { Icon } from "../icons";
import type { AuditEntry } from "../types";
import { Empty, Spinner } from "./ui";

const LABELS: Record<string, [string, string]> = {
  "webhook.created": ["Webhook created", "plus"],
  "webhook.updated": ["Webhook edited", "edit"],
  "webhook.enabled": ["Webhook enabled", "power"],
  "webhook.disabled": ["Webhook disabled", "power"],
  "webhook.secret_rotated": ["Secret rotated", "key"],
  "webhook.secret_issued": ["Secret issued", "key"],
  "webhook.secret_revoked": ["Secret revoked", "key"],
  "webhook.url_regenerated": ["URL regenerated", "refresh"],
  "webhook.deleted": ["Webhook deleted", "trash"],
  "channel.created": ["Channel created", "hash"],
  "channel.updated": ["Channel edited", "edit"],
  "channel.deleted": ["Channel deleted", "trash"],
  "history.archive": ["History archived", "archive"],
  "history.delete": ["History cleared", "trash"],
  "message.deleted": ["Message deleted", "trash"],
  "login.succeeded": ["Signed in", "logout"],
  "login.failed": ["Failed sign-in", "alert"],
  "account.created": ["Account created", "shield"],
  "password.changed": ["Password changed", "key"],
};

function describe(e: AuditEntry): string {
  const d = e.details as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof d.name === "string") bits.push(d.name);
  if (Array.isArray(d.fields)) bits.push(`changed ${d.fields.join(", ")}`);
  if (typeof d.count === "number") bits.push(`${d.count} messages`);
  if (typeof d.messages_deleted === "number" && d.messages_deleted) bits.push(`${d.messages_deleted} messages deleted`);
  return bits.join(" · ");
}

export function AuditView({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    api.audit().then((r) => setEntries(r.entries)).catch(() => setEntries([]));
  }, []);
  return (
    <section className="center" aria-label="Audit log">
      <header className="feed-head">
        <button type="button" className="btn btn-icon only-mobile" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Icon name="menu" />
        </button>
        <div className="feed-title">
          <span className="feed-title-icon"><Icon name="shield" size={18} /></span>
          <div className="feed-title-text">
            <h1>Audit log</h1>
            <p>Credential, webhook and account changes</p>
          </div>
        </div>
      </header>
      <div className="center-scroll">
        {entries === null ? (
          <div className="center-pad"><Spinner size={20} /></div>
        ) : entries.length === 0 ? (
          <Empty icon="shield" title="Nothing recorded yet" />
        ) : (
          <ol className="audit">
            {entries.map((e) => {
              const [label, icon] = LABELS[e.action] ?? [e.action, "info"];
              return (
                <li key={e.id} className={`audit-row ${e.action.includes("failed") || e.action.includes("revoked") || e.action.includes("deleted") ? "is-alert" : ""}`}>
                  <span className="audit-icon"><Icon name={icon} size={15} /></span>
                  <span className="audit-main">
                    <strong>{label}</strong>
                    <span className="muted">{describe(e)}</span>
                  </span>
                  <span className="audit-meta muted small" title={fullTime(e.created_at)}>
                    {e.actor} · {e.source_ip || "local"} · {relative(e.created_at)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
