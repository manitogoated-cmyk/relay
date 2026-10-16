import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { formatBytes, fullTime } from "../format";
import { Icon } from "../icons";
import type { Channel, Message, Webhook } from "../types";
import { JsonView } from "./JsonView";
import { Avatar, Confirm, CopyButton, Spinner, StatusPill, useToast } from "./ui";

export function MessageDetails({ message, channels, webhooks, onClose, onChanged, onDeleted, onOpenWebhook }: {
  message: Message;
  channels: Channel[];
  webhooks: Webhook[];
  onClose: () => void;
  onChanged: (m: Message) => void;
  onDeleted: (id: number) => void;
  onOpenWebhook: (id: number) => void;
}) {
  const [full, setFull] = useState<Message | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toast = useToast();
  const m = full && full.id === message.id ? { ...full, ...message, delivery: full.delivery } : message;
  const channel = channels.find((c) => c.id === m.channel_id);
  const hook = webhooks.find((w) => w.id === m.webhook_id);

  useEffect(() => {
    let alive = true;
    setFull(null);
    api.message(message.id).then((r) => alive && setFull(r.message)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [message.id]);

  const update = async (change: { read?: boolean; pinned?: boolean; archived?: boolean }) => {
    try {
      onChanged((await api.updateMessage(m.id, change)).message);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Update failed", "error");
    }
  };

  const { delivery, ...rest } = m;
  return (
    <aside className="details" aria-label="Message details">
      <header className="details-head">
        <h2>Message</h2>
        <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close details">
          <Icon name="x" />
        </button>
      </header>
      <div className="details-scroll">
        <div className="details-sender">
          <Avatar icon={m.sender.icon} color={m.sender.color} size={40} />
          <div>
            <strong>{m.sender.name}</strong>
            <div className="muted small">{fullTime(m.created_at)}</div>
          </div>
          <StatusPill status={m.status} />
        </div>

        <div className="btn-row">
          <button type="button" className={`btn btn-ghost btn-sm ${m.pinned ? "is-active" : ""}`} onClick={() => update({ pinned: !m.pinned })}>
            <Icon name="pin" size={15} /> {m.pinned ? "Unpin" : "Pin"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => update({ read: !m.read })}>
            <Icon name={m.read ? "eye" : "check"} size={15} /> {m.read ? "Mark unread" : "Mark read"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => update({ archived: !m.archived })}>
            <Icon name="archive" size={15} /> {m.archived ? "Unarchive" : "Archive"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm danger" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" size={15} /> Delete
          </button>
        </div>

        <dl className="kv">
          <dt>Channel</dt>
          <dd>{channel?.name ?? "—"}</dd>
          <dt>Source</dt>
          <dd>
            {hook ? (
              <button type="button" className="link" onClick={() => onOpenWebhook(hook.id)}>{hook.name}</button>
            ) : (
              <span className="muted">deleted webhook</span>
            )}
          </dd>
          <dt>Type</dt>
          <dd>{m.kind}</dd>
          <dt>Request ID</dt>
          <dd className="kv-copy">
            <code className="mono">{m.request_id}</code>
            <CopyButton text={m.request_id} compact label="Copy request ID" />
          </dd>
          <dt>Message ID</dt>
          <dd><code className="mono">{m.id}</code></dd>
          {full === null ? (
            <>
              <dt>Delivery</dt>
              <dd><Spinner /></dd>
            </>
          ) : delivery ? (
            <>
              <dt>Received</dt>
              <dd>{fullTime(delivery.received_at)}</dd>
              <dt>Processing</dt>
              <dd>{delivery.duration_ms} ms · {formatBytes(delivery.body_bytes)} · {delivery.content_type || "—"}</dd>
              <dt>Client</dt>
              <dd className="break">{delivery.source_ip || "—"}{delivery.user_agent ? ` · ${delivery.user_agent}` : ""}</dd>
            </>
          ) : (
            <>
              <dt>Delivery</dt>
              <dd className="muted">Sent from the dashboard</dd>
            </>
          )}
        </dl>

        {m.attachments.length > 0 && (
          <div className="details-files">
            <h3>Files</h3>
            {m.attachments.map((a) => (
              <a key={a.id} className="details-file" href={a.download_url} download={a.filename}>
                <Icon name={a.is_image ? "image" : "file"} size={16} />
                <span className="truncate">{a.filename}</span>
                <span className="muted small">{formatBytes(a.size)}</span>
                <Icon name="download" size={15} />
              </a>
            ))}
          </div>
        )}

        <JsonView value={rest} defaultOpen={1} label="Stored message" />
      </div>
      {confirmDelete && (
        <Confirm
          title="Delete this message?"
          danger
          confirmLabel="Delete"
          body={<p>The message{m.attachments.length ? ` and its ${m.attachments.length} file${m.attachments.length > 1 ? "s" : ""}` : ""} will be removed permanently.</p>}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            try {
              await api.deleteMessage(m.id);
              onDeleted(m.id);
              toast("Message deleted");
            } catch (e) {
              toast(e instanceof ApiError ? e.message : "Delete failed", "error");
            }
          }}
        />
      )}
    </aside>
  );
}
