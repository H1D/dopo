// @ts-check
/**
 * Shuffle-bag for background music: every eligible track plays once before any
 * repeats, the walk survives sessions (state persists in localStorage via
 * lib/store.js), and a reshuffle never opens with the track that just played.
 * Pure functions over a plain state object — no storage, no audio, no DOM —
 * so the whole contract is unit-testable.
 *
 * State shape (persisted as dopo.music.v1):
 *   bag    shuffled track ids, walked left to right across sessions
 *   pos    index of the CURRENT track in bag (-1 = nothing played yet)
 *   banned ids the user never wants to hear again ("🚫" in the mini-player)
 */

/** @typedef {{bag: string[], pos: number, banned: string[]}} MusicState */

/** @returns {MusicState} */
export function emptyState() {
  return { bag: [], pos: -1, banned: [] };
}

/**
 * Shape-validate persisted state (lsGet-style: corrupted storage degrades to
 * empty, never throws) and reconcile it against the current manifest: ids that
 * left the manifest drop out of bag and banned; ids new to the manifest join
 * at the next reshuffle.
 * @param {unknown} raw
 * @param {string[]} ids  all track ids in the manifest
 * @returns {MusicState}
 */
export function normalizeState(raw, ids) {
  if (typeof raw !== "object" || raw === null) return emptyState();
  const o = /** @type {Record<string, unknown>} */ (raw);
  const known = new Set(ids);
  const strings = (/** @type {unknown} */ v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" && known.has(x)) : [];
  const banned = [...new Set(strings(o.banned))];
  const bannedSet = new Set(banned);
  const bag = [...new Set(strings(o.bag))].filter((id) => !bannedSet.has(id));
  const rawPos = typeof o.pos === "number" && Number.isInteger(o.pos) ? o.pos : -1;
  // Reconciliation may have removed entries before pos; clamping to the bag is
  // enough — worst case a few tracks replay early, never a crash.
  const pos = Math.min(Math.max(rawPos, -1), bag.length - 1);
  return { bag, pos, banned };
}

/**
 * Fisher–Yates over the eligible ids. When `avoidFirst` is given and there is
 * more than one track, the reshuffle never opens with it — "random but always
 * new" must hold across the bag boundary too.
 * @param {string[]} ids
 * @param {string[]} banned
 * @param {() => number} rng  [0,1) — injected so tests are deterministic
 * @param {string|null} [avoidFirst]
 * @returns {string[]}
 */
export function buildBag(ids, banned, rng, avoidFirst = null) {
  const bannedSet = new Set(banned);
  const bag = ids.filter((id) => !bannedSet.has(id));
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = /** @type {string} */ (bag[i]);
    bag[i] = /** @type {string} */ (bag[j]);
    bag[j] = a;
  }
  if (bag.length > 1 && bag[0] === avoidFirst) {
    const j = 1 + Math.floor(rng() * (bag.length - 1));
    const a = /** @type {string} */ (bag[0]);
    bag[0] = /** @type {string} */ (bag[j]);
    bag[j] = a;
  }
  return bag;
}

/** @param {MusicState} state @returns {string|null} */
export function currentTrack(state) {
  return state.pos >= 0 ? state.bag[state.pos] ?? null : null;
}

/** The track after the current one — what the prefetcher warms.
 * Null at the bag boundary: the next bag doesn't exist until advance() builds
 * it, and prefetching a guess would be wrong half the time.
 * @param {MusicState} state @returns {string|null} */
export function peekNext(state) {
  return state.bag[state.pos + 1] ?? null;
}

/**
 * Move to the next track: app open, track end and skip all funnel here.
 * Walks the bag; at the end, reshuffles the full eligible set avoiding an
 * immediate repeat of the last played track.
 * @param {MusicState} state
 * @param {string[]} ids  all track ids in the manifest (new ids join here)
 * @param {() => number} rng
 * @returns {MusicState}  next state; currentTrack(next) is the track to play
 */
export function advance(state, ids, rng) {
  if (state.pos + 1 < state.bag.length) {
    return { ...state, pos: state.pos + 1 };
  }
  const last = currentTrack(state);
  const bag = buildBag(ids, state.banned, rng, last);
  return { bag, pos: bag.length ? 0 : -1, banned: state.banned };
}

/**
 * Ban a track ("never play this again"): it leaves the bag immediately and
 * every future bag. Banning the current track shifts pos so the NEXT advance()
 * lands where it would have anyway — a ban is not also a skip.
 * @param {MusicState} state
 * @param {string} id
 * @returns {MusicState}
 */
export function applyBan(state, id) {
  if (state.banned.includes(id)) return state;
  const banned = [...state.banned, id];
  const removedBeforePos = state.bag.slice(0, state.pos + 1).filter((t) => t === id).length;
  const bag = state.bag.filter((t) => t !== id);
  const pos = Math.min(state.pos - removedBeforePos, bag.length - 1);
  return { bag, pos, banned };
}
