import { useState } from "react";
import { formatBytes } from "../format";
import { Icon } from "../icons";
import type { AppConfig, Webhook } from "../types";
import { CopyButton } from "./ui";

const SECRET = "YOUR_WEBHOOK_SECRET";

function examples(url: string): Record<string, { label: string; code: string }> {
  return {
    curl: {
      label: "curl · JSON",
      code: `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${SECRET}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Agent Update",
    "message": "The task has completed successfully.",
    "status": "success"
  }'`,
    },
    rich: {
      label: "curl · rich",
      code: `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${SECRET}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: deploy-2026-10-16-001" \\
  -d '{
    "username": "Deploy bot",
    "title": "Deployed api v2.4.1",
    "url": "https://example.com/releases/2.4.1",
    "description": "Rolled out to **3 regions** in 4m 12s.",
    "status": "success",
    "color": "#34d399",
    "fields": [
      { "name": "Environment", "value": "production", "inline": true },
      { "name": "Commit", "value": "\`a1b2c3d\`", "inline": true }
    ],
    "thumbnail_url": "https://example.com/logo.png",
    "footer": "CI pipeline #812",
    "timestamp": "2026-10-16T09:30:00Z",
    "tags": ["deploy", "api"],
    "data": { "duration_s": 252, "regions": ["us", "eu", "ap"] }
  }'`,
    },
    files: {
      label: "curl · files",
      code: `curl -X POST "${url}" \\
  -H "Authorization: Bearer ${SECRET}" \\
  -F 'payload_json={"title":"Nightly report","status":"info"}' \\
  -F "files=@report.pdf" \\
  -F "files=@screenshot.png"`,
    },
    python: {
      label: "Python",
      code: `import requests

URL = "${url}"
SECRET = "${SECRET}"  # load from an environment variable in real code

resp = requests.post(
    URL,
    headers={"Authorization": f"Bearer {SECRET}"},
    json={"title": "Agent Update", "message": "Finished step 3/5", "status": "info"},
    timeout=10,
)
resp.raise_for_status()
print(resp.json()["message"]["id"])

# With a file
with open("chart.png", "rb") as fh:
    requests.post(URL, headers={"Authorization": f"Bearer {SECRET}"},
                  data={"message": "Today's chart"}, files={"files": fh}, timeout=30)`,
    },
    node: {
      label: "Node.js",
      code: `const res = await fetch("${url}", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.RELAY_SECRET}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ title: "Job failed", message: "Timeout after 30s", status: "error" }),
});
if (!res.ok) throw new Error((await res.json()).error.message);`,
    },
    powershell: {
      label: "PowerShell",
      code: `$headers = @{ Authorization = "Bearer ${SECRET}" }
$body = @{ title = "Backup"; message = "Backup finished"; status = "success" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "${url}" -Headers $headers -ContentType "application/json" -Body $body`,
    },
  };
}

const FIELDS: [string, string, string][] = [
  ["message", "string ≤ 4000", "Main text. Supports **bold**, *italic*, `code`, ``` blocks ```, [links](https://…), lists and > quotes. Aliases: content, text."],
  ["title", "string ≤ 256", "Turns the message into a rich card."],
  ["description", "string ≤ 4096", "Card body, same formatting as message."],
  ["status", "info · success · warning · error", "Colours the message and makes it filterable. Aliases: ok, warn, fail, critical…"],
  ["url", "https URL", "Makes the card title a link."],
  ["color", "#rrggbb or integer", "Card accent. Defaults to the status colour."],
  ["fields", "[{name, value, inline}] ≤ 25", "Key/value grid. Inline fields sit side by side."],
  ["image_url · thumbnail_url", "https URL", "Large image or corner thumbnail (loaded from the URL)."],
  ["footer · timestamp", "string · ISO 8601 or Unix", "Small print under the card."],
  ["username · avatar_url", "string ≤ 80 · https URL", "Override the sender shown for this message."],
  ["data", "any JSON ≤ 64 KB", "Shown as an expandable JSON tree. Alias: json."],
  ["tags", "[string] ≤ 10", "Small labels, searchable."],
  ["embeds", "[card] ≤ 10", "Several cards (Discord-style embeds are accepted as-is)."],
];

