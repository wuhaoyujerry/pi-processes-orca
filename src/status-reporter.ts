/**
 * Reports "monitoring" to Orca while background processes outlive a turn.
 *
 * Orca's own Pi hooks report the turn (working, then done) and know nothing
 * about pi-processes, so a pane whose dev server still runs looks finished.
 * Orca also reads a status report from any program in a terminal pane, as an
 * OSC 9999 escape sequence. This writes one once the turn settles.
 */

// Orca cuts these fields to the same lengths.
const PROMPT_MAX_LENGTH = 200;
const REPLY_MAX_LENGTH = 8000;

/**
 * Wait after a settle or a process change. Orca's hook reports the settled
 * turn as done over HTTP; a report written sooner would be overwritten by it.
 * A process that ends and wakes the agent starts a turn within this window,
 * which cancels the report.
 */
export const SETTLE_DELAY_MS = 1000;

/**
 * Re-send interval while monitoring. Orca decays a working row that stays
 * silent for 30 minutes, and a late hook report can still overwrite ours.
 */
export const REFRESH_INTERVAL_MS = 30_000;

export interface OrcaStatus {
  state: "working" | "done";
  workingMode?: "monitoring";
  agentType: "pi";
  prompt: string;
  lastAssistantMessage: string;
}

/**
 * Encode one report. `JSON.stringify` escapes every control character, so
 * prompt or reply text cannot end the sequence early.
 */
export function formatOrcaStatus(status: OrcaStatus): string {
  return `\x1b]9999;${JSON.stringify(status)}\x07`;
}

export interface OrcaStatusReporterDeps {
  /** Number of background processes that are still alive. */
  countLive: () => number;
  /** Writes one escape sequence to the terminal. */
  write: (sequence: string) => void;
}

export class OrcaStatusReporter {
  private idle = false;
  private monitoring = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private prompt = "";
  private reply = "";

  constructor(private readonly deps: OrcaStatusReporterDeps) {}

  /** A turn is starting. Orca's hooks own the row until it settles. */
  turnStarted(prompt?: string): void {
    this.idle = false;
    this.monitoring = false;
    this.reply = "";
    if (prompt !== undefined) this.prompt = prompt;
    this.clearTimer();
  }

  /** An agent run ended; `reply` is its last assistant text. */
  turnEnded(reply: string): void {
    this.reply = reply;
  }

  /** Pi will not continue on its own. */
  settled(): void {
    this.idle = true;
    this.schedule(SETTLE_DELAY_MS);
  }

  /** The set of background processes changed. */
  processesChanged(): void {
    if (this.idle) this.schedule(SETTLE_DELAY_MS);
  }

  /** The session ends, which also ends its background processes. */
  dispose(): void {
    this.clearTimer();
    this.idle = false;
    if (this.monitoring) this.report("done");
    this.monitoring = false;
  }

  private sync(): void {
    this.timer = undefined;
    if (this.deps.countLive() > 0) {
      this.monitoring = true;
      this.report("working");
      this.schedule(REFRESH_INTERVAL_MS);
    } else if (this.monitoring) {
      this.monitoring = false;
      this.report("done");
    }
  }

  private report(state: OrcaStatus["state"]): void {
    // Orca replaces the whole row, so each report carries the text the hook
    // row showed. Without it the pane loses its prompt and reply preview.
    this.deps.write(
      formatOrcaStatus({
        state,
        ...(state === "working" ? { workingMode: "monitoring" } : {}),
        agentType: "pi",
        prompt: this.prompt.slice(0, PROMPT_MAX_LENGTH),
        lastAssistantMessage: this.reply.slice(0, REPLY_MAX_LENGTH),
      }),
    );
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.sync(), delayMs);
    // The refresh timer must not keep Pi alive after it is asked to exit.
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
