import { useState } from "react";
import { Icon } from "../icons";
import { CopyButton } from "./ui";

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className="j-null">null</span>;
  switch (typeof value) {
    case "string":
      return <span className="j-str">"{value}"</span>;
    case "number":
      return <span className="j-num">{String(value)}</span>;
    case "boolean":
      return <span className="j-bool">{String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

function Node({ name, value, depth, defaultOpen }: { name?: string; value: unknown; depth: number; defaultOpen: number }) {
  const isObj = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < defaultOpen);
  const key = name !== undefined ? <span className="j-key">{name}: </span> : null;
  if (!isObj) {
    return (
      <div className="j-row" style={{ paddingLeft: depth * 14 }}>
        {key}
        <Leaf value={value} />
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as object);
  const [o, c] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return (
    <div>
      <button type="button" className="j-row j-toggle" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        {key}
        <span className="j-punct">{o}</span>
        {!open && (
          <span className="j-summary">
            {entries.length} {Array.isArray(value) ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"}
          </span>
        )}
        {!open && <span className="j-punct">{c}</span>}
      </button>
      {open && (
        <>
          {entries.slice(0, 500).map(([k, v]) => (
            <Node key={k} name={Array.isArray(value) ? undefined : k} value={v} depth={depth + 1} defaultOpen={defaultOpen} />
          ))}
          {entries.length > 500 && <div className="j-row j-summary" style={{ paddingLeft: (depth + 1) * 14 }}>… {entries.length - 500} more</div>}
          <div className="j-row" style={{ paddingLeft: depth * 14 }}>
            <span className="j-punct">{c}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function JsonView({ value, defaultOpen = 2, label = "JSON" }: { value: unknown; defaultOpen?: number; label?: string }) {
  const [raw, setRaw] = useState(false);
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="json">
      <div className="json-bar">
        <span className="json-label">
          <Icon name="braces" size={14} /> {label}
        </span>
        <span className="json-actions">
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setRaw(!raw)}>
            {raw ? "Tree" : "Raw"}
          </button>
          <CopyButton text={text} compact label="Copy JSON" />
        </span>
      </div>
      {raw ? <pre className="json-raw">{text}</pre> : <div className="json-tree"><Node value={value} depth={0} defaultOpen={defaultOpen} /></div>}
    </div>
  );
}
