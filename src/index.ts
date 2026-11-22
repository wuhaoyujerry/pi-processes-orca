import type {
  AgentEndEvent,
  EventBus,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { OrcaStatusReporter } from "./status-reporter";

// The public event protocol of @aliou/pi-processes (its docs/events.md).
// This package talks to it only through these two channels.
const PROCESSES_CHANGED = "processes:changed";
const PROCESSES_REQUEST_LIST = "processes:request:list";
const LIVE_STATUSES = new Set(["running", "terminating", "terminate_timeout"]);

/** Live processes pi-processes reports; 0 when it is not loaded. */
function countLiveProcesses(events: EventBus): number {
  let live = 0;
  events.emit(PROCESSES_REQUEST_LIST, {
    reply: (processes: unknown) => {
      if (!Array.isArray(processes)) return;
      live = processes.filter((info: { status?: unknown } | null) => {
        const status = info?.status;
        return typeof status === "string" && LIVE_STATUSES.has(status);
      }).length;
    },
  });
  return live;
}

/** Text of the last assistant message that has any. */
function lastAssistantText(messages: AgentEndEvent["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

export default function processesOrcaExtension(pi: ExtensionAPI): void {
  // Orca sets this for every terminal it runs. Other terminals do not
  // understand the report, so write it nowhere else.
  if (!process.env.ORCA_TERMINAL_HANDLE) return;

  let reporter: OrcaStatusReporter | null = null;
  let unsubscribe: (() => void) | null = null;

  const stop = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    reporter?.dispose();
    reporter = null;
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    // In RPC and JSON modes stdout is a protocol stream, not a terminal.
    if (ctx.mode !== "tui") return;

    const current = new OrcaStatusReporter({
      countLive: () => countLiveProcesses(pi.events),
      write: (sequence) => {
        process.stdout.write(sequence);
      },
    });
    reporter = current;
    unsubscribe = pi.events.on(PROCESSES_CHANGED, () =>
      current.processesChanged(),
    );
    if (ctx.isIdle()) current.settled();
  });

  pi.on("before_agent_start", (event) => {
    reporter?.turnStarted(event.messageType === "user" ? event.prompt : "");
  });
  pi.on("agent_start", () => reporter?.turnStarted());
  pi.on("agent_end", (event) => {
    reporter?.turnEnded(lastAssistantText(event.messages));
  });
  pi.on("agent_settled", () => reporter?.settled());
  pi.on("session_shutdown", stop);
}
