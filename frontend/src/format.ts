export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function timeOfDay(s: string): string {
  const d = parseIso(s);
  return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

export function fullTime(s: string | null | undefined): string {
  const d = parseIso(s);
  return d
    ? d.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
}

export function dayLabel(s: string, now = new Date()): string {
  const d = parseIso(s);
  if (!d) return "";
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export function sameDay(a: string, b: string): boolean {
  const x = parseIso(a);
  const y = parseIso(b);
  return !!x && !!y && x.toDateString() === y.toDateString();
}

export function relative(s: string | null | undefined, now = Date.now()): string {
  const d = parseIso(s);
  if (!d) return "never";
  const sec = Math.round((now - d.getTime()) / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days} d ago`;
  return d.toLocaleDateString();
}

/** Only http(s) URLs are ever placed in href/src. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u, window.location.origin);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Colours are validated server-side too; this keeps anything odd out of inline styles. */
export function safeColor(c: string | null | undefined, fallback = "var(--accent)"): string {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
}
