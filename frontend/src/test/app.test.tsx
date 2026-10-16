import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { ToastProvider } from "../components/ui";

const SECRET = "rls_test_secret_value_1234567890abcdef";
const channel = { id: 1, name: "General Notifications", slug: "general", description: "", icon: "bell", color: "#5eead4", position: 0, unread: 0, total: 0, created_at: "2026-10-16T10:00:00Z" };
const webhook = {
  id: 5, public_id: "abcDEF123456", url: "http://127.0.0.1:8100/api/webhooks/abcDEF123456", name: "Nightly backup", description: "",
  icon: "bot", color: "#5eead4", channel_id: 1, enabled: true, has_secret: true, secret_hint: "cdef", secret_rotated_at: null,
  created_at: "2026-10-16T10:00:00Z", last_used_at: null, stats: {},
};

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

let signedIn = false;
let created = false;
const calls: { method: string; url: string; body?: string }[] = [];

beforeEach(() => {
  signedIn = false;
  created = false;
  calls.length = 0;
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} readyState = 0; static CLOSED = 2; });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body as string | undefined });
    if (url === "/api/auth/state") return json({ setup_required: false, setup_needs_token: false, user: signedIn ? { id: 1, username: "owner", display_name: "Owner" } : null });
    if (url === "/api/auth/login") {
      const b = JSON.parse(init!.body as string);
      if (b.password !== "right password") return json({ ok: false, error: { code: "invalid_login", message: "Wrong username or password." } }, 401);
      signedIn = true;
      return json({ user: { id: 1, username: "owner", display_name: "Owner" } });
    }
    if (url === "/api/app/channels") return json({ channels: [channel] });
    if (url === "/api/app/webhooks" && method === "GET") return json({ webhooks: created ? [webhook] : [], base_url: "http://127.0.0.1:8100" });
    if (url === "/api/app/webhooks" && method === "POST") {
      created = true;
      return json({ webhook, secret: SECRET }, 201);
    }
    if (url.startsWith("/api/app/webhooks/5/deliveries")) return json({ deliveries: [] });
    if (url === "/api/app/config") return json({ base_url: "http://127.0.0.1:8100", https: false, limits: {}, retention: {} });
    if (url === "/api/app/overview") return json({ messages_total: 0, messages_24h: 0, unread: 0, pinned: 0, webhooks: 0, webhooks_enabled: 0, deliveries_24h: 0, errors_24h: 0, live_connections: 1 });
    if (url.startsWith("/api/app/messages")) return json({ messages: [], has_more: false });
    return json({ ok: false, error: { code: "not_found", message: url } }, 404);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("App", () => {
  it("signs in, creates a webhook and shows its secret exactly once", async () => {
    render(<ToastProvider><App /></ToastProvider>);
    const user = await screen.findByLabelText("Username");
    fireEvent.change(user, { target: { value: "owner" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong one" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong username or password.");

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "right password" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("heading", { name: "All messages" })).toBeInTheDocument();
    expect(screen.getByText("General Notifications")).toBeInTheDocument();

    fireEvent.click((await screen.findAllByRole("button", { name: /new webhook/i }))[0]);
    const dialog = await screen.findByRole("dialog", { name: "New webhook" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Nightly backup" } });
    fireEvent.click(screen.getByRole("button", { name: "Create webhook" }));

    const reveal = await screen.findByRole("dialog", { name: "Webhook ready" });
    expect(within(reveal).getByText(webhook.url)).toBeInTheDocument();
    expect(reveal.textContent).not.toContain(SECRET);
    fireEvent.click(within(reveal).getByRole("button", { name: /show/i }));
    expect(reveal.textContent).toContain(SECRET);

    const post = calls.find((c) => c.method === "POST" && c.url === "/api/app/webhooks")!;
    expect(JSON.parse(post.body!)).toMatchObject({ name: "Nightly backup", channel_id: 1 });

    fireEvent.click(within(reveal).getByRole("button", { name: "I've saved the secret" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(window.location.hash).toBe("#/webhooks/5"));
    expect(document.body.textContent).not.toContain(SECRET);
  });
});
