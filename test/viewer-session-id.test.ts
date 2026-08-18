import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { renderViewerDocument } from "../src/viewer/document.js";

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadViewerSandbox() {
  const rendered = renderViewerDocument();
  expect(rendered.found).toBe(true);
  if (!rendered.found) throw new Error("viewer document not found");

  const scriptMatch = rendered.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  expect(scriptMatch).not.toBeNull();
  if (!scriptMatch) throw new Error("viewer script not found");

  const elements = new Map<string, any>();
  const createMockElement = (id = "") => {
    const attributes = new Map<string, string>();
    const classes = new Set<string>();
    const listeners = new Map<string, Array<(event?: unknown) => void>>();
    return {
      id,
      innerHTML: "",
      textContent: "",
      value: "",
      checked: false,
      dataset: {},
      style: {},
      listeners,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
          const enabled = force ?? !classes.has(name);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
      },
      addEventListener: (type: string, handler: (event?: unknown) => void) => {
        const current = listeners.get(type) || [];
        current.push(handler);
        listeners.set(type, current);
      },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: unknown) => {
        attributes.set(name, String(value));
      },
      // Added in #313 — switchTab toggles aria-selected via removeAttribute
      // on the non-active tab buttons. The mock previously only had
      // get/setAttribute, so the new hash-routing path threw TypeError.
      removeAttribute: (name: string) => {
        attributes.delete(name);
      },
      querySelectorAll: () => [],
    };
  };
  const getElement = (id: string) => {
    if (!elements.has(id)) elements.set(id, createMockElement(id));
    return elements.get(id);
  };

  const tabs = [
    "dashboard",
    "graph",
    "memories",
    "timeline",
    "sessions",
    "lessons",
    "actions",
    "crystals",
    "audit",
    "activity",
    "profile",
    "replay",
  ];
  const tabButtons = tabs.map((tab) => ({ ...createMockElement(), dataset: { tab } }));
  const views = tabs.map((tab) => ({ ...createMockElement(`view-${tab}`), id: `view-${tab}` }));
  const checkboxes = [createMockElement(), createMockElement()].map((el) => ({ ...el, checked: false }));
  const querySelectorAll = (selector: string) => {
    if (selector === ".tab-bar button") return tabButtons;
    if (selector === ".view") return views;
    if (selector === 'input[type="checkbox"]') return checkboxes;
    return [];
  };

  const document = {
    documentElement: { dataset: {} },
    createElement: () => {
      let text = "";
      return {
        set textContent(value: unknown) {
          text = String(value ?? "");
        },
        get innerHTML() {
          return htmlEscape(text);
        },
      };
    },
    getElementById: getElement,
    querySelectorAll,
    addEventListener: () => {},
  };

  const sandbox: Record<string, any> = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    document,
    window: {
      location: {
        search: "",
        port: "3113",
        protocol: "http:",
        hostname: "localhost",
        host: "localhost:3113",
        origin: "http://localhost:3113",
      },
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
    },
    // Stubbed in #313 — the viewer now calls history.replaceState
    // inside updateTabRoute → switchTab to drive the hash-route surface.
    // The vm sandbox is otherwise zero-globals so the call would
    // throw ReferenceError. No-op is fine for the rendering tests.
    history: { replaceState: () => {}, pushState: () => {} },
    location: {
      hash: "",
      pathname: "/",
      search: "",
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: (() => {
      const values = new Map<string, string>();
      return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      };
    })(),
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    WebSocket: function WebSocket() {},
    navigator: { userAgent: "vitest" },
    Element: function Element() {},
    alert: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    URLSearchParams,
    Date,
    Math,
    Promise,
    JSON,
    Array,
    Object,
    String,
    Number,
    parseInt,
    encodeURIComponent,
  };

  const scriptWithoutAutoStart = scriptMatch[1].replace(
    /\n\s*loadTab\('dashboard'\);\n\s*connectWs\(\);\n\s*startDashboardAutoRefresh\(\);\s*$/,
    "\n",
  );

  vm.createContext(sandbox);
  vm.runInContext(scriptWithoutAutoStart, sandbox);

  return { sandbox, getElement };
}