const CODES: [number, string, string][] = [
  [201, "created", "Stored and pushed live. Body has message.id and request_id."],
  [200, "duplicate", "Same Idempotency-Key seen in the last window: the original message is returned, nothing new is stored."],
  [400, "invalid_json · empty_body · empty_message · too_many_files · invalid_form", "The body couldn't be used."],
  [401, "missing_credentials · invalid_credentials", "No secret, wrong secret, revoked secret or unknown URL (all look the same)."],
  [403, "webhook_disabled · https_required", "The webhook is switched off, or plain HTTP was used in production."],
  [413, "payload_too_large · file_too_large", "Over the size limits below."],
  [415, "unsupported_media_type · file_type_blocked · file_type_mismatch · file_type_unsupported", "Wrong Content-Type, or a file that isn't allowed."],
  [422, "validation_failed", "A field is invalid; error.details lists each one."],
  [429, "rate_limited", "Slow down. Retry after the seconds in the Retry-After header."],
  [500, "internal_error", "Server problem. Quote the request_id."],
];

export function DocsPanel({ webhooks, config, onOpenSidebar }: { webhooks: Webhook[]; config: AppConfig | null; onOpenSidebar: () => void }) {
  const [hookId, setHookId] = useState<number | null>(webhooks[0]?.id ?? null);
  const [tab, setTab] = useState("curl");
  const hook = webhooks.find((w) => w.id === hookId) ?? null;
  const base = config?.base_url ?? window.location.origin;
  const url = hook?.url ?? `${base}/api/webhooks/YOUR_WEBHOOK_ID`;
  const ex = examples(url);
  const limits = config?.limits;

  return (
    <section className="center" aria-label="API documentation">
      <header className="feed-head">
        <button type="button" className="btn btn-icon only-mobile" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Icon name="menu" />
        </button>
        <div className="feed-title">
          <span className="feed-title-icon"><Icon name="book" size={18} /></span>
          <div className="feed-title-text">
            <h1>Docs</h1>
            <p>Send messages and files to your webhooks</p>
          </div>
        </div>
      </header>
      <div className="center-scroll docs">
        {config && !config.https && (
          <div className="callout callout-warn">
            <Icon name="shield" size={16} />
            <span>
              This server is reachable at <code>{config.base_url}</code> over plain HTTP. That's fine on this machine, but put it behind HTTPS
              (set <code>RELAY_PUBLIC_BASE_URL</code>) before sending secrets across a network.
            </span>
          </div>
        )}
        <section className="card">
          <h3 className="card-title"><Icon name="link" size={15} /> Endpoint</h3>
          {webhooks.length > 0 && (
            <label className="filter-inline">
              <span className="filter-label">Webhook</span>
              <select value={hookId ?? ""} onChange={(e) => setHookId(Number(e.target.value))}>
                {webhooks.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </label>
          )}
          <div className="copy-row">
            <code className="mono-box"><span className="verb">POST</span> {url}</code>
            <CopyButton text={url} label="Copy URL" />
          </div>
          <p className="muted">
            Authenticate with the webhook's secret in a header: <code>Authorization: Bearer &lt;secret&gt;</code> (or <code>X-Relay-Secret: &lt;secret&gt;</code>).
            Never put it in the URL. Send <code>application/json</code>, <code>multipart/form-data</code> (for files) or <code>text/plain</code>.
          </p>
        </section>

        <section className="card">
          <div className="tabs" role="tablist">
            {Object.entries(ex).map(([k, v]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "is-on" : ""} onClick={() => setTab(k)}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="code-block">
            <CopyButton text={ex[tab].code} compact label="Copy example" className="code-copy" />
            <pre>{ex[tab].code}</pre>
          </div>
          <p className="muted small">Replace {SECRET} with the secret shown when you created or rotated the webhook.</p>
        </section>

        <section className="card">
          <h3 className="card-title"><Icon name="braces" size={15} /> Payload fields</h3>
          <p className="muted">Include at least one of message, title, description, fields, data, embeds, or a file. Unknown fields are ignored.</p>
          <div className="table-wrap">
            <table className="table docs-table">
              <thead><tr><th>Field</th><th>Type</th><th>What it does</th></tr></thead>
              <tbody>
                {FIELDS.map(([f, t, d]) => (
                  <tr key={f}><td className="mono">{f}</td><td className="small">{t}</td><td>{d}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h3 className="card-title"><Icon name="file" size={15} /> Files</h3>
          <p>
            Send <code>multipart/form-data</code> with one or more file parts (any field name; <code>files</code> is conventional) plus either a
            <code> payload_json</code> part holding the JSON payload or plain form fields (<code>message</code>, <code>title</code>, <code>status</code>…).
          </p>
          <p className="muted">
            Accepted: PNG, JPEG, GIF, WebP (previewed), PDF, ZIP, GZIP, DOCX, XLSX, PPTX and UTF-8 text (.txt .log .md .csv .tsv .json .ndjson .yaml).
            The type is checked from the file's bytes, not its name. Executables, scripts, HTML and SVG are refused. Files are stored privately and only
            downloadable while signed in.
          </p>
        </section>

        <section className="card">
          <h3 className="card-title"><Icon name="shield" size={15} /> Limits &amp; behaviour</h3>
          <div className="kv">
            <span>JSON body</span><span>{limits ? formatBytes(limits.max_json_bytes) : "…"}</span>
            <span>Multipart body</span><span>{limits ? formatBytes(limits.max_upload_bytes) : "…"} total, {limits ? formatBytes(limits.max_file_bytes) : "…"} per file, {limits?.max_files ?? "…"} files</span>
            <span>Rate limit</span><span>{limits ? `${limits.webhook_rate_per_minute}/min per webhook, bursts of ${limits.webhook_burst}` : "…"}</span>
            <span>Duplicates</span><span>Send an <code>Idempotency-Key</code> header (≤128 chars). Retries with the same key within {config?.retention.idempotency_hours ?? 24} h return the first message.</span>
            <span>Retention</span><span>{config ? (config.retention.message_days ? `Messages kept ${config.retention.message_days} days (pinned forever); request logs ${config.retention.delivery_days} days.` : "Messages kept forever.") : "…"}</span>
            <span>Request IDs</span><span>Every response carries <code>X-Request-ID</code>; the same id is in the delivery log.</span>
            <span>From Discord</span><span>Payloads with <code>content</code>, <code>username</code>, <code>avatar_url</code> and <code>embeds</code> work unchanged. Swap the URL and add the header.</span>
          </div>
        </section>

        <section className="card">
          <h3 className="card-title"><Icon name="list" size={15} /> Response codes</h3>
          <div className="code-block">
            <pre>{`// success
{ "ok": true, "request_id": "req_…", "duplicate": false,
  "message": { "id": 42, "channel": { "id": 1, "name": "General Notifications" }, "created_at": "…", "attachments": [] } }

// error
{ "ok": false, "request_id": "req_…",
  "error": { "code": "validation_failed", "message": "…", "details": [{ "field": "url", "message": "must be an http:// or https:// URL" }] } }`}</pre>
          </div>
          <div className="table-wrap">
            <table className="table docs-table">
              <thead><tr><th>Status</th><th>error.code</th><th>Meaning</th></tr></thead>
              <tbody>
                {CODES.map(([s, c, d]) => (
                  <tr key={s}><td><span className={`code-badge ${s < 300 ? "ok" : s >= 500 ? "err" : "warn"}`}>{s}</span></td><td className="mono small">{c}</td><td>{d}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  );
}
