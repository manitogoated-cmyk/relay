import { useState } from "react";
import { api, ApiError } from "../api";
import { Icon, PALETTE, WEBHOOK_ICONS } from "../icons";
import type { Channel, Webhook } from "../types";
import { Avatar, CopyButton, Field, Modal, Spinner } from "./ui";

export function curlExample(url: string, secret: string): string {
  return `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Agent Update",
    "message": "The task has completed successfully.",
    "status": "success"
  }'`;
}

export function IconPicker({ value, color, onChange }: { value: string; color: string; onChange: (v: string) => void }) {
  return (
    <div className="icon-grid" role="radiogroup" aria-label="Icon">
      {WEBHOOK_ICONS.map((name) => (
        <button
          key={name}
          type="button"
          role="radio"
          aria-checked={value === name}
          aria-label={name}
          className={`icon-opt ${value === name ? "is-on" : ""}`}
          style={value === name ? { color, borderColor: color } : undefined}
          onClick={() => onChange(name)}
        >
          <Icon name={name} size={17} />
        </button>
      ))}
    </div>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Colour">
      {PALETTE.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} className={`swatch ${value === c ? "is-on" : ""}`} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

/** The one moment a secret is visible. */
export function SecretReveal({ webhook, secret, onDone, rotated = false }: { webhook: Webhook; secret: string; onDone: () => void; rotated?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <Modal
      title={rotated ? "New secret issued" : "Webhook ready"}
      onClose={onDone}
      wide
      footer={
        <button type="button" className="btn btn-primary" onClick={onDone}>
          I've saved the secret
        </button>
      }
    >
      <div className="reveal">
        <div className="reveal-hero">
          <Avatar icon={webhook.icon} color={webhook.color} size={44} />
          <div>
            <h3>{webhook.name}</h3>
            <p className="muted">{rotated ? "The previous secret stopped working just now." : "Paste these two values into the app that will send messages."}</p>
          </div>
        </div>
        <Field group label="Webhook URL">
          <div className="copy-row">
            <code className="mono-box">{webhook.url}</code>
            <CopyButton text={webhook.url} label="Copy URL" />
          </div>
        </Field>
        <Field group label="Secret" hint="Send it as a header: Authorization: Bearer <secret>">
          <div className="copy-row">
            <code className="mono-box secret-box">{shown ? secret : secret.slice(0, 6) + "•".repeat(28) + secret.slice(-4)}</code>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShown(!shown)}>
              <Icon name="eye" size={15} /> {shown ? "Hide" : "Show"}
            </button>
            <CopyButton text={secret} label="Copy secret" />
          </div>
        </Field>
        <div className="callout callout-warn">
          <Icon name="key" size={16} />
          <span>This is the only time the secret is shown. Relay keeps only a hash of it. If you lose it, rotate it to get a new one.</span>
        </div>
        <Field group label="Try it">
          <div className="code-block">
            <CopyButton text={curlExample(webhook.url, secret)} compact label="Copy command" className="code-copy" />
            <pre>{curlExample(webhook.url, shown ? secret : "YOUR_WEBHOOK_SECRET")}</pre>
          </div>
        </Field>
      </div>
    </Modal>
  );
}

export function WebhookDialog({ channels, existing, defaultChannelId, onClose, onSaved }: {
  channels: Channel[];
  existing?: Webhook;
  defaultChannelId?: number | null;
  onClose: () => void;
  onSaved: (w: Webhook, secret?: string) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [icon, setIcon] = useState(existing?.icon ?? "bot");
  const [color, setColor] = useState(existing?.color ?? PALETTE[0]);
  const [channelId, setChannelId] = useState<number>(existing?.channel_id ?? defaultChannelId ?? channels[0]?.id ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give the webhook a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim(), icon, color, channel_id: channelId };
      if (existing) {
        const res = await api.updateWebhook(existing.id, body);
        onSaved(res.webhook);
      } else {
        const res = await api.createWebhook(body);
        onSaved(res.webhook, res.secret);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.details?.[0]?.message ?? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={existing ? "Edit webhook" : "New webhook"}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form="webhook-form" className="btn btn-primary" disabled={busy || !channels.length}>
            {busy && <Spinner />}
            {existing ? "Save changes" : "Create webhook"}
          </button>
        </>
      }
    >
      <form id="webhook-form" className="form" onSubmit={submit}>
        <div className="preview-row">
          <Avatar icon={icon} color={color} size={48} />
          <div>
            <div className="preview-name" style={{ color }}>{name || "Webhook name"}</div>
            <div className="muted small">{description || "Messages from this source will look like this."}</div>
          </div>
        </div>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Nightly backup, Research agent" autoFocus required />
        </Field>
        <Field label="Description" hint="Optional: what sends to this webhook.">
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="Posts a summary when the job finishes" />
        </Field>
        <Field label="Channel" hint="Where its messages land. You can move it later.">
          <select value={channelId} onChange={(e) => setChannelId(Number(e.target.value))}>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field group label="Icon">
          <IconPicker value={icon} color={color} onChange={setIcon} />
        </Field>
        <Field group label="Colour">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
