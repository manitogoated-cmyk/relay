import { memo, useState, type CSSProperties } from "react";
import { formatBytes, fullTime, safeColor, safeUrl, timeOfDay } from "../format";
import { Icon } from "../icons";
import { Markdown } from "../markdown";
import type { Attachment, Embed, Message } from "../types";
import { JsonView } from "./JsonView";
import { Avatar, Modal, StatusPill } from "./ui";

function ExternalImage({ src, className, alt = "" }: { src?: string; className: string; alt?: string }) {
  const [broken, setBroken] = useState(false);
  const url = safeUrl(src);
  if (!url || broken) return null;
  return <img className={className} src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

export function EmbedCard({ embed }: { embed: Embed }) {
  const color = safeColor(embed.color, "var(--line-strong)");
  const titleUrl = safeUrl(embed.url);
  const authorUrl = safeUrl(embed.author?.url);
  const fields = embed.fields ?? [];
  return (
    <div className="embed" style={{ "--embed": color } as CSSProperties}>
      <div className="embed-body">
        {embed.author?.name && (
          <div className="embed-author">
            <ExternalImage src={embed.author.icon_url} className="embed-author-icon" />
            {authorUrl ? (
              <a href={authorUrl} target="_blank" rel="noopener noreferrer nofollow">{embed.author.name}</a>
            ) : (
              <span>{embed.author.name}</span>
            )}
          </div>
        )}
        {embed.title && (
          <div className="embed-title">
            {titleUrl ? (
              <a href={titleUrl} target="_blank" rel="noopener noreferrer nofollow">
                {embed.title} <Icon name="arrow" size={13} />
              </a>
            ) : (
              embed.title
            )}
          </div>
        )}
        {embed.description && <Markdown text={embed.description} className="md embed-desc" />}
        {fields.length > 0 && (
          <dl className="embed-fields">
            {fields.map((f, i) => (
              <div key={i} className={`embed-field ${f.inline ? "is-inline" : ""}`}>
                <dt>{f.name}</dt>
                <dd>
                  <Markdown text={f.value || "—"} />
                </dd>
              </div>
            ))}
          </dl>
        )}
        <ExternalImage src={embed.image_url} className="embed-image" />
        {(embed.footer || embed.timestamp) && (
          <div className="embed-footer">
            {embed.footer && <span>{embed.footer}</span>}
            {embed.footer && embed.timestamp && <span aria-hidden>·</span>}
            {embed.timestamp && <time dateTime={embed.timestamp}>{fullTime(embed.timestamp)}</time>}
          </div>
        )}
      </div>
      <ExternalImage src={embed.thumbnail_url} className="embed-thumb" />
    </div>
  );
}

function fileIcon(a: Attachment): string {
  if (a.content_type === "application/pdf") return "book";
  if (a.content_type.includes("zip") || a.content_type.includes("gzip")) return "box";
  if (a.content_type.includes("json")) return "braces";
  if (a.content_type.includes("spreadsheet") || a.content_type.includes("csv")) return "chart";
  return "file";
}

export function Attachments({ items }: { items: Attachment[] }) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  const images = items.filter((a) => a.is_image);
  const files = items.filter((a) => !a.is_image);
  return (
    <div className="atts">
      {images.length > 0 && (
        <div className={`att-images n${Math.min(images.length, 4)}`}>
          {images.map((a) => (
            <button key={a.id} type="button" className="att-image" onClick={() => setPreview(a)} aria-label={`Preview ${a.filename}`}>
              <img
                src={a.url}
                alt={a.filename}
                loading="lazy"
                width={a.width ?? undefined}
                height={a.height ?? undefined}
                style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined}
              />
            </button>
          ))}
        </div>
      )}
      {files.map((a) => (
        <div key={a.id} className="att-file">
          <span className="att-file-icon">
            <Icon name={fileIcon(a)} size={18} />
          </span>
          <span className="att-file-meta">
            <span className="att-file-name" title={a.filename}>{a.filename}</span>
            <span className="att-file-size">
              {formatBytes(a.size)} · {a.content_type.split("/").pop()?.split(".").pop()}
            </span>
          </span>
          <a className="btn btn-ghost btn-sm" href={a.download_url} download={a.filename}>
            <Icon name="download" size={15} />
            <span>Download</span>
          </a>
        </div>
      ))}
      {preview && (
        <Modal title={preview.filename} onClose={() => setPreview(null)} wide footer={
          <a className="btn btn-primary" href={preview.download_url} download={preview.filename}>
            <Icon name="download" size={15} /> Download · {formatBytes(preview.size)}
          </a>
        }>
          <div className="lightbox">
            <img src={preview.url} alt={preview.filename} />
          </div>
        </Modal>
      )}
    </div>
  );
}

