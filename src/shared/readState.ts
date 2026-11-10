import type { CommentMessage, CommentThread } from './comments.ts';

/**
 * Which comment threads each person has seen, kept by the server per project
 * in `.texwerk/read-state.json`:
 *
 *   { "<login>": { "<thread id>": <time of the newest message seen, ms> } }
 *
 * The login is the identity's: `guest:<typed name, lower case>` without
 * --access, the tailnet login with it. So every browser and device of one
 * name shares its read state, and another typed name has its own.
 *
 * A thread is unread when it has a message by someone else (a person, or an
 * agent, also the viewer's own) newer than what was seen of it. Times are the server's message
 * times, never a browser's clock, so a browser whose clock is off cannot
 * miss or repeat a message. A resolved thread counts as read.
 */

/** Thread id -> time of the newest message seen (ms). */
export type SeenThreads = Record<string, number>;

/** The newest message time of a thread, mine included: what opening it has seen. */
export function newestMessage(t: CommentThread): number {
  return t.messages.reduce((max, m) => Math.max(max, m.ts), t.createdAt || 0);
}

/**
 * `current` with `update` folded in, keeping the later time per thread, so
 * two tabs that mark different threads, or the same one at different times,
 * both keep what they marked. Entries that are not a positive finite time
 * are ignored.
 */
export function mergeSeen(current: SeenThreads, update: Record<string, unknown>): { merged: SeenThreads; changed: boolean } {
  const merged: SeenThreads = { ...current };
  let changed = false;
  for (const [id, value] of Object.entries(update)) {
    const ts = Number(value);
    if (!id || !Number.isFinite(ts) || ts <= 0) continue;
    if (!(ts <= (merged[id] ?? 0))) {
      merged[id] = ts;
      changed = true;
    }
  }
  return { merged, changed };
}

/** The messages of `t` that `login` has not seen; none while the read state is not known yet. */
export function unreadMessages(t: CommentThread, seen: SeenThreads | null, login: string): CommentMessage[] {
  if (!seen || t.resolved) return [];
  const after = seen[t.id] ?? 0;
  return t.messages.filter((m) => m.ts > after && (m.login !== login || byAgent(m)));
}

/**
 * Written by an agent through the mirror bridge: such messages carry the
 * login of the person running it, and "<name> \u00b7 agent" as the author
 * (src/server/server.ts). They are not the viewer's own, even for that person.
 */
export function byAgent(m: CommentMessage): boolean {
  return m.author.endsWith(' \u00b7 agent');
}

/** Everything seen as of now: what a name starts with, and "Mark all read". */
export function allSeen(threads: CommentThread[]): SeenThreads {
  return Object.fromEntries(threads.map((t) => [t.id, newestMessage(t)]));
}
