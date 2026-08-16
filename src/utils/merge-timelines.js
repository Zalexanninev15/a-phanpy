/*
  Merges several independently-paginated timelines into one stream ordered by
  createdAt, newest first.

  The whole point of keeping this file free of network, DOM and Preact is that
  the ordering logic is the part that is easy to get subtly wrong and hard to
  eyeball in a running app. It can be exercised in Node instead —
  see tests/merge-timelines.test.js.

  The ordering problem
  --------------------
  Naively concatenating a page from each source and sorting is wrong: source A's
  page may end at 10:00 while source B's ends at 08:00. If we emit everything
  down to 08:00, A's *next* page will contain 09:xx posts that belong above ones
  we already showed, and they would pop in below.

  So each round only releases items down to a watermark: the newest of the
  oldest-held timestamps across sources that can still deliver more. Anything at
  or above that watermark is guaranteed to have no unseen predecessor. The rest
  stays buffered for the next round.
*/

const DEFAULT_LIMIT = 20;
// Guards against a source that keeps returning items older than the watermark,
// which would otherwise spin fetching forever without filling a page.
const MAX_ROUNDS_PER_PAGE = 5;

function timeOf(item) {
  const t = Date.parse(item?.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * @param {Object} options
 * @param {Array} options.sources  [{ id, fetchPage: async (firstLoad) => ({ value, done }) }]
 * @param {number} [options.limit] soft target for how many items one next() yields
 * @param {Function} [options.onSourceError] called as (sourceID, error)
 */
export function createMergedTimeline({
  sources,
  limit = DEFAULT_LIMIT,
  onSourceError,
}) {
  if (!sources?.length) {
    throw new Error('createMergedTimeline requires at least one source');
  }

  // Per-source state lives here rather than on the caller's objects so that
  // callers can pass frozen/shared descriptors.
  let state = sources.map((source) => ({
    source,
    buffer: [],
    exhausted: false,
    failed: false,
    started: false,
  }));

  function active() {
    return state.filter((s) => !s.exhausted && !s.failed);
  }

  async function fill(s, firstLoad) {
    try {
      const { value, done } = await s.source.fetchPage(firstLoad);
      s.started = true;
      if (value?.length) {
        for (const item of value) {
          s.buffer.push(item);
        }
        // Sources are *supposed* to be sorted already, but a boost or a
        // pinned post can break that, and one stray item poisons the merge.
        s.buffer.sort((a, b) => timeOf(b) - timeOf(a));
      }
      if (done || !value?.length) s.exhausted = true;
    } catch (e) {
      s.failed = true;
      onSourceError?.(s.source.id, e);
    }
  }

  /**
   * Highest timestamp that is safe to emit down to. Sources that can still
   * deliver more constrain it; exhausted and failed ones do not.
   * Returns -Infinity when nothing constrains us, i.e. flush everything.
   */
  function watermark() {
    let mark = -Infinity;
    for (const s of active()) {
      // A live source holding nothing could return anything next, so we
      // cannot release a single item until it has been refilled.
      if (!s.buffer.length) return Infinity;
      const oldestHeld = timeOf(s.buffer[s.buffer.length - 1]);
      if (oldestHeld > mark) mark = oldestHeld;
    }
    return mark;
  }

  function drain(mark) {
    const released = [];
    for (const s of state) {
      while (s.buffer.length && timeOf(s.buffer[0]) >= mark) {
        released.push(s.buffer.shift());
      }
    }
    released.sort((a, b) => timeOf(b) - timeOf(a));
    return released;
  }

  async function next(firstLoad = false) {
    if (firstLoad) {
      state = state.map((s) => ({
        ...s,
        buffer: [],
        exhausted: false,
        failed: false,
        started: false,
      }));
    }

    let out = [];

    for (let round = 0; round < MAX_ROUNDS_PER_PAGE; round++) {
      const needsFilling = active().filter((s) => !s.buffer.length);
      if (needsFilling.length) {
        await Promise.all(
          needsFilling.map((s) => fill(s, firstLoad && !s.started)),
        );
      }

      const mark = watermark();
      if (mark === Infinity) continue; // a live source is still empty, retry

      out = out.concat(drain(mark));
      if (out.length >= limit) break;
      if (!active().length) break; // everything exhausted, nothing more coming
    }

    // Everything is spent and buffers are empty — the merged stream is over.
    const done = !active().length && state.every((s) => !s.buffer.length);

    return { value: out, done };
  }

  return {
    next,
    /** Diagnostics for the UI: which accounts stopped early or errored. */
    status: () =>
      state.map(({ source, exhausted, failed, buffer }) => ({
        id: source.id,
        exhausted,
        failed,
        buffered: buffer.length,
      })),
  };
}
