import type {
  AppConfig,
  AuditEntry,
  AuthState,
  Channel,
  Delivery,
  Message,
  MessageFilters,
  Overview,
  User,
  Webhook,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[];

async function request<T>(method: string, path: string, body?: Json): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["X-Relay-Request"] = "1";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "network_error", "Can't reach the server. Check that Relay is running.");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: [] }; request_id?: string }) ?? {};
    throw new ApiError(
      res.status,
      err.error?.code ?? "http_error",
      err.error?.message ?? `Request failed (${res.status})`,
      err.request_id,
      err.error?.details,
    );
  }
  return data as T;
}

const get = <T>(p: string) => request<T>("GET", p);
const post = <T>(p: string, b?: Json) => request<T>("POST", p, b ?? {});
const patch = <T>(p: string, b: Json) => request<T>("PATCH", p, b);
const del = <T>(p: string) => request<T>("DELETE", p);

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

/** Local calendar day -> UTC instant, so date filters follow the viewer's day boundaries. */
export function dayToIso(day: string, endOfDay = false): string {
  if (!day) return "";
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d + (endOfDay ? 1 : 0));
  return dt.toISOString();
}

export function messageQuery(
  channelId: number | null,
  f: MessageFilters,
  cursor: { before_id?: number; after_id?: number; limit?: number } = {},
): string {
  return qs({
    channel_id: channelId,
    webhook_id: f.webhookId,
    q: f.q.trim(),
    status: f.status.join(","),
    kind: f.kind.join(","),
    has_attachments: f.hasAttachments || undefined,
    pinned: f.pinned || undefined,
    unread: f.unread || undefined,
    archived: f.archived === "exclude" ? undefined : f.archived,
    since: f.since ? dayToIso(f.since) : undefined,
    until: f.until ? dayToIso(f.until, true) : undefined,
    limit: cursor.limit ?? 50,
    before_id: cursor.before_id,
    after_id: cursor.after_id,
  });
}

export interface WebhookInput {
  name: string;
  description: string;
  icon: string;
  color: string;
  channel_id: number;
}

export interface ChannelInput {
  name: string;
  description: string;
  icon: string;
  color: string;
}

export const api = {
  authState: () => get<AuthState>("/api/auth/state"),
  setup: (b: { username: string; password: string; display_name?: string; setup_token?: string }) =>
    post<{ user: User }>("/api/auth/setup", b),
  login: (username: string, password: string) => post<{ user: User }>("/api/auth/login", { username, password }),
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  changePassword: (current_password: string, new_password: string) =>
    post<{ ok: true }>("/api/auth/password", { current_password, new_password }),

  config: () => get<AppConfig>("/api/app/config"),
  overview: () => get<Overview>("/api/app/overview"),

  channels: () => get<{ channels: Channel[] }>("/api/app/channels"),
  createChannel: (b: ChannelInput) => post<{ channel: Channel }>("/api/app/channels", { ...b }),
  updateChannel: (id: number, b: Partial<ChannelInput>) => patch<{ channel: Channel }>(`/api/app/channels/${id}`, b),
  deleteChannel: (id: number, moveTo?: number) => del<{ ok: true }>(`/api/app/channels/${id}${qs({ move_to: moveTo })}`),
  channelHistory: (id: number, action: "archive" | "delete" | "mark_read") =>
    post<{ affected: number }>(`/api/app/channels/${id}/history`, { action }),

  webhooks: () => get<{ webhooks: Webhook[]; base_url: string }>("/api/app/webhooks"),
  webhook: (id: number) => get<{ webhook: Webhook }>(`/api/app/webhooks/${id}`),
  createWebhook: (b: WebhookInput) => post<{ webhook: Webhook; secret: string }>("/api/app/webhooks", { ...b }),
  updateWebhook: (id: number, b: Partial<WebhookInput> & { enabled?: boolean }) =>
    patch<{ webhook: Webhook }>(`/api/app/webhooks/${id}`, b),
  rotateSecret: (id: number) => post<{ webhook: Webhook; secret: string }>(`/api/app/webhooks/${id}/rotate`),
  revokeSecret: (id: number) => post<{ webhook: Webhook }>(`/api/app/webhooks/${id}/revoke`),
  regenerateUrl: (id: number) => post<{ webhook: Webhook }>(`/api/app/webhooks/${id}/regenerate-url`),
  deleteWebhook: (id: number, deleteMessages: boolean) =>
    del<{ ok: true }>(`/api/app/webhooks/${id}${qs({ delete_messages_too: deleteMessages })}`),
  deliveries: (id: number, errorsOnly = false) =>
    get<{ deliveries: Delivery[] }>(`/api/app/webhooks/${id}/deliveries${qs({ errors_only: errorsOnly, limit: 100 })}`),
  sendTest: (id: number) => post<{ message_id: number }>(`/api/app/webhooks/${id}/test`),

  messages: (query: string) => get<{ messages: Message[]; has_more: boolean }>(`/api/app/messages${query}`),
  message: (id: number) => get<{ message: Message }>(`/api/app/messages/${id}`),
  updateMessage: (id: number, b: { read?: boolean; pinned?: boolean; archived?: boolean }) =>
    patch<{ message: Message }>(`/api/app/messages/${id}`, b),
  markRead: (b: { ids?: number[]; channel_id?: number; up_to_id?: number }) =>
    post<{ affected: number }>("/api/app/messages/read", b),
  deleteMessage: (id: number) => del<{ ok: true }>(`/api/app/messages/${id}`),

  audit: () => get<{ entries: AuditEntry[] }>("/api/app/audit?limit=200"),
};
