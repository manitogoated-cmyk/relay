export type Status = "info" | "success" | "warning" | "error";

export interface User {
  id: number;
  username: string;
  display_name: string;
}

export interface AuthState {
  setup_required: boolean;
  setup_needs_token: boolean;
  user: User | null;
}

export interface Channel {
  id: number;
  name: string;
  slug: string;
  description: string;
  icon: string;
  color: string;
  position: number;
  unread: number;
  total: number;
  created_at: string;
}

export interface WebhookStats {
  messages?: number;
  deliveries_24h?: number;
  errors_24h?: number;
  avg_ms_24h?: number | null;
  success_rate_24h?: number | null;
  hourly?: number[];
}

export interface Webhook {
  id: number;
  public_id: string;
  url: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  channel_id: number;
  enabled: boolean;
  has_secret: boolean;
  secret_hint: string;
  secret_rotated_at: string | null;
  created_at: string;
  last_used_at: string | null;
  stats: WebhookStats;
}

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: string;
  timestamp?: string;
  fields?: EmbedField[];
  image_url?: string;
  thumbnail_url?: string;
  footer?: string;
  author?: { name?: string; url?: string; icon_url?: string };
}

export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  is_image: boolean;
  width: number | null;
  height: number | null;
  url: string;
  download_url: string;
}

export interface Message {
  id: number;
  channel_id: number;
  webhook_id: number | null;
  request_id: string;
  kind: "text" | "rich" | "json" | "file";
  status: Status | null;
  sender: { name: string; icon: string; color: string; avatar_url: string | null };
  content: string;
  embeds: Embed[];
  data: unknown;
  tags: string[];
  attachments: Attachment[];
  created_at: string;
  read: boolean;
  pinned: boolean;
  archived: boolean;
  delivery?: {
    received_at: string;
    duration_ms: number;
    body_bytes: number;
    content_type: string;
    source_ip: string;
    user_agent: string;
  } | null;
}

export interface Delivery {
  id: number;
  request_id: string;
  webhook_id: number;
  message_id: number | null;
  received_at: string;
  status_code: number;
  ok: boolean;
  error_code: string | null;
  error_detail: string | null;
  duration_ms: number;
  body_bytes: number;
  content_type: string;
  source_ip: string;
  user_agent: string;
  attachment_count: number;
  duplicate: boolean;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  details: Record<string, unknown>;
  source_ip: string;
  created_at: string;
}

export interface AppConfig {
  version: string;
  base_url: string;
  base_url_configured: boolean;
  https: boolean;
  environment: string;
  storage: string;
  limits: {
    max_json_bytes: number;
    max_upload_bytes: number;
    max_file_bytes: number;
    max_files: number;
    webhook_rate_per_minute: number;
    webhook_burst: number;
  };
  retention: { message_days: number; delivery_days: number; audit_days: number; idempotency_hours: number };
}

export interface Overview {
  messages_total: number;
  messages_24h: number;
  unread: number;
  pinned: number;
  webhooks: number;
  webhooks_enabled: number;
  deliveries_24h: number;
  errors_24h: number;
  live_connections: number;
}

export interface MessageFilters {
  q: string;
  status: Status[];
  kind: string[];
  hasAttachments: boolean;
  pinned: boolean;
  unread: boolean;
  archived: "exclude" | "include" | "only";
  since: string;
  until: string;
  webhookId: number | null;
}

export const emptyFilters: MessageFilters = {
  q: "",
  status: [],
  kind: [],
  hasAttachments: false,
  pinned: false,
  unread: false,
  archived: "exclude",
  since: "",
  until: "",
  webhookId: null,
};
