// Shared session-liveness registry, v1. Hosts that may stop an idle Pi
// session (Orca native chat, pi-web) ask it first; a provider that reports
// active keeps the session, and its background processes, alive.
//
// Whoever loads first creates the registry. The creation below matches the
// one Orca injects, so the result is the same whichever extension loads first.

const REGISTRY_KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");

export interface SessionLivenessProvider {
  name: string;
  sessionId: string;
  sessionFile?: string;
  isActive(): boolean;
}

interface SessionLivenessRegistry {
  version: 1;
  register(provider: SessionLivenessProvider): () => void;
  hasActiveProvider(session: {
    sessionId?: string;
    sessionFile?: string;
  }): boolean;
}

function isRegistry(value: unknown): value is SessionLivenessRegistry {
  const registry = value as Partial<SessionLivenessRegistry> | null;
  return (
    typeof registry === "object" &&
    registry !== null &&
    registry.version === 1 &&
    typeof registry.register === "function" &&
    typeof registry.hasActiveProvider === "function"
  );
}

function createRegistry(): SessionLivenessRegistry {
  const providers = new Map<symbol, SessionLivenessProvider>();
  const text = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0;
  return {
    version: 1,
    register(provider) {
      if (
        !provider ||
        !text(provider.name) ||
        !text(provider.sessionId) ||
        (provider.sessionFile !== undefined && !text(provider.sessionFile)) ||
        typeof provider.isActive !== "function"
      ) {
        throw new Error("Session liveness provider is invalid");
      }
      const key = Symbol(provider.name);
      providers.set(key, provider);
      return () => {
        providers.delete(key);
      };
    },
    hasActiveProvider(session) {
      const ids = new Set(
        [session.sessionId, session.sessionFile].filter(Boolean),
      );
      for (const provider of providers.values()) {
        const matches =
          ids.has(provider.sessionId) ||
          (provider.sessionFile !== undefined && ids.has(provider.sessionFile));
        if (!matches) continue;
        // A failing provider keeps the session rather than losing its work.
        try {
          if (provider.isActive() !== false) return true;
        } catch {
          return true;
        }
      }
      return false;
    },
  };
}

export function sessionLivenessRegistry(): SessionLivenessRegistry {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[REGISTRY_KEY];
  if (isRegistry(existing)) return existing;
  const registry = createRegistry();
  global[REGISTRY_KEY] = registry;
  return registry;
}
