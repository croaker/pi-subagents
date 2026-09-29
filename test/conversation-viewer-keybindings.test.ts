import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import type { ViewerKeybindings } from "../src/ui/viewer-keys.js";
import { createViewerKeys } from "../src/ui/viewer-keys.js";

const KEYBINDINGS = {
  ...TUI_KEYBINDINGS,
  "app.tools.expand": { defaultKeys: "ctrl+o" },
} as const;

const CTRL_O = "\x0f";
const CTRL_P = "\x10";
const CTRL_N = "\x0e";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

function createEmacsKeybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": ["up", "ctrl+p"],
    "tui.select.down": ["down", "ctrl+n"],
  });
}

function createViewer(keybindings?: ViewerKeybindings) {
  const tui = {
    terminal: { rows: 20, columns: 80 },
    requestRender: vi.fn(),
  } as any;
  const messages = Array.from({ length: 60 }, (_, i) => ({
    role: "user",
    content: `message ${i}`,
  }));
  const session = {
    messages,
    subscribe: vi.fn(() => vi.fn()),
  } as any;
  const record = {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "completed",
    toolUses: 0,
    startedAt: Date.now(),
  } as AgentRecord;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  const viewer = new ConversationViewer(tui, session, record, undefined, theme, vi.fn(), undefined, keybindings);
  viewer.render(80); // sets lastInnerW and scrolls to bottom (autoScroll)
  return viewer;
}

function scrollOffset(viewer: ConversationViewer): number {
  return (viewer as any).scrollOffset;
}

describe("viewer-keys", () => {
  it("uses Ctrl+O for expansion by default, with or without a manager", () => {
    for (const keys of [createViewerKeys(), createViewerKeys(new KeybindingsManager(KEYBINDINGS))]) {
      expect(keys.expandTools(CTRL_O)).toBe(true);
      expect(keys.expandTools(CTRL_P)).toBe(false);
    }
  });

  it("honors rebound expansion keys instead of the default", () => {
    const keys = createViewerKeys(new KeybindingsManager(KEYBINDINGS, {
      "app.tools.expand": ["ctrl+p", "ctrl+n"],
    }));
    expect(keys.expandTools(CTRL_O)).toBe(false);
    expect(keys.expandTools(CTRL_P)).toBe(true);
    expect(keys.expandTools(CTRL_N)).toBe(true);
  });

  it("does not fall back to Ctrl+O when expansion is disabled", () => {
    const keys = createViewerKeys(new KeybindingsManager(KEYBINDINGS, { "app.tools.expand": [] }));
    expect(keys.expandTools(CTRL_O)).toBe(false);
  });

  it("honors user keybindings when a manager is provided", () => {
    const keys = createViewerKeys(createEmacsKeybindings());
    expect(keys.scrollUp(CTRL_P)).toBe(true);
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollDown(CTRL_N)).toBe(true);
    expect(keys.scrollDown(DOWN)).toBe(true);
  });

  it("falls back to hardcoded defaults without a manager", () => {
    const keys = createViewerKeys();
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollUp(CTRL_P)).toBe(false);
    expect(keys.scrollDown(DOWN)).toBe(true);
    expect(keys.scrollDown(CTRL_N)).toBe(false);
    expect(keys.pageUp(PAGE_UP)).toBe(true);
    expect(keys.pageDown(PAGE_DOWN)).toBe(true);
  });

  it("keeps the k/j and shift+arrow aliases with and without a manager", () => {
    for (const keys of [createViewerKeys(), createViewerKeys(createEmacsKeybindings())]) {
      expect(keys.scrollUp("k")).toBe(true);
      expect(keys.scrollDown("j")).toBe(true);
      expect(keys.pageUp(SHIFT_UP)).toBe(true);
      expect(keys.pageDown(SHIFT_DOWN)).toBe(true);
    }
  });

  it("manager with no user overrides behaves like the hardcoded defaults", () => {
    const keys = createViewerKeys(new KeybindingsManager(TUI_KEYBINDINGS, {}));
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollDown(DOWN)).toBe(true);
    expect(keys.pageUp(PAGE_UP)).toBe(true);
    expect(keys.pageDown(PAGE_DOWN)).toBe(true);
    expect(keys.scrollUp(CTRL_P)).toBe(false);
    expect(keys.scrollDown(CTRL_N)).toBe(false);
  });

  it("respects rebinding that removes a default key", () => {
    const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": "ctrl+p",
    });
    const keys = createViewerKeys(manager);
    expect(keys.scrollUp(CTRL_P)).toBe(true);
    expect(keys.scrollUp(UP)).toBe(false);
  });
});

