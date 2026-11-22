import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatOrcaStatus,
  type OrcaStatus,
  OrcaStatusReporter,
  REFRESH_INTERVAL_MS,
  SETTLE_DELAY_MS,
} from "./status-reporter";

function decode(sequence: string): OrcaStatus {
  expect(sequence.startsWith("\x1b]9999;")).toBe(true);
  expect(sequence.endsWith("\x07")).toBe(true);
  return JSON.parse(sequence.slice(7, -1));
}

function setup(live = 0) {
  const state = { live };
  const written: OrcaStatus[] = [];
  const reporter = new OrcaStatusReporter({
    countLive: () => state.live,
    write: (sequence) => written.push(decode(sequence)),
  });
  return { state, written, reporter };
}

describe("OrcaStatusReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports monitoring after the turn settles with a live process", () => {
    const { written, reporter } = setup(1);
    reporter.turnStarted("run the dev server");
    reporter.turnEnded("Server is up.");
    reporter.settled();

    // Orca's own done report for the turn has to land first.
    vi.advanceTimersByTime(SETTLE_DELAY_MS - 1);
    expect(written).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(written).toEqual([
      {
        state: "working",
        workingMode: "monitoring",
        agentType: "pi",
        prompt: "run the dev server",
        lastAssistantMessage: "Server is up.",
      },
    ]);
  });

  it("writes nothing when no process is alive", () => {
    const { written, reporter } = setup(0);
    reporter.settled();
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 2);
    expect(written).toEqual([]);
  });

  it("re-sends monitoring while the process stays alive", () => {
    const { written, reporter } = setup(1);
    reporter.settled();
    vi.advanceTimersByTime(SETTLE_DELAY_MS + REFRESH_INTERVAL_MS * 2);
    expect(written.map((status) => status.workingMode)).toEqual([
      "monitoring",
      "monitoring",
      "monitoring",
    ]);
  });

  it("reports done once after the last process ends", () => {
    const { state, written, reporter } = setup(1);
    reporter.turnStarted("build it");
    reporter.turnEnded("Building.");
    reporter.settled();
    vi.advanceTimersByTime(SETTLE_DELAY_MS);

    state.live = 0;
    reporter.processesChanged();
    vi.advanceTimersByTime(SETTLE_DELAY_MS + REFRESH_INTERVAL_MS);

    expect(written.slice(1)).toEqual([
      {
        state: "done",
        agentType: "pi",
        prompt: "build it",
        lastAssistantMessage: "Building.",
      },
    ]);
  });

  it("starts monitoring when a process appears while idle", () => {
    const { state, written, reporter } = setup(0);
    reporter.settled();
    vi.advanceTimersByTime(SETTLE_DELAY_MS);

    state.live = 1;
    reporter.processesChanged();
    vi.advanceTimersByTime(SETTLE_DELAY_MS);

    expect(written.map((status) => status.workingMode)).toEqual(["monitoring"]);
  });

  it("leaves the row to Orca's hooks once a turn starts", () => {
    const { state, written, reporter } = setup(1);
    reporter.settled();
    vi.advanceTimersByTime(SETTLE_DELAY_MS);

    // The process ends and wakes the agent before the delay runs out.
    state.live = 0;
    reporter.processesChanged();
    reporter.turnStarted();
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 2);

    expect(written).toHaveLength(1);
  });

  it("ignores process changes during a turn", () => {
    const { written, reporter } = setup(1);
    reporter.turnStarted("go");
    reporter.processesChanged();
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 2);
    expect(written).toEqual([]);
  });

  it("reports done on dispose only while monitoring", () => {
    const idle = setup(0);
    idle.reporter.settled();
    idle.reporter.dispose();
    expect(idle.written).toEqual([]);

    const monitoring = setup(1);
    monitoring.reporter.settled();
    vi.advanceTimersByTime(SETTLE_DELAY_MS);
    monitoring.reporter.dispose();
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 2);

    expect(monitoring.written.map((status) => status.state)).toEqual([
      "working",
      "done",
    ]);
  });

  it("cuts prompt and reply to Orca's field limits", () => {
    const { written, reporter } = setup(1);
    reporter.turnStarted("p".repeat(500));
    reporter.turnEnded("r".repeat(9000));
    reporter.settled();
    vi.advanceTimersByTime(SETTLE_DELAY_MS);

    expect(written[0].prompt).toHaveLength(200);
    expect(written[0].lastAssistantMessage).toHaveLength(8000);
  });
});

describe("formatOrcaStatus", () => {
  it("keeps terminator bytes in the text from ending the sequence", () => {
    const hostile = 'a\x07b\x1b\\c\x1b]9999;{"state":"done"}\x07';
    const sequence = formatOrcaStatus({
      state: "done",
      agentType: "pi",
      prompt: hostile,
      lastAssistantMessage: hostile,
    });

    // Only the framing holds raw control bytes: ESC first, BEL last.
    const controls = [...sequence].flatMap((char, index) =>
      char.charCodeAt(0) < 0x20 ? [index] : [],
    );
    expect(controls).toEqual([0, sequence.length - 1]);
    expect(decode(sequence).prompt).toBe(hostile);
  });
});
