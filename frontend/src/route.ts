export type Route =
  | { view: "feed"; channelId: number | null; webhookId?: number | null }
  | { view: "webhooks"; webhookId: number | null }
  | { view: "docs" }
  | { view: "audit" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const num = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : null);
  switch (parts[0]) {
    case "channel":
      return { view: "feed", channelId: num(parts[1]) };
    case "source":
      return { view: "feed", channelId: null, webhookId: num(parts[1]) };
    case "webhooks":
      return { view: "webhooks", webhookId: num(parts[1]) };
    case "docs":
      return { view: "docs" };
    case "audit":
      return { view: "audit" };
    default:
      return { view: "feed", channelId: null };
  }
}

export function routeHash(r: Route): string {
  switch (r.view) {
    case "feed":
      if (r.webhookId) return `#/source/${r.webhookId}`;
      return r.channelId === null ? "#/" : `#/channel/${r.channelId}`;
    case "webhooks":
      return r.webhookId ? `#/webhooks/${r.webhookId}` : "#/webhooks";
    case "docs":
      return "#/docs";
    case "audit":
      return "#/audit";
  }
}