describe("viewer session rendering", () => {
  it("attaches the saved viewer bearer to API calls", async () => {
    const { sandbox } = loadViewerSandbox();
    const requests: Array<{ url: string; opts: { headers?: Record<string, string> } }> = [];
    sandbox.sessionStorage.setItem("agentmemory-viewer-token", "viewer-secret");
    sandbox.fetch = async (url: string, opts: { headers?: Record<string, string> }) => {
      requests.push({ url, opts });
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await sandbox.apiGet("health");

    expect(requests).toHaveLength(1);
    expect(requests[0].opts.headers?.Authorization).toBe("Bearer viewer-secret");
  });

  it("shows where to find AGENTMEMORY_SECRET after a viewer auth failure", async () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });

    await sandbox.apiGet("health");

    const prompt = getElement("viewer-auth");
    expect(prompt.classList.contains("open")).toBe(true);
    expect(prompt.innerHTML).toContain("AGENTMEMORY_SECRET");
    expect(prompt.innerHTML).toContain("unlock viewer API access");
    expect(prompt.innerHTML).not.toContain("fly logs");
    expect(prompt.innerHTML).not.toContain("/data/.hmac");
  });

  it("does not throw when dashboard sessions are missing ids", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.dashboard = {
      loaded: true,
      health: { status: "healthy", health: {} },
      sessions: [{ status: "active", observationCount: 3, startedAt: "2026-05-13T12:00:00Z" }],
      memories: [],
      graphStats: null,
      recentAudit: [],
      lessons: [],
      crystals: [],
    };

    expect(() => sandbox.renderDashboard()).not.toThrow();
    expect(getElement("view-dashboard").innerHTML).toContain("Unknown session");
  });

  it("keeps the existing dashboard visible while auto-refresh loads", async () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.dashboard.loaded = true;
    const dashboard = getElement("view-dashboard");
    dashboard.innerHTML = "existing dashboard";
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise((resolve) => { release = resolve; });
    sandbox.fetch = () => pending;

    const refresh = sandbox.loadDashboard();
    expect(dashboard.innerHTML).toBe("existing dashboard");

    release!({ ok: true, json: async () => ({}) });
    await refresh;
    expect(dashboard.innerHTML).not.toContain("Loading dashboard...");
  });

  it("shows injection state, historical automatic context, and MCP delivery separately", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.dashboard = {
      loaded: true,
      health: { status: "healthy", health: {} },
      sessions: [
        { id: "active-1", status: "active", observationCount: 10, startedAt: "2026-05-13T12:00:00Z" },
        { id: "done-1", status: "completed", observationCount: 10, startedAt: "2026-05-13T11:00:00Z" },
        { id: "done-2", status: "completed", observationCount: 10, startedAt: "2026-05-13T10:00:00Z" },
      ],
      memories: [],
      graphStats: null,
      recentAudit: [],
      lessons: [],
      crystals: [],
      contextReduction: {
        measuredEvents: 9,
        estimator: "chars_div_3_v1",
        bySource: {
          session_start: { measuredEvents: 5, returnedTokens: 9533 },
          pre_compact: { measuredEvents: 2, returnedTokens: 2853 },
          mcp_recall: { measuredEvents: 1, returnedTokens: 700 },
          mcp_smart_search: { measuredEvents: 1, returnedTokens: 200 },
        },
        retrievalSavings: {
          corpus: {
            textChars: 300000,
            textTokens: 100000,
            imageCount: 2,
            imageTokens: 1200,
            unknownImageCount: 0,
            totalTokens: 101200,
            observationCount: 400,
            memoryCount: 50,
            lessonCount: 20,
            exceedsContextWindow: false,
          },
          delivery: { events: 2, textTokensDelivered: 900, imageTokensDelivered: 0 },
          pricing: { contextWindowTokens: 1050000 },
          perFullCorpusLoad: {
            cachedReadUsd: 0.0506,
            uncachedInputUsd: 0.506,
            cacheWriteUsd: 0.6325,
          },
          totalAcrossMcpCalls: {
            estimatedTokensAvoided: 201500,
            cachedReadUsd: 0.1008,
            uncachedInputUsd: 1.0075,
            cacheWriteUsd: 1.2594,
          },
        },
      },
      configFlags: {
        flags: [{ key: "AGENTMEMORY_INJECT_CONTEXT", enabled: false }],
      },
    };

    sandbox.renderDashboard();

    const html = getElement("view-dashboard").innerHTML;
    expect(html).toContain("Automatic Injection");
    expect(html).toContain(">OFF<");
    expect(html).toContain("Capture, summaries, embeddings, and MCP recall remain active");
    expect(html).toContain("Historical: ~12,386 tokens added across 7 emissions");
    expect(html).toContain("On-Demand Recall");
    expect(html).toContain(">~900<");
    expect(html).toContain("across 2 explicit MCP calls");
    expect(html).toContain("Est. Retrieval Savings");
    expect(html).toContain("Full Corpus Equivalent");
    expect(html).toContain("Counterfactual estimate, not measured Codex/API billing");
    expect(html).not.toContain("Est. Context Reduction");
  });

  it("uses million and billion units for large retrieval savings", () => {
    const { sandbox } = loadViewerSandbox();

    expect(sandbox.formatUsdRange(90_000, 1_124_000)).toBe("$90K–$1.12M");
    expect(sandbox.formatUsd(2_250_000)).toBe("$2.25M");
    expect(sandbox.formatCompactNumber(89_944_000_000)).toBe("89.944B");
  });

  it("separates graph edges from memory relations and reports consolidation outcomes", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.dashboard = {
      loaded: true,
      health: { status: "healthy", health: {} },
      sessions: [],
      memories: [],
      graphStats: { totalNodes: 10, totalEdges: 7886 },
      recentAudit: [],
      lessons: [],
      crystals: [],
      semantic: [],
      procedural: [],
      relations: [],
      contextReduction: null,
      configFlags: { flags: [] },
      lastConsolidation: {
        timestamp: "2026-08-17T12:00:00.000Z",
        details: {
          results: {
            semantic: { newFacts: 2 },
            procedural: { skipped: true, reason: "fewer than 2 recurring patterns" },
          },
        },
      },
    };

    sandbox.renderDashboard();

    const html = getElement("view-dashboard").innerHTML;
    expect(html).toContain("Graph edges");
    expect(html).toContain(">7886<");
    expect(html).toContain("Memory relations");
    expect(html).toContain("2 new facts");
    expect(html).toContain("fewer than 2 recurring patterns");
    expect(html).toContain("Last pipeline:");
  });

  it("warns that enabled SessionStart injection can repeat on resume or reload", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.dashboard = {
      loaded: true,
      health: { status: "healthy", health: {} },
      sessions: [],
      memories: [],
      graphStats: null,
      recentAudit: [],
      lessons: [],
      crystals: [],
      contextReduction: { measuredEvents: 0, bySource: {} },
      configFlags: {
        flags: [{ key: "AGENTMEMORY_INJECT_CONTEXT", enabled: true }],
      },
    };

    sandbox.renderDashboard();

    const html = getElement("view-dashboard").innerHTML;
    expect(html).toContain(">ON<");
    expect(html).toContain("Supported hooks can add recalled memory automatically");
    expect(html).toContain("SessionStart may run again on resume or reload");
  });

  it("renders zero on-demand delivery without claiming token savings", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.dashboard = {
      loaded: true,
      health: { status: "healthy", health: {} },
      sessions: [],
      memories: [],
      graphStats: null,
      recentAudit: [],
      lessons: [],
      crystals: [],
      contextReduction: { measuredEvents: 0, bySource: {} },
      configFlags: {
        flags: [{ key: "AGENTMEMORY_INJECT_CONTEXT", enabled: false }],
      },
    };

    sandbox.renderDashboard();

    const html = getElement("view-dashboard").innerHTML;
    expect(html).toContain("Automatic Injection");
    expect(html).toContain("On-Demand Recall");
    expect(html).toContain(">~0<");
    expect(html).toContain("across 0 explicit MCP calls");
    expect(html).not.toContain("Historical:");
    expect(html).not.toContain("token savings");
  });

  it("debounces dashboard websocket refreshes without blanking rendered content", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const timers: Array<() => void> = [];
    let loadCount = 0;

    sandbox.setTimeout = (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    };
    sandbox.clearTimeout = () => {};
    sandbox.fetch = async () => ({ ok: true, json: async () => ({}) });
    sandbox.state.activeTab = "dashboard";
    sandbox.state.dashboard = {
      loaded: true,
      health: { status: "healthy", health: {} },
      sessions: [{ id: "active-1", status: "active", observationCount: 3, startedAt: "2026-05-13T12:00:00Z" }],
      memories: [],
      graphStats: null,
      recentAudit: [],
      lessons: [],
      crystals: [],
    };

    const originalLoadDashboard = sandbox.loadDashboard;
    sandbox.loadDashboard = function(...args: unknown[]) {
      loadCount++;
      return originalLoadDashboard.apply(this, args);
    };

    sandbox.renderDashboard();
    const before = getElement("view-dashboard").innerHTML;

    sandbox.routeWsMessage({ observation: { id: "obs-1", timestamp: "2026-05-13T12:01:00Z", sessionId: "active-1" } });
    sandbox.routeWsMessage({ observation: { id: "obs-2", timestamp: "2026-05-13T12:01:01Z", sessionId: "active-1" } });

    expect(loadCount).toBe(0);
    expect(timers).toHaveLength(1);
    expect(getElement("view-dashboard").innerHTML).toBe(before);

    timers[0]!();

    expect(loadCount).toBe(1);
  });

  it("opens the root websocket and sends a stream join instead of trying the direct stream URL first", () => {
    const { sandbox } = loadViewerSandbox();
    const sockets: Array<{ url: string; sent: string[]; readyState: number; __direct?: boolean; onopen?: () => void }> = [];
    sandbox.WebSocket = function WebSocket(url: string) {
      const socket = {
        url,
        sent: [] as string[],
        readyState: 1,
        send(payload: string) {
          this.sent.push(payload);
        },
        close() {},
      };
      sockets.push(socket);
      return socket;
    };
    sandbox.WebSocket.OPEN = 1;
    sandbox.WebSocket.CONNECTING = 0;

    sandbox.connectWs();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe("ws://localhost:3112");

    sockets[0].onopen!();

    expect(sockets[0].sent).toHaveLength(1);
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({
      type: "join",
      data: { streamName: "mem-live", groupId: "viewer" },
    });
  });

  it("does not throw when timeline and sessions tabs receive sessions missing ids", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const sessions = [{ status: "active", observationCount: 1, startedAt: "2026-05-13T12:00:00Z" }];

    expect(() => sandbox.renderTimelineToolbar(sessions)).not.toThrow();
    expect(getElement("view-timeline").innerHTML).toContain("Unknown session");

    sandbox.state.sessions.items = sessions;
    expect(() => sandbox.renderSessions()).not.toThrow();
    expect(getElement("view-sessions").innerHTML).toContain("Unknown session");

    const tabButtons = sandbox.document.querySelectorAll(".tab-bar button");
    expect(tabButtons.length).toBeGreaterThan(0);
    expect(() => sandbox.switchTab("sessions")).not.toThrow();
    expect(tabButtons.some((button: any) => button.classList.contains("active"))).toBe(true);
  });

  it("loads timeline observations with server pagination", async () => {
    const { sandbox } = loadViewerSandbox();
    const requests: string[] = [];
    sandbox.fetch = async (url: string) => {
      requests.push(url);
      return {
        ok: true,
        json: async () => ({
          observations: [
            {
              id: "obs-1",
              sessionId: "session-1",
              timestamp: "2026-06-17T19:00:00.000Z",
              type: "command_run",
              title: "Bash",
              importance: 4,
            },
          ],
          total: 22382,
          offset: 100,
          limit: 50,
          hasMore: true,
        }),
      };
    };
    sandbox.state.timeline.sessionId = "session-1";
    sandbox.state.timeline.page = 2;
    sandbox.state.timeline.pageSize = 50;

    await sandbox.loadObservations();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/agentmemory/observations?sessionId=session-1&limit=50&offset=100");
    expect(sandbox.state.timeline.total).toBe(22382);
    expect(sandbox.state.timeline.hasMore).toBe(true);
  });

  it("prepends live timeline observations only on page 0 and trims to page size", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.activeTab = "timeline";
    sandbox.state.timeline.loaded = true;
    sandbox.state.timeline.sessionId = "session-1";
    sandbox.state.timeline.page = 0;
    sandbox.state.timeline.pageSize = 2;
    sandbox.state.timeline.total = 2;
    sandbox.state.timeline.observations = [
      { id: "obs-2", sessionId: "session-1", timestamp: "2026-06-17T19:02:00.000Z", title: "two", type: "command_run", importance: 4 },
      { id: "obs-1", sessionId: "session-1", timestamp: "2026-06-17T19:01:00.000Z", title: "one", type: "command_run", importance: 4 },
    ];

    sandbox.routeWsMessage({
      observation: { id: "obs-3", sessionId: "session-1", timestamp: "2026-06-17T19:03:00.000Z", title: "three", type: "command_run", importance: 4 },
    });

    expect(sandbox.state.timeline.total).toBe(3);
    expect(sandbox.state.timeline.observations.map((o: any) => o.id)).toEqual(["obs-3", "obs-2"]);
  });

  it("refetches instead of mutating in-place on later timeline pages", () => {
    const { sandbox } = loadViewerSandbox();
    const loads: Array<{ page: number }> = [];
    sandbox.state.activeTab = "timeline";
    sandbox.state.timeline.loaded = true;
    sandbox.state.timeline.sessionId = "session-1";
    sandbox.state.timeline.page = 2;
    sandbox.loadObservations = () => {
      loads.push({ page: sandbox.state.timeline.page });
    };

    sandbox.routeWsMessage({
      observation: { id: "obs-9", sessionId: "session-1", timestamp: "2026-06-17T19:09:00.000Z", title: "nine", type: "command_run", importance: 4 },
    });

    expect(loads).toEqual([{ page: 2 }]);
  });
});
