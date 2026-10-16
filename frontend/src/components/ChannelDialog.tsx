import { useState } from "react";
import { api, ApiError } from "../api";
import { Icon, PALETTE } from "../icons";
import type { Channel } from "../types";
import { Confirm, Field, Modal, Spinner } from "./ui";
import { ColorPicker, IconPicker } from "./WebhookDialog";

export function ChannelDialog({ existing, channels, onClose, onSaved, onDeleted }: {
  existing?: Channel;
  channels: Channel[];
  onClose: () => void;
  onSaved: (c: Channel) => void;
  onDeleted?: (id: number) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [icon, setIcon] = useState(existing?.icon ?? "hash");
  const [color, setColor] = useState(existing?.color ?? PALETTE[1]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const others = channels.filter((c) => c.id !== existing?.id);
  const [moveTo, setMoveTo] = useState<number | "">(others[0]?.id ?? "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim(), icon, color };
      const res = existing ? await api.updateChannel(existing.id, body) : await api.createChannel(body);
      onSaved(res.channel);
    } catch (err) {
      setError(err instanceof ApiError ? err.details?.[0]?.message ?? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={existing ? "Edit channel" : "New channel"}
      onClose={onClose}
      footer={
        <>
          {existing && others.length > 0 && (
            <button type="button" className="btn btn-ghost danger push-left" onClick={() => setDeleting(true)}>
              <Icon name="trash" size={15} /> Delete
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form="channel-form" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy && <Spinner />} {existing ? "Save" : "Create channel"}
          </button>
        </>
      }
    >
      <form id="channel-form" className="form" onSubmit={submit}>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Billing alerts" autoFocus required />
        </Field>
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="What lands here" />
        </Field>
        <Field group label="Icon">
          <IconPicker value={icon} color={color} onChange={setIcon} />
        </Field>
        <Field group label="Colour">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
      {deleting && existing && (
        <Confirm
          title={`Delete ${existing.name}?`}
          danger
          confirmLabel="Delete channel"
          onClose={() => setDeleting(false)}
          body={<p>Its webhooks and messages move to the channel you pick, so nothing is lost.</p>}
          onConfirm={async () => {
            try {
              await api.deleteChannel(existing.id, moveTo === "" ? undefined : moveTo);
              onDeleted?.(existing.id);
            } catch (e) {
              setError(e instanceof ApiError ? e.message : "Couldn't delete.");
            }
          }}
        >
          <Field label="Move everything to">
            <select value={moveTo} onChange={(e) => setMoveTo(Number(e.target.value))}>
              {others.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        </Confirm>
      )}
    </Modal>
  );
}
