/*
  Run with:  node --test tests/merge-timelines.test.js
  No browser, no network — this is exactly why the merge logic lives in a
  separate module.
*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMergedTimeline } from '../src/utils/merge-timelines.js';

const t = (mins) => new Date(Date.UTC(2024, 0, 1, 12, 0) - mins * 60000).toISOString();

/** Builds a source that hands out `pages` one call at a time. */
function fakeSource(id, pages) {
  let i = 0;
  return {
    id,
    fetchPage: async (firstLoad) => {
      if (firstLoad) i = 0;
      if (i >= pages.length) return { value: [], done: true };
      const value = pages[i++];
      return { value, done: i >= pages.length };
    },
  };
}

const post = (id, mins) => ({ id, createdAt: t(mins) });

test('interleaves two sources strictly newest-first', async () => {
  const merged = createMergedTimeline({
    sources: [
      fakeSource('a', [[post('a1', 0), post('a2', 20)]]),
      fakeSource('b', [[post('b1', 10), post('b2', 30)]]),
    ],
    limit: 10,
  });

  const seen = [];
  let done = false;
  while (!done) {
    const r = await merged.next(seen.length === 0);
    seen.push(...r.value);
    done = r.done;
  }

  assert.deepEqual(
    seen.map((s) => s.id),
    ['a1', 'b1', 'a2', 'b2'],
  );
});

test('never emits an item that a later page would have to jump above', async () => {
  // 'a' reaches far back on page 1; 'b' lags. If the watermark were ignored,
  // a3/a4 would be shown before b's 09:xx posts had a chance to appear.
  const merged = createMergedTimeline({
    sources: [
      fakeSource('a', [
        [post('a1', 0), post('a2', 5), post('a3', 60), post('a4', 90)],
      ]),
      fakeSource('b', [
        [post('b1', 10), post('b2', 15)],
        [post('b3', 45), post('b4', 100)],
      ]),
    ],
    limit: 3,
  });

  const seen = [];
  let done = false;
  let guard = 0;
  while (!done && guard++ < 20) {
    const r = await merged.next(seen.length === 0);
    seen.push(...r.value);
    done = r.done;
  }

  const times = seen.map((s) => Date.parse(s.createdAt));
  for (let i = 1; i < times.length; i++) {
    assert.ok(
      times[i] <= times[i - 1],
      `out of order at ${i}: ${seen[i - 1].id} then ${seen[i].id}`,
    );
  }
  assert.deepEqual(
    seen.map((s) => s.id),
    ['a1', 'a2', 'b1', 'b2', 'b3', 'a3', 'a4', 'b4'],
  );
});

test('keeps going when one source runs dry early', async () => {
  const merged = createMergedTimeline({
    sources: [
      fakeSource('a', [[post('a1', 0)]]),
      fakeSource('b', [[post('b1', 5)], [post('b2', 50)]]),
    ],
    limit: 10,
  });

  const seen = [];
  let done = false;
  let guard = 0;
  while (!done && guard++ < 20) {
    const r = await merged.next(seen.length === 0);
    seen.push(...r.value);
    done = r.done;
  }

  assert.deepEqual(
    seen.map((s) => s.id),
    ['a1', 'b1', 'b2'],
  );
});

test('a failing source is reported and the rest still stream', async () => {
  const errors = [];
  const merged = createMergedTimeline({
    sources: [
      fakeSource('ok', [[post('o1', 0), post('o2', 10)]]),
      {
        id: 'broken',
        fetchPage: async () => {
          throw new Error('401');
        },
      },
    ],
    limit: 10,
    onSourceError: (id, e) => errors.push([id, e.message]),
  });

  const seen = [];
  let done = false;
  let guard = 0;
  while (!done && guard++ < 20) {
    const r = await merged.next(seen.length === 0);
    seen.push(...r.value);
    done = r.done;
  }

  assert.deepEqual(
    seen.map((s) => s.id),
    ['o1', 'o2'],
  );
  assert.deepEqual(errors, [['broken', '401']]);
  assert.ok(merged.status().find((s) => s.id === 'broken').failed);
});

test('unsorted input from a source does not corrupt the order', async () => {
  const merged = createMergedTimeline({
    sources: [
      fakeSource('a', [[post('a2', 20), post('a1', 0)]]), // deliberately reversed
      fakeSource('b', [[post('b1', 10)]]),
    ],
    limit: 10,
  });

  const seen = [];
  let done = false;
  let guard = 0;
  while (!done && guard++ < 20) {
    const r = await merged.next(seen.length === 0);
    seen.push(...r.value);
    done = r.done;
  }

  assert.deepEqual(
    seen.map((s) => s.id),
    ['a1', 'b1', 'a2'],
  );
});

test('single source behaves like a plain timeline', async () => {
  const merged = createMergedTimeline({
    sources: [fakeSource('a', [[post('a1', 0), post('a2', 5)], [post('a3', 9)]])],
    limit: 2,
  });

  const seen = [];
  let done = false;
  let guard = 0;
  while (!done && guard++ < 20) {
    const r = await merged.next(seen.length === 0);
    seen.push(...r.value);
    done = r.done;
  }

  assert.deepEqual(
    seen.map((s) => s.id),
    ['a1', 'a2', 'a3'],
  );
});
