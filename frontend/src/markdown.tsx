import { Fragment, type ReactNode } from "react";
import { safeUrl } from "./format";

/**
 * A small Markdown subset rendered straight to React elements: **bold**, *italic*, ~~strike~~,
 * `code`, ``` blocks ```, [links](https://...), bare URLs, > quotes and - lists.
 * Nothing is ever parsed as HTML, so webhook content can't inject markup.
 */

const INLINE = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]))/g;

function link(href: string, children: ReactNode, key: string): ReactNode {
  const url = safeUrl(href);
  if (!url) return <Fragment key={key}>{children}</Fragment>;
  return (
    <a key={key} href={url} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

export function inline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const key = `${keyPrefix}-${n++}`;
    if (m[2] ?? m[3]) out.push(<strong key={key}>{inline(m[2] ?? m[3], key)}</strong>);
    else if (m[4] ?? m[5]) out.push(<em key={key}>{inline(m[4] ?? m[5], key)}</em>);
    else if (m[6]) out.push(<del key={key}>{inline(m[6], key)}</del>);
    else if (m[7]) out.push(<code key={key}>{m[7]}</code>);
    else if (m[8]) out.push(link(m[9], inline(m[8], key), key));
    else if (m[10]) out.push(link(m[10], m[10], key));
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const body = part.replace(/^[a-zA-Z0-9_+-]*\n/, "");
      blocks.push(
        <pre key={`pre-${i}`} className="md-pre">
          <code>{body.replace(/\n$/, "")}</code>
        </pre>,
      );
      return;
    }
    const lines = part.split("\n");
    let list: string[] = [];
    let quote: string[] = [];
    const flush = (k: string) => {
      if (list.length) {
        blocks.push(
          <ul key={`ul-${k}`} className="md-list">
            {list.map((l, j) => (
              <li key={j}>{inline(l, `${k}-li${j}`)}</li>
            ))}
          </ul>,
        );
        list = [];
      }
      if (quote.length) {
        blocks.push(
          <blockquote key={`q-${k}`} className="md-quote">
            {quote.map((l, j) => (
              <div key={j}>{inline(l, `${k}-q${j}`)}</div>
            ))}
          </blockquote>,
        );
        quote = [];
      }
    };
    lines.forEach((line, j) => {
      const k = `${i}-${j}`;
      const li = /^\s*[-*•]\s+(.*)$/.exec(line);
      const q = /^>\s?(.*)$/.exec(line);
      if (li) {
        if (quote.length) flush(k);
        list.push(li[1]);
      } else if (q) {
        if (list.length) flush(k);
        quote.push(q[1]);
      } else {
        flush(k);
        if (line.trim() === "" && (j === 0 || j === lines.length - 1)) return;
        blocks.push(
          <div key={`l-${k}`} className="md-line">
            {line ? inline(line, k) : " "}
          </div>,
        );
      }
    });
    flush(`end-${i}`);
  });
  return <div className={className ?? "md"}>{blocks}</div>;
}
