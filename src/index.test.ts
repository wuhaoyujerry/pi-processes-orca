import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "./index";
import { SETTLE_DELAY_MS } from "./status-reporter";

type Handler = (event: object, ctx: ExtensionContext) => unknown;

function setup(options: { mode?: ExtensionContext["mode"] } = {}) {
  const handlers = new Map<string, Handler>();
  const events = createEventBus();
  const pi = {
    events,
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: options.mode ?? "tui",
    isIdle: () => false,
  } as unknown as ExtensionContext;

  // Stands in for pi-processes' list handler.
  let processes: unknown = [];
  events.on("processes:request:list", (payload) => {
    (payload as { reply: (list: unknown) => void }).reply(processes);
  });

  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  extension(pi);

  return {
    handlers,
    fire: (event: string, payload: object = {}) =>
      handlers.get(event)?.(payload, ctx),
    setProcesses: (list: unknown) => {
      processes = list;
      events.emit("processes:changed", { reason: "started" });
    },
    reports: () =>
      stdout.mock.calls.map(([sequence]) =>
        JSON.parse(String(sequence).slice(7, -1)),
      ),
  };
}

describe("pi-processes-orca extension", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("ORCA_TERMINAL_HANDLE", "term_1");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers nothing outside an Orca terminal", () => {
    vi.stubEnv("ORCA_TERMINAL_HANDLE", "");
    const { handlers } = setup();
    expect(handlers.size).toBe(0);
  });

  it("writes nothing when stdout is a protocol stream", () => {
    const { fire, setProcesses, reports } = setup({ mode: "rpc" });
    fire("session_start");
    setProcesses([{ status: "running" }]);
    fire("agent_settled");
    vi.advanceTimersByTime(SETTLE_DELAY_MS);
    expect(reports()).toEqual([]);
  });

  it("does not count ended processes", () => {
    const { fire, setProcesses, reports } = setup();
    fire("session_start");
    setProcesses([{ status: "exited" }, { status: "killed" }]);
    fire("agent_settled");
    vi.advanceTimersByTime(SETTLE_DELAY_MS);
    expect(reports()).toEqual([]);
  });

  it("writes nothing when the list reply is not a process list", () => {
    const { fire, setProcesses, reports } = setup();
    fire("session_start");
    for (const reply of [null, "running", [null, 7, { status: 1 }]]) {
      setProcesses(reply);
    }
    fire("agent_settled");
    vi.advanceTimersByTime(SETTLE_DELAY_MS);
    expect(reports()).toEqual([]);
  });

  it("reports monitoring with the turn's prompt and last reply text", () => {
    const { fire, setProcesses, reports } = setup();
    fire("session_start");
    fire("before_agent_start", { messageType: "user", prompt: "start it" });
    fire("agent_start");
    setProcesses([
      { status: "exited" },
      { status: "running" },
      { status: "terminating" },
    ]);
    fire("agent_end", {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Started." }] },
        { role: "toolResult", content: [{ type: "text", text: "ok" }] },
        { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
      ],
    });
    fire("agent_settled");
    vi.advanceTimersByTime(SETTLE_DELAY_MS);

    expect(reports()).toEqual([
      {
        state: "working",
        workingMode: "monitoring",
        agentType: "pi",
        prompt: "start it",
        lastAssistantMessage: "Started.",
      },
    ]);
  });

  it("closes the monitoring row when the session shuts down", () => {
    const { fire, setProcesses, reports } = setup();
    fire("session_start");
    setProcesses([{ status: "running" }]);
    fire("agent_settled");
    vi.advanceTimersByTime(SETTLE_DELAY_MS);
    fire("session_shutdown");

    expect(reports().map((report) => report.state)).toEqual([
      "working",
      "done",
    ]);
  });
});
