import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageItem } from "../components/MessageItem";
import { ToastProvider } from "../components/ui";
import { Markdown } from "../markdown";
import type { Message } from "../types";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 7,
    channel_id: 1,
    webhook_id: 2,
    request_id: "req_abc",
    kind: "rich",
    status: "success",
    sender: { name: "Build bot", icon: "rocket", color: "#60a5fa", avatar_url: null },
    content: "",
    embeds: [],
    data: null,
    tags: [],
    attachments: [],
    created_at: "2026-10-16T10:00:00Z",
    read: false,
    pinned: false,
    archived: false,
    ...over,
  };
}

const noop = () => {};
const renderMsg = (m: Message) =>
  render(
    <ToastProvider>
      <MessageItem message={m} selected={false} compactHeader={false} onSelect={noop} onTogglePin={noop} onToggleRead={noop} />
    </ToastProvider>,
  );

describe("Markdown", () => {
  it("renders the supported subset", () => {
    const { container } = render(<Markdown text={"**bold** *it* `code` [docs](https://example.com/d)\n- one\n- two"} />);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("it");
    expect(container.querySelector("code")?.textContent).toBe("code");
    const a = screen.getByRole("link", { name: "docs" });
    expect(a).toHaveAttribute("href", "https://example.com/d");
    expect(a).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("never turns content into markup or unsafe links", () => {
    const { container } = render(
      <Markdown text={'<img src=x onerror="alert(1)"><script>alert(2)</script> [click](javascript:alert(3)) [d](data:text/html,hi)'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("<script>alert(2)</script>");
  });

  it("renders fenced code blocks verbatim", () => {
    const { container } = render(<Markdown text={"before\n```js\nconst a = '<b>';\n```"} />);
    expect(container.querySelector("pre")?.textContent).toBe("const a = '<b>';");
  });
});

describe("MessageItem", () => {
  it("renders a rich message with fields, status and sender", () => {
    renderMsg(
      msg({
        embeds: [{ title: "Deployed", url: "https://example.com/r", color: "#22c55e", description: "Rolled **out**", fields: [{ name: "Env", value: "prod", inline: true }], footer: "CI #1" }],
        tags: ["deploy"],
      }),
    );
    expect(screen.getByText("Build bot")).toBeInTheDocument();
    expect(screen.getByText("success")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Deployed/ })).toHaveAttribute("href", "https://example.com/r");
    expect(screen.getByText("Env")).toBeInTheDocument();
    expect(screen.getByText("prod")).toBeInTheDocument();
    expect(screen.getByText("deploy")).toBeInTheDocument();
  });

  it("drops unsafe embed URLs and colours", () => {
    const { container } = renderMsg(
      msg({ embeds: [{ title: "x", url: "javascript:alert(1)", color: "red;background:url(x)", image_url: "javascript:x", thumbnail_url: "data:image/png;base64,AA" }] }),
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect((container.querySelector(".embed") as HTMLElement).style.getPropertyValue("--embed")).not.toContain("url(");
  });

  it("shows image previews and file download buttons", () => {
    renderMsg(
      msg({
        kind: "file",
        attachments: [
          { id: "a".repeat(32), filename: "shot.png", content_type: "image/png", size: 2048, is_image: true, width: 10, height: 5, url: "/api/app/attachments/a", download_url: "/api/app/attachments/a?download=1" },
          { id: "b".repeat(32), filename: "report.pdf", content_type: "application/pdf", size: 1536000, is_image: false, width: null, height: null, url: "/api/app/attachments/b", download_url: "/api/app/attachments/b?download=1" },
        ],
      }),
    );
    expect(screen.getByAltText("shot.png")).toHaveAttribute("src", "/api/app/attachments/a");
    const dl = screen.getByRole("link", { name: /Download/ });
    expect(dl).toHaveAttribute("href", "/api/app/attachments/b?download=1");
    expect(screen.getByText(/1.5 MB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview shot.png" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows JSON payloads as an expandable tree", () => {
    renderMsg(msg({ kind: "json", data: { build: { id: 42, ok: true }, tags: ["a", "b"] } }));
    expect(screen.getByText("Payload data")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.getByText(/"ok": true/)).toBeInTheDocument();
  });

  it("wires the pin and read actions", () => {
    const onPin = vi.fn();
    const onRead = vi.fn();
    render(
      <ToastProvider>
        <MessageItem message={msg({ content: "hi" })} selected={false} compactHeader={false} onSelect={noop} onTogglePin={onPin} onToggleRead={onRead} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledTimes(1);
  });
});
