import type {
  AgentEndEvent,
  EventBus,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { sessionLivenessRegistry } from "./session-liveness";
import { OrcaStatusReporter } from "./status-reporter";

// The public event protocol of @aliou/pi-processes (its docs/events.md).
// This package talks to it only through these two channels.
const PROCESSES_CHANGED = "processes:changed";
const PROCESSES_REQUEST_LIST = "processes:request:list";
const LIVE_STATUSES = new Set(["running", "terminating", "terminate_timeout"]);

// Orca native chat shows Monitoring while this status line lists a command.
const ORCA_BACKGROUND_COMMANDS_KEY = "orca-background-commands";

interface LiveProcess {
  id?: unknown;
  name?: unknown;
  command?: unknown;
  startTime?: unknown;
}

/** Live processes pi-processes reports; empty when it is not loaded. */
function listLiveProcesses(events: EventBus): LiveProcess[] {
  let live: LiveProcess[] = [];
  events.emit(PROCESSES_REQUEST_LIST, {
    reply: (processes: unknown) => {
      if (!Array.isArray(processes)) return;
      live = processes.filter(
        (info: { status?: unknown } | null) =>
          typeof info?.status === "string" && LIVE_STATUSES.has(info.status),
      );
    },
  });
  return live;
}

function countLiveProcesses(events: EventBus): number {
  return listLiveProcesses(events).length;
}

/** Status-line text for Orca's background-commands roster. */
export function backgroundCommandsStatus(processes: LiveProcess[]): string {
  return JSON.stringify({
    commands: processes.flatMap((info) => {
      if (typeof info.id !== "string") return [];
      const label = [info.name, info.command]
        .filter((part) => typeof part === "string" && part.length > 0)
        .join(": ");
      return [
        {
          id: info.id,
          state: "working",
          ...(typeof info.startTime === "number"
            ? { startedAt: info.startTime }
            : {}),
          ...(label ? { description: label } : {}),
        },
      ];
    }),
  });
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
  // Orca sets ORCA_TERMINAL_HANDLE for every terminal it runs, and
  // ORCA_STRUCTURED_SESSION for its native chat, which removes the handle.
  const inTerminal = Boolean(process.env.ORCA_TERMINAL_HANDLE);
  const inChat = Boolean(process.env.ORCA_STRUCTURED_SESSION);
  if (!inTerminal && !inChat) return;

  let reporter: OrcaStatusReporter | null = null;
  let unsubscribe: (() => void) | null = null;
  let releaseLiveness: (() => void) | null = null;
  let clearCommands: (() => void) | null = null;

  const stop = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    reporter?.dispose();
    reporter = null;
    releaseLiveness?.();
    releaseLiveness = null;
    clearCommands?.();
    clearCommands = null;
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    // Native chat stops an idle Pi after a while, which kills its processes.
    // It asks this registry first, so a live process keeps the session.
    if (inChat) {
      releaseLiveness = sessionLivenessRegistry().register({
        name: "pi-processes-orca",
        sessionId: ctx.sessionManager.getSessionId(),
        // An in-memory session has no file; an empty name fails validation.
        sessionFile: ctx.sessionManager.getSessionFile() || undefined,
        isActive: () => countLiveProcesses(pi.events) > 0,
      });
      let published = JSON.stringify({ commands: [] });
      const publish = (text: string): void => {
        if (text === published) return;
        published = text;
        try {
          ctx.ui.setStatus(ORCA_BACKGROUND_COMMANDS_KEY, text);
        } catch {
          // A context from a replaced session throws; its roster no longer matters.
        }
      };
      const report = () =>
        publish(backgroundCommandsStatus(listLiveProcesses(pi.events)));
      const off = pi.events.on(PROCESSES_CHANGED, report);
      clearCommands = () => {
        off();
        publish(JSON.stringify({ commands: [] }));
      };
      report();
    }
    // In RPC and JSON modes stdout is a protocol stream, not a terminal.
    if (!inTerminal || ctx.mode !== "tui") return;

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