describe("ConversationViewer custom keybindings", () => {
  beforeAll(() => initTheme("dark"));

  it("shows the expansion binding and current action in the footer", () => {
    const viewer = createViewer();
    expect(viewer.render(120).join("\n")).toContain("ctrl+o expand");
    viewer.handleInput(CTRL_O);
    expect(viewer.render(120).join("\n")).toContain("ctrl+o collapse");
  });

  it("shows rebound expansion keys and ignores Ctrl+O", () => {
    const viewer = createViewer(new KeybindingsManager(KEYBINDINGS, { "app.tools.expand": "ctrl+n" }));
    expect(viewer.render(120).join("\n")).toContain("ctrl+n expand");
    expect(viewer.render(120).join("\n")).not.toContain("ctrl+o");
    viewer.handleInput(CTRL_O);
    expect(viewer.render(120).join("\n")).toContain("ctrl+n expand");
    viewer.handleInput(CTRL_N);
    expect(viewer.render(120).join("\n")).toContain("ctrl+n collapse");
  });

  it("omits the expansion hint when the action is disabled", () => {
    const viewer = createViewer(new KeybindingsManager(KEYBINDINGS, { "app.tools.expand": [] }));
    viewer.handleInput(CTRL_O);
    expect(viewer.render(120).join("\n")).not.toContain("expand");
    expect(viewer.render(120).join("\n")).not.toContain("collapse");
  });

  it("gives expansion priority over a colliding scroll binding", () => {
    const viewer = createViewer(new KeybindingsManager(KEYBINDINGS, {
      "app.tools.expand": "ctrl+p",
      "tui.select.up": "ctrl+p",
    }));
    const bottom = scrollOffset(viewer);
    viewer.handleInput(CTRL_P);
    expect(viewer.render(120).join("\n")).toContain("ctrl+p collapse");
    expect(scrollOffset(viewer)).toBe(bottom);
  });

  it("scrolls with ctrl+p/ctrl+n when bound to tui.select.up/down", () => {
    const viewer = createViewer(createEmacsKeybindings());
    const bottom = scrollOffset(viewer);
    expect(bottom).toBeGreaterThan(0);

    viewer.handleInput(CTRL_P);
    expect(scrollOffset(viewer)).toBe(bottom - 1);
    viewer.handleInput(CTRL_N);
    expect(scrollOffset(viewer)).toBe(bottom);
  });

  it("keeps arrows and k/j working alongside custom bindings", () => {
    const viewer = createViewer(createEmacsKeybindings());
    const bottom = scrollOffset(viewer);

    viewer.handleInput(UP);
    viewer.handleInput("k");
    expect(scrollOffset(viewer)).toBe(bottom - 2);
    viewer.handleInput(DOWN);
    viewer.handleInput("j");
    expect(scrollOffset(viewer)).toBe(bottom);
  });

  it("treats ctrl+p/ctrl+n as unbound without a keybindings manager", () => {
    const viewer = createViewer();
    const bottom = scrollOffset(viewer);

    viewer.handleInput(CTRL_P);
    viewer.handleInput(CTRL_N);
    expect(scrollOffset(viewer)).toBe(bottom);
    viewer.handleInput(UP);
    expect(scrollOffset(viewer)).toBe(bottom - 1);
  });
});
