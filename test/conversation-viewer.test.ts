import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";

// ── Mock wrapTextWithAnsi ──────────────────────────────────────────────
// We need to control what wrapTextWithAnsi returns to simulate the
// upstream bug (returning lines wider than requested width).
// vi.mock is hoisted and intercepts before conversation-viewer.ts binds
// its import.

let wrapOverride: ((text: string, width: number) => string[]) | null = null;

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    ...original,
    wrapTextWithAnsi: (...args: [string, number]) => {
      if (wrapOverride) return wrapOverride(...args);
      return original.wrapTextWithAnsi(...args);
    },
  };
});

// Must import AFTER vi.mock declaration (vitest hoists vi.mock but the
// dynamic import of the test subject must happen after)
const { Text, visibleWidth } = await import("@earendil-works/pi-tui");
const { ConversationViewer } = await import("../src/ui/conversation-viewer.js");

// ── Helpers ────────────────────────────────────────────────────────────

function mockTui(rows = 40, columns = 80) {
  return {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  } as any;
}

function mockSession(messages: any[] = []) {
  return {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

function mockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    ...overrides,
  } as AgentRecord;
}

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => `\x1b[38;5;240m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as any;
}

function assertAllLinesFit(lines: string[], width: number) {
  for (let i = 0; i < lines.length; i++) {
    const vw = visibleWidth(lines[i]);
    expect(vw, `line ${i} exceeds width (${vw} > ${width}): ${JSON.stringify(lines[i])}`).toBeLessThanOrEqual(width);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeAll(() => initTheme("dark"));
beforeEach(() => {
  wrapOverride = null;
});

describe("ConversationViewer cost display", () => {
  /** The header line, with a cost of `cost` on the record and showCost `on`. */
  function header(on: boolean, cost: number): string {
    const record = mockRecord({
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
    } as Partial<AgentRecord>);
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), record, undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(), undefined, undefined, undefined, on,
    );
    return viewer.render(200).join("\n");
  }

  it("shows the cost beside the token count when enabled", () => {
    // The viewer opens on finished agents, whose live activity entry is gone —
    // so this reads the record, and would show nothing if it did not.
    const out = header(true, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const out = header(false, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).not.toContain("$");
  });

  it("shows no cost for a model with no pricing data", () => {
    expect(header(true, 0)).not.toContain("$");
  });
});

describe("ConversationViewer", () => {
  it("uses Pi's message presentation instead of role labels and raw Markdown", () => {
    const viewer = new ConversationViewer(
      mockTui(), mockSession([
        { role: "user", content: "**Important** question" },
        { role: "assistant", content: [{ type: "text", text: "# Answer" }] },
      ]), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    const lines = (viewer as any).buildContentLines(76).join("\n");
    expect(lines).not.toContain("[User]");
    expect(lines).not.toContain("[Assistant]");
    expect(lines).not.toContain("**Important**");
    expect(lines).not.toContain("# Answer");
    expect(lines).toContain("Important");
    expect(lines).toContain("Answer");
  });

  it("shows thinking blocks through Pi's assistant renderer", () => {
    const viewer = new ConversationViewer(
      mockTui(), mockSession([{ role: "assistant", content: [{ type: "thinking", thinking: "Checking the constraints" }] }]),
      mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    expect((viewer as any).buildContentLines(76).join("\n")).toContain("Checking the constraints");
  });

  it("renders the assistant's partial message during streaming", () => {
    type MessageEvent = { type: "message_update" | "message_end"; message: { role: "assistant"; content?: Array<{ type: "text"; text: string }> } };
    let onEvent: (event: MessageEvent) => void = () => {};
    const session = mockSession([{ role: "user", content: "Question" }]);
    session.subscribe = vi.fn((listener: (event: MessageEvent) => void) => {
      onEvent = listener;
      return vi.fn();
    });
    const viewer = new ConversationViewer(
      mockTui(), session, mockRecord(), undefined, ansiTheme(), vi.fn(),
    );
    onEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "**Working** now" }] } });
    const lines = (viewer as any).buildContentLines(76).join("\n");
    expect(lines).toContain("Working");
    expect(lines).not.toContain("**Working**");
    onEvent({ type: "message_end", message: { role: "assistant" } });
    expect((viewer as any).buildContentLines(76).join("\n")).not.toContain("Working");
  });

  it("shows a partial response before the first finalized message", () => {
    let onEvent: (event: { type: "message_update"; message: { role: "assistant"; content: Array<{ type: "text"; text: string }> } }) => void = () => {};
    const session = mockSession([]);
    session.subscribe = vi.fn((listener: typeof onEvent) => { onEvent = listener; return vi.fn(); });
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, ansiTheme(), vi.fn());
    onEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "First response" }] } });
    expect((viewer as any).buildContentLines(76).join("\n")).toContain("First response");
  });

  it("shows a tool call as its arguments stream in", () => {
    let onEvent: (event: { type: "message_update"; message: { role: "assistant"; content: Array<{ type: "toolCall"; id: string; name: string; arguments: { path: string } }> } }) => void = () => {};
    const session = mockSession([]);
    session.subscribe = vi.fn((listener: typeof onEvent) => { onEvent = listener; return vi.fn(); });
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, ansiTheme(), vi.fn());
    onEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/stream.ts" } }] } });
    expect((viewer as any).buildContentLines(76).join("\n")).toContain("src/stream.ts");
  });

  it("shows tool calls and results using Pi's tool presentation", () => {
    const viewer = new ConversationViewer(
      mockTui(), mockSession([
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/example.ts" } }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "hello from file" }], isError: false },
      ]), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );
    const lines = (viewer as any).buildContentLines(76).join("\n");
    expect(lines).toContain("src/example.ts");
    expect(lines).not.toContain("[Tool: read]");
    expect(lines).not.toContain("[Result]");
  });

  it("toggles custom tool details with Ctrl+O and requests a redraw", () => {
    const details = { insight: "Extra tool insight" };
    const renderResult = vi.fn((result: { details: typeof details }, options: { expanded: boolean }) =>
      new Text(options.expanded ? result.details.insight : "Compact result", 0, 0));
    const session = mockSession([
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "probe", content: [{ type: "text", text: "done" }], details, isError: false },
    ]);
    session.getToolDefinition = () => ({ renderResult });
    const tui = mockTui();
    const viewer = new ConversationViewer(tui, session, mockRecord(), undefined, ansiTheme(), vi.fn());
    expect(viewer.render(80).join("\n")).toContain("Compact result");
    expect(viewer.render(80).join("\n")).not.toContain(details.insight);

    viewer.handleInput("\x0f");
    expect(tui.requestRender).toHaveBeenCalled();
    expect(viewer.render(80).join("\n")).toContain(details.insight);
    expect(renderResult.mock.lastCall?.[0].details).toBe(details);

    viewer.handleInput("\x0f");
    expect(viewer.render(80).join("\n")).toContain("Compact result");
    expect(viewer.render(80).join("\n")).not.toContain(details.insight);
  });

  it("keeps native tool components across renders", () => {
    const renderCall = vi.fn(() => new Text("tool", 0, 0));
    const session = mockSession([
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "probe", content: [{ type: "text", text: "done" }], isError: false },
    ]);
    session.getToolDefinition = () => ({ renderCall });
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, ansiTheme(), vi.fn());
    (viewer as any).buildContentLines(76);
    const initialCalls = renderCall.mock.calls.length;
    (viewer as any).buildContentLines(76);
    expect(renderCall).toHaveBeenCalledTimes(initialCalls);
  });

  it("updates a cached tool when its result arrives", () => {
    const session = mockSession([
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }] },
    ]);
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, ansiTheme(), vi.fn());
    expect((viewer as any).buildContentLines(76).join("\n")).not.toContain("finished output");
    session.messages.push({
      role: "toolResult", toolCallId: "call-1", toolName: "probe",
      content: [{ type: "text", text: "finished output" }], isError: false,
    });
    expect((viewer as any).buildContentLines(76).join("\n")).toContain("finished output");
  });

  it("keeps newly arriving tool calls and late results expanded", () => {
    const session = mockSession();
    session.getToolDefinition = () => ({
      renderCall: (_args: unknown, _theme: unknown, context: { expanded: boolean }) =>
        new Text(context.expanded ? "Expanded call" : "Compact call", 0, 0),
      renderResult: (result: { details: { insight: string } }, options: { expanded: boolean }) =>
        new Text(options.expanded ? result.details.insight : "Compact result", 0, 0),
    });
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, ansiTheme(), vi.fn());
    viewer.render(80);
    viewer.handleInput("\x0f");

    for (const id of ["first", "second"]) {
      session.messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "probe", arguments: {} }] });
      expect(viewer.render(80).join("\n")).toContain("Expanded call");
      session.messages.push({
        role: "toolResult", toolCallId: id, toolName: "probe", isError: false,
        content: [{ type: "text", text: "done" }], details: { insight: `${id} insight` },
      });
      expect(viewer.render(80).join("\n")).toContain(`${id} insight`);
    }
    viewer.handleInput("\x0f");
    const collapsed = viewer.render(80).join("\n");
    expect(collapsed).toContain("Compact call");
    expect(collapsed).not.toContain("Expanded call");
    expect(collapsed).not.toContain("first insight");
    expect(collapsed).not.toContain("second insight");
  });

  it("leaves expansion keys with the steering composer", () => {
    const session = mockSession([
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "probe", content: [{ type: "text", text: "done" }], isError: false },
    ]);
    session.getToolDefinition = () => ({
      renderResult: (_result: unknown, options: { expanded: boolean }) =>
        new Text(options.expanded ? "Expanded result" : "Compact result", 0, 0),
    });
    const viewer = new ConversationViewer(
      mockTui(), session, mockRecord(), undefined, ansiTheme(), vi.fn(), undefined, undefined, vi.fn(),
    );
    viewer.render(80);
    viewer.handleInput("\r");
    viewer.handleInput("\x0f");
    viewer.handleInput("\x1b");
    expect(viewer.render(80).join("\n")).toContain("Compact result");
    viewer.handleInput("\x0f");
    expect(viewer.render(80).join("\n")).toContain("Expanded result");
  });

  it("clamps the reading position after collapse without enabling auto-follow", () => {
    const session = mockSession([
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "probe", content: [{ type: "text", text: "done" }], isError: false },
    ]);
    session.getToolDefinition = () => ({
      renderResult: (_result: unknown, options: { expanded: boolean }) => new Text(
        options.expanded ? Array.from({ length: 40 }, (_, i) => `Expanded line ${i}`).join("\n") : "Compact result", 0, 0,
      ),
    });
    const viewer = new ConversationViewer(mockTui(20), session, mockRecord(), undefined, ansiTheme(), vi.fn());
    viewer.render(80);
    viewer.handleInput("\x0f");
    expect(viewer.render(80).join("\n")).toContain("Expanded line 39");
    viewer.handleInput("\x1b[A"); // Stop following at the expanded bottom.
    viewer.handleInput("\x0f");
    expect(viewer.render(80).join("\n")).toContain("Compact result");
    viewer.handleInput("\x0f");
    const expandedAgain = viewer.render(80).join("\n");
    expect(expandedAgain).toContain("Expanded line 0");
    expect(expandedAgain).not.toContain("Expanded line 39");
  });

  it("fits expanded custom output within narrow and resized viewports", () => {
    const session = mockSession([
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "probe", content: [{ type: "text", text: "done" }], isError: false },
    ]);
    session.getToolDefinition = () => ({
      renderResult: (_result: unknown, options: { expanded: boolean }) =>
        new Text(options.expanded ? `\x1b[32m${"界".repeat(100)}\x1b[0m` : "Compact result", 0, 0),
    });
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, ansiTheme(), vi.fn());
    viewer.render(80);
    viewer.handleInput("\x0f");
    for (const width of [8, 40, 80, 120]) assertAllLinesFit(viewer.render(width), width);
  });

  describe("render width safety", () => {
    const widths = [40, 80, 120, 216];

    it("no line exceeds width with empty messages", () => {
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession([]), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with plain text messages", () => {
      const messages = [
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: [{ type: "text", text: "I am fine, thank you for asking." }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("keeps bordered rows exact-width at a double-width truncation boundary", () => {
      const width = 40;
      for (let prefixLength = 0; prefixLength < width; prefixLength++) {
        const viewer = new ConversationViewer(
          mockTui(30, width),
          mockSession([]),
          mockRecord({ description: `${"a".repeat(prefixLength)}界more` }),
          undefined,
          ansiTheme(),
          vi.fn(),
        );

        for (const line of viewer.render(width)) {
          expect(
            visibleWidth(line),
            `prefix ${prefixLength} produced an under-width bordered row: ${JSON.stringify(line)}`,
          ).toBe(width);
        }
      }
    });

    it("no line exceeds width when text is longer than viewport", () => {
      const longLine = "A".repeat(500);
      const messages = [
        { role: "user", content: longLine },
        { role: "assistant", content: [{ type: "text", text: longLine }] },
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: longLine }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with embedded ANSI escape codes in content", () => {
      const ansiText = `\x1b[1mBold heading\x1b[22m and \x1b[31mred text\x1b[0m ${"X".repeat(300)}`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: ansiText }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with long URLs", () => {
      const url = "https://example.com/" + "a/b/c/d/e/".repeat(30) + "?q=" + "x".repeat(100);
      const messages = [
        { role: "assistant", content: [{ type: "text", text: `Check this link: ${url}` }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with wide table-like content", () => {
      const header = "| " + Array.from({ length: 20 }, (_, i) => `Column${i}`).join(" | ") + " |";
      const dataRow = "| " + Array.from({ length: 20 }, () => "value123").join(" | ") + " |";
      const table = [header, dataRow, dataRow, dataRow].join("\n");
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: table }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with bashExecution messages", () => {
      const messages = [
        {
          role: "bashExecution", command: "cat " + "/very/long/path/".repeat(20) + "file.txt",
          output: "O".repeat(600),
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with running activity indicator", () => {
      const activity = {
        activeTools: new Map([["read", "file.ts"], ["grep", "pattern"]]),
        toolUses: 5, tokens: "10k", responseText: "R".repeat(400),
        session: { getSessionStats: () => ({ tokens: { total: 50000 } }) },
      };
      const messages = [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord({ status: "running" }), activity as any, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with tool calls", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "toolCall", toolUseId: "t1", name: "very_long_tool_name_" + "x".repeat(200), input: {} },
          ],
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width at narrow terminal", () => {
      const messages = [
        { role: "user", content: "Hello world, this is a normal sentence." },
        { role: "assistant", content: [{ type: "text", text: "Sure, here's the answer." }] },
      ];
      for (const w of [8, 10, 15, 20]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with mixed ANSI + unicode content", () => {
      const text = `\x1b[32m✓\x1b[0m Test passed — 日本語テスト ${"あ".repeat(50)} \x1b[33m⚠\x1b[0m`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });

  describe("safety net against upstream wrapTextWithAnsi bugs", () => {
    // These tests call buildContentLines() directly (via the private method)
    // because render() has its own truncation via row(). The safety net in
    // buildContentLines is what prevents the TUI crash — it must clamp
    // independently of render().

    /** Call the private buildContentLines method directly. */
    function callBuildContentLines(viewer: InstanceType<typeof ConversationViewer>, width: number): string[] {
      return (viewer as any).buildContentLines(width);
    }

    it("mock is intercepting wrapTextWithAnsi", async () => {
      const { wrapTextWithAnsi } = await import("@earendil-works/pi-tui");
      wrapOverride = () => ["MOCK_SENTINEL"];
      expect(wrapTextWithAnsi("anything", 10)).toEqual(["MOCK_SENTINEL"]);
      wrapOverride = null;
    });

    it("clamps overwidth lines from toolResult content", () => {
      const w = 80;
      wrapOverride = () => ["X".repeat(w + 50)];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from user message content", () => {
      const w = 80;
      wrapOverride = () => ["Y".repeat(w + 100)];

      const messages = [{ role: "user", content: "hello" }];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from assistant message content", () => {
      const w = 80;
      wrapOverride = () => ["Z".repeat(w + 100)];

      const messages = [
        { role: "assistant", content: [{ type: "text", text: "response" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from bashExecution output", () => {
      const w = 80;
      wrapOverride = () => ["B".repeat(w + 100)];

      const messages = [
        {
          role: "bashExecution", command: "ls", output: "out",
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines that also contain ANSI codes", () => {
      const w = 80;
      wrapOverride = () => [`\x1b[1m\x1b[31m${"W".repeat(w + 30)}\x1b[0m`];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });
  });

  describe("stop key", () => {
    const W = 80;

    it("two-press x stops a running agent (first arms, second aborts)", () => {
      const onStop = vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      // Idle footer offers the stop affordance.
      expect(viewer.render(W).join("\n")).toContain("x stop");

      // First press arms (no abort yet) and re-renders.
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
      expect(tui.requestRender).toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).toContain("x again to STOP");

      // Second press aborts.
      viewer.handleInput("x");
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("any other key disarms the confirm", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");                       // arm
      viewer.handleInput("j");                       // scroll → disarm
      expect(viewer.render(W).join("\n")).toContain("x stop");
      expect(viewer.render(W).join("\n")).not.toContain("x again to STOP");

      viewer.handleInput("x");                       // arms again, does NOT stop
      expect(onStop).not.toHaveBeenCalled();
    });

    it("does not offer or perform stop once the agent is no longer running", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      viewer.handleInput("x");
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
    });

    it("no stop affordance when no onStop handler is provided (read-only history)", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      expect(() => { viewer.handleInput("x"); viewer.handleInput("x"); }).not.toThrow();
    });
  });

  describe("steer composer", () => {
    const W = 80;

    function makeViewer(opts: { status?: AgentRecord["status"]; onSteer?: (m: string) => void } = {}) {
      const onSteer = opts.onSteer ?? vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: opts.status ?? "running" }),
        undefined, ansiTheme(), vi.fn(), undefined, undefined, onSteer,
      );
      return { viewer, tui, onSteer };
    }

    it("offers the steer affordance for a running agent and opens on Enter", () => {
      const { viewer } = makeViewer();
      expect(viewer.render(W).join("\n")).toContain("Enter steer");

      viewer.handleInput("\r"); // Enter
      // Composer is shown (its prompt + send/cancel hint), idle footer is gone.
      const out = viewer.render(W).join("\n");
      expect(out).toContain("Enter send · Esc cancel");
      expect(out).not.toContain("Enter steer");
    });

    it("typing then Enter sends the trimmed message and closes the composer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "  hello  ") viewer.handleInput(ch);
      viewer.handleInput("\r"); // send

      expect(onSteer).toHaveBeenCalledWith("hello");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("Esc cancels the composer without sending", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "draft") viewer.handleInput(ch);
      viewer.handleInput("\x1b"); // Esc

      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
    });

    it("an empty submit just returns (like Esc), without calling onSteer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      viewer.handleInput("\r"); // empty submit
      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("scroll keys are inert while composing (input owns them)", () => {
      const { viewer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      // 'j' would normally scroll, but here it types into the composer.
      viewer.handleInput("j");
      expect(viewer.render(W).join("\n")).toContain("Enter send · Esc cancel");
    });

    it("no steer affordance once the agent is no longer running", () => {
      const { viewer, onSteer } = makeViewer({ status: "completed" });
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      viewer.handleInput("\r");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
      expect(onSteer).not.toHaveBeenCalled();
    });

    it("no steer affordance when no onSteer handler is provided", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      expect(() => viewer.handleInput("\r")).not.toThrow();
    });

    it("composer rows never exceed width", () => {
      for (const w of [40, 80, 120]) {
        const tui = mockTui(30, w);
        const viewer = new ConversationViewer(
          tui, mockSession(), mockRecord({ status: "running" }),
          undefined, ansiTheme(), vi.fn(), undefined, undefined, vi.fn(),
        );
        viewer.handleInput("\r"); // open composer
        for (const ch of "x".repeat(200)) viewer.handleInput(ch);
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });
});
