import type { CSSProperties } from "react";

// 24px stroke icons (drawn for Relay). Each entry is a list of SVG path `d` strings.
const P: Record<string, string[]> = {
  bot: ["M12 4v3", "M8 7h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z", "M9.5 12.5h.01", "M14.5 12.5h.01", "M10 16h4", "M2.5 12v3", "M21.5 12v3"],
  bell: ["M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z", "M10 20.5a2.2 2.2 0 0 0 4 0"],
  terminal: ["M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M7 10l3 2.5L7 15", "M12.5 15H17"],
  spark: ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z", "M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"],
  alert: ["M12 3.5l9.5 16.5h-19z", "M12 10v4.5", "M12 17.3h.01"],
  file: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 13h6", "M9 17h4"],
  server: ["M4 4h16v6H4z", "M4 14h16v6H4z", "M8 7h.01", "M8 17h.01"],
  rocket: ["M14 4c3-1 6-1 6-1s0 3-1 6l-6 6-4-4z", "M9 11l-4 1-2 3 4 1", "M13 15l-1 4-3 2-1-4", "M15.5 8.5h.01"],
  bug: ["M9 7a3 3 0 0 1 6 0", "M7 10a5 5 0 0 1 10 0v4a5 5 0 0 1-10 0z", "M12 10v9", "M3 13h4", "M17 13h4", "M4 7l3 2", "M20 7l-3 2", "M4 19l3-2", "M20 19l-3-2"],
  chart: ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"],
  database: ["M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z", "M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"],
  globe: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M3 12h18", "M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"],
  shield: ["M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z", "M9 12l2 2 4-4"],
  zap: ["M13 2L4 14h7l-1 8 9-12h-7z"],
  cpu: ["M7 7h10v10H7z", "M10 10h4v4h-4z", "M10 2v3", "M14 2v3", "M10 19v3", "M14 19v3", "M2 10h3", "M2 14h3", "M19 10h3", "M19 14h3"],
  cloud: ["M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5z"],
  code: ["M8 7l-5 5 5 5", "M16 7l5 5-5 5", "M14 4l-4 16"],
  mail: ["M3 6h18v12H3z", "M3 7l9 6 9-6"],
  hash: ["M5 9h15", "M4 15h15", "M10 3L8 21", "M16 3l-2 18"],
  box: ["M12 3l8.5 4.5v9L12 21l-8.5-4.5v-9z", "M3.5 7.5L12 12l8.5-4.5", "M12 12v9"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  git: ["M6 3v12", "M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M18 6a3 3 0 1 0 0 .01", "M18 9a9 9 0 0 1-9 9"],
  heart: ["M12 20s-7.5-4.6-9-9.2C2 7.4 4.3 4.5 7.3 4.5c2 0 3.6 1.2 4.7 2.8 1.1-1.6 2.7-2.8 4.7-2.8 3 0 5.3 2.9 4.3 6.3-1.5 4.6-9 9.2-9 9.2z"],
  star: ["M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"],
  plus: ["M12 5v14", "M5 12h14"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  x: ["M6 6l12 12", "M18 6L6 18"],
  search: ["M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z", "M20 20l-4.8-4.8"],
  filter: ["M3 5h18l-7 8.5V19l-4 2v-7.5z"],
  pin: ["M9 3h6l-1 6 4 4H6l4-4z", "M12 13v8"],
  archive: ["M3 4h18v4H3z", "M5 8v12h14V8", "M10 12h4"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
  refresh: ["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"],
  key: ["M14.5 3a6.5 6.5 0 1 1-4.6 11.1L4 20H3v-3l1-1h2v-2h2l1.9-1.9A6.5 6.5 0 0 1 14.5 3z", "M16.5 7.5h.01"],
  link: ["M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1", "M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  settings: ["M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  "chevron-down": ["M6 9l6 6 6-6"],
  "chevron-right": ["M9 6l6 6-6 6"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
  image: ["M4 5h16v14H4z", "M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18", "M15.5 9h.01"],
  info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 11v5.5", "M12 7.6h.01"],
  success: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M8 12.5l2.7 2.7L16 9.8"],
  warning: ["M12 3.5l9.5 16.5h-19z", "M12 10v4.5", "M12 17.3h.01"],
  error: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M9 9l6 6", "M15 9l-6 6"],
  book: ["M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z", "M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3"],
  list: ["M9 6h11", "M9 12h11", "M9 18h11", "M4.5 6h.01", "M4.5 12h.01", "M4.5 18h.01"],
  logout: ["M15 4h4v16h-4", "M10 8l-4 4 4 4", "M6 12h11"],
  send: ["M21 3L10 14", "M21 3l-7 18-4-7-7-4z"],
  power: ["M12 3v9", "M6.3 6.3a8 8 0 1 0 11.4 0"],
  inbox: ["M3 13l3-8h12l3 8v6H3z", "M3 13h5l1.5 2.5h5L16 13h5"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7v5l3 2"],
  panel: ["M4 4h16v16H4z", "M15 4v16"],
  sun: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M12 2v2", "M12 20v2", "M4.9 4.9l1.4 1.4", "M17.7 17.7l1.4 1.4", "M2 12h2", "M20 12h2", "M4.9 19.1l1.4-1.4", "M17.7 6.3l1.4-1.4"],
  moon: ["M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"],
  braces: ["M8 4c-2 0-3 1-3 3v2c0 1.5-.7 2.5-2 3 1.3.5 2 1.5 2 3v2c0 2 1 3 3 3", "M16 4c2 0 3 1 3 3v2c0 1.5.7 2.5 2 3-1.3.5-2 1.5-2 3v2c0 2-1 3-3 3"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  arrow: ["M5 12h14", "M13 6l6 6-6 6"],
};

export const WEBHOOK_ICONS = [
  "bot", "spark", "rocket", "terminal", "server", "bell", "alert", "bug", "chart", "database",
  "globe", "shield", "zap", "cpu", "cloud", "code", "mail", "file", "box", "activity", "git", "heart", "star", "hash",
];

export const PALETTE = ["#5eead4", "#60a5fa", "#a78bfa", "#f0abfc", "#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#94a3b8"];

export function Icon({ name, size = 18, className, style, strokeWidth = 1.8, label }: {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
  label?: string;
}) {
  const paths = P[name] ?? P.hash;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--brand-tile)" />
      <circle cx="11" cy="21" r="3" fill="var(--accent)" />
      <path d="M11 13a8 8 0 0 1 8 8" stroke="var(--accent)" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <path d="M11 6.5A14.5 14.5 0 0 1 25.5 21" stroke="var(--accent)" strokeOpacity=".55" strokeWidth="2.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}
