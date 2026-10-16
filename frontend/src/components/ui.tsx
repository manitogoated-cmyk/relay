import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "../icons";
import { safeColor } from "../format";

/* ---------- toasts ---------- */

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "error" | "info";
}

const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={t.tone === "error" ? "error" : t.tone === "info" ? "info" : "success"} size={16} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/* ---------- copy ---------- */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back for http://LAN-IP setups.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label = "Copy", className = "", compact = false }: {
  text: string;
  label?: string;
  className?: string;
  compact?: boolean;
}) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <button
      type="button"
      className={`btn ${compact ? "btn-icon" : "btn-ghost btn-sm"} ${done ? "is-done" : ""} ${className}`}
      aria-label={compact ? label : undefined}
      title={label}
      onClick={async () => {
        const ok = await copyText(text);
        if (!ok) {
          toast("Couldn't copy. Select the text and copy it manually.", "error");
          return;
        }
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      <Icon name={done ? "check" : "copy"} size={15} />
      {!compact && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}

/* ---------- modal ---------- */

export function Modal({ title, onClose, children, footer, wide = false }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not(.modal-x)");
    first?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-icon modal-x" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Confirm({ title, body, confirmLabel, danger, onConfirm, onClose, children }: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">{body}</div>
      {children}
    </Modal>
  );
}

/* ---------- bits ---------- */

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden />;
}

export function Avatar({ icon, color, url, size = 36, name }: {
  icon: string;
  color: string;
  url?: string | null;
  size?: number;
  name?: string;
}) {
  const [broken, setBroken] = useState(false);
  const c = safeColor(color);
  if (url && !broken) {
    return (
      <img
        className="avatar avatar-img"
        src={url}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setBroken(true)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, color: c, background: `color-mix(in srgb, ${c} 16%, transparent)`, borderColor: `color-mix(in srgb, ${c} 32%, transparent)` }}
      title={name}
    >
      <Icon name={icon} size={Math.round(size * 0.5)} />
    </span>
  );
}

export function StatusPill({ status }: { status: string | null }) {
  if (!status) return null;
  return (
    <span className={`pill pill-${status}`}>
      <Icon name={status} size={12} strokeWidth={2.2} />
      {status}
    </span>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={26} />
      </div>
      <h3>{title}</h3>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Sparkline({ values, color = "var(--accent)", height = 28 }: { values: number[]; color?: string; height?: number }) {
  const max = Math.max(1, ...values);
  const w = 100;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`);
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" height={height} aria-hidden>
      <polyline points={`0,${height} ${pts.join(" ")} ${w},${height}`} fill={color} fillOpacity="0.12" stroke="none" />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Wraps one input in a <label>. With `group`, wraps several controls (copy rows, pickers) in a
 * labelled group instead, so buttons inside keep their own names and clicks. */
export function Field({ label, hint, children, error, group = false }: { label: string; hint?: ReactNode; children: ReactNode; error?: string; group?: boolean }) {
  const foot = error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null;
  if (group) {
    return (
      <div className={`field ${error ? "has-error" : ""}`} role="group" aria-label={label}>
        <span className="field-label">{label}</span>
        {children}
        {foot}
      </div>
    );
  }
  return (
    <label className={`field ${error ? "has-error" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {foot}
    </label>
  );
}