export interface MessageItemProps {
  message: Message;
  selected: boolean;
  compactHeader: boolean;
  onSelect: (m: Message) => void;
  onTogglePin: (m: Message) => void;
  onToggleRead: (m: Message) => void;
  channelName?: string;
}

function MessageItemInner({ message: m, selected, compactHeader, onSelect, onTogglePin, onToggleRead, channelName }: MessageItemProps) {
  const isJsonOnly = m.kind === "json";
  return (
    <article
      className={`msg ${m.read ? "" : "is-unread"} ${selected ? "is-selected" : ""} ${m.status ? `st-${m.status}` : ""} ${compactHeader ? "is-grouped" : ""}`}
      data-testid={`message-${m.id}`}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("a, button, .json, .embed-fields")) return;
        onSelect(m);
      }}
    >
      <div className="msg-gutter">
        {compactHeader ? (
          <time className="msg-time-hover" dateTime={m.created_at}>{timeOfDay(m.created_at)}</time>
        ) : (
          <Avatar icon={m.sender.icon} color={m.sender.color} url={safeUrl(m.sender.avatar_url)} name={m.sender.name} />
        )}
      </div>
      <div className="msg-main">
        {!compactHeader && (
          <header className="msg-head">
            <span className="msg-sender" style={{ color: safeColor(m.sender.color) }}>{m.sender.name}</span>
            {m.webhook_id === null && <span className="badge badge-muted" title="The webhook that sent this was deleted">removed source</span>}
            {channelName && <span className="badge badge-muted"># {channelName}</span>}
            <time className="msg-time" dateTime={m.created_at} title={fullTime(m.created_at)}>{timeOfDay(m.created_at)}</time>
            <StatusPill status={m.status} />
            {m.pinned && <Icon name="pin" size={13} className="msg-pin" label="Pinned" />}
            {m.archived && <span className="badge badge-muted">archived</span>}
            {m.tags.map((t) => (
              <span key={t} className="tag">{t}</span>
            ))}
          </header>
        )}
        {m.content && <Markdown text={m.content} className="md msg-content" />}
        {m.embeds.map((e, i) => (
          <EmbedCard key={i} embed={e} />
        ))}
        {m.data !== null && m.data !== undefined && <JsonView value={m.data} defaultOpen={isJsonOnly ? 2 : 1} label="Payload data" />}
        {m.attachments.length > 0 && <Attachments items={m.attachments} />}
      </div>
      <div className="msg-actions" role="toolbar" aria-label="Message actions">
        <button type="button" className="btn btn-icon" title={m.pinned ? "Unpin" : "Pin"} aria-label={m.pinned ? "Unpin" : "Pin"} onClick={() => onTogglePin(m)}>
          <Icon name="pin" size={15} />
        </button>
        <button type="button" className="btn btn-icon" title={m.read ? "Mark unread" : "Mark read"} aria-label={m.read ? "Mark unread" : "Mark read"} onClick={() => onToggleRead(m)}>
          <Icon name={m.read ? "eye" : "check"} size={15} />
        </button>
        <button type="button" className="btn btn-icon" title="Details" aria-label="Details" onClick={() => onSelect(m)}>
          <Icon name="panel" size={15} />
        </button>
      </div>
    </article>
  );
}

export const MessageItem = memo(MessageItemInner);
