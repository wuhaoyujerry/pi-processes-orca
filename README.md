# pi-processes-orca

A small [Pi](https://pi.dev) extension for people who use
[`@aliou/pi-processes`](https://github.com/aliou/pi-processes) inside
[Orca](https://github.com/stablyai/orca).

When a Pi turn ends but a background process still runs, the Orca terminal
pane shows **Monitoring**, not finished. The pane returns to finished when the
last process ends.

It contains only this adapter. It does not include or replace pi-processes.

## Requirements

- Pi 1.4.0 or later, run in an Orca terminal pane
- `@aliou/pi-processes` installed in Pi

Without pi-processes, or outside Orca, the extension does nothing.

## Installation

```bash
pi install git:github.com/wuhaoyujerry/pi-processes-orca
```

No setup is needed.

## How it works

Orca's own Pi hooks report the turn: working, then done. They know nothing
about pi-processes, so a pane whose dev server still runs looks finished. Orca
also reads a status report from any program in a terminal pane, written as an
OSC 9999 escape sequence. This extension writes that report. It needs no
change in Orca or in pi-processes.

```text
agent_settled, or processes:changed while idle
  wait 1 second
    a process is alive   → report working + monitoring, repeat every 30 seconds
    no process is alive  → report done, only if monitoring was reported

before_agent_start, agent_start
  cancel the pending report; Orca's hooks own the row during a turn

session_shutdown
  report done if monitoring was reported
```

It reads process state through the public pi-processes event protocol: it
listens to `processes:changed` and asks `processes:request:list`. A process
counts as alive while its status is `running`, `terminating`, or
`terminate_timeout`.

The 1 second wait exists for two reasons:

- Orca's hook reports the settled turn as done over HTTP. A report written
  sooner arrives first and is overwritten.
- A process that ends and wakes the agent starts a new turn inside the wait.
  That cancels the report, so the pane does not flash finished.

The repeat exists because Orca drops a working row that stays silent for 30
minutes, and because a late hook report can still overwrite this one.

Each report carries the turn's prompt and last reply text. Orca replaces the
whole status row with each report, so without them the pane would lose that
text.

## Limits

- The report format is Orca's internal one. A later Orca release can change it.
- Terminal panes only. Orca's native chat runs Pi in RPC mode, where stdout is
  a protocol stream, so nothing is written there.
- The pane shows the Monitoring state only. It lists no process names.
- While Pi is idle, a repeat can overwrite a status that Orca's hooks set in
  the meantime, such as an open dialog or a running pi-subagents agent.
- Inside tmux the sequence does not reach Orca.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

## License

MIT
