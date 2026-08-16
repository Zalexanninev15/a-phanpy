/*
  Run with:  node --test tests/telegram-adapter.test.js
*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  entitiesToHTML,
  messageToStatus,
  messagesToStatuses,
} from '../src/utils/telegram-adapter.js';

const channel = { id: 123, username: 'somechannel', title: 'Some Channel' };
const e = (_, offset, length, extra = {}) => ({ _, offset, length, ...extra });

test('plain text becomes a paragraph and is escaped', () => {
  assert.equal(entitiesToHTML('a < b & c'), '<p>a &lt; b &amp; c</p>');
});

test('single newline is a break, blank line splits paragraphs', () => {
  assert.equal(entitiesToHTML('one\ntwo'), '<p>one<br />two</p>');
  assert.equal(entitiesToHTML('one\n\ntwo'), '<p>one</p><p>two</p>');
});

test('bold entity wraps exactly the right characters', () => {
  assert.equal(
    entitiesToHTML('hello world', [e('MessageEntityBold', 6, 5)]),
    '<p>hello <strong>world</strong></p>',
  );
});

test('nested entities close in the right order', () => {
  // "bold italic" where italic sits inside bold
  const html = entitiesToHTML('abcdef', [
    e('MessageEntityBold', 0, 6),
    e('MessageEntityItalic', 2, 2),
  ]);
  assert.equal(html, '<p><strong>ab<em>cd</em>ef</strong></p>');
});

test('emoji before an entity does not shift the offset', () => {
  // 👍 is one code point but two UTF-16 units, which is how Telegram counts.
  const text = '👍 bold';
  const html = entitiesToHTML(text, [e('MessageEntityBold', 3, 4)]);
  assert.equal(html, '<p>👍 <strong>bold</strong></p>');
});

test('text_url entity produces an escaped href', () => {
  const html = entitiesToHTML('click here', [
    e('MessageEntityTextUrl', 6, 4, { url: 'https://x.test/?a=1&b=2' }),
  ]);
  assert.equal(
    html,
    '<p>click <a href="https://x.test/?a=1&amp;b=2" rel="nofollow noopener" target="_blank">here</a></p>',
  );
});

test('unknown entity types are ignored, not rendered as junk', () => {
  assert.equal(
    entitiesToHTML('abc', [e('MessageEntitySomethingNew', 0, 3)]),
    '<p>abc</p>',
  );
});

test('out-of-range entity offsets are skipped rather than throwing', () => {
  assert.equal(entitiesToHTML('abc', [e('MessageEntityBold', 10, 5)]), '<p>abc</p>');
});

test('message maps onto a status with a sortable createdAt', () => {
  const status = messageToStatus(
    { id: 7, message: 'hi', date: 1700000000, entities: [] },
    channel,
  );
  assert.equal(status.id, 'tg:123:7');
  assert.equal(status.url, 'https://t.me/somechannel/7');
  assert.equal(status.content, '<p>hi</p>');
  assert.equal(status.account.acct, 'somechannel@telegram');
  assert.equal(status.createdAt, new Date(1700000000 * 1000).toISOString());
  assert.equal(status._readonly, true);
  // The merge core sorts on this; if it were missing everything would sink.
  assert.ok(!Number.isNaN(Date.parse(status.createdAt)));
});

test('service messages and empty messages are dropped', () => {
  assert.equal(messageToStatus({ _: 'MessageService', id: 1, date: 1 }, channel), null);
  assert.equal(messageToStatus({ id: 2, message: '', date: 1 }, channel), null);
});

test('a media-only message still becomes a status', () => {
  const status = messageToStatus(
    { id: 9, message: '', date: 1700000000, media: { _: 'MessageMediaPhoto' } },
    channel,
    { resolveMedia: () => 'blob:fake' },
  );
  assert.equal(status.mediaAttachments.length, 1);
  assert.equal(status.mediaAttachments[0].type, 'image');
  assert.equal(status.mediaAttachments[0].url, 'blob:fake');
});

test('unresolved media is marked pending rather than given a broken url', () => {
  const status = messageToStatus(
    { id: 9, message: 'x', date: 1, media: { _: 'MessageMediaPhoto' } },
    channel,
  );
  assert.equal(status.mediaAttachments[0]._pending, true);
  assert.equal(status.mediaAttachments[0].url, null);
});

test('video documents are typed as video', () => {
  const status = messageToStatus(
    {
      id: 10,
      message: '',
      date: 1,
      media: { _: 'MessageMediaDocument', document: { mimeType: 'video/mp4' } },
    },
    channel,
    { resolveMedia: () => 'blob:v' },
  );
  assert.equal(status.mediaAttachments[0].type, 'video');
});

test('an album collapses to one status', () => {
  const messages = [
    { id: 1, message: 'caption', date: 3, groupedId: 555, media: { _: 'MessageMediaPhoto' } },
    { id: 2, message: '', date: 3, groupedId: 555, media: { _: 'MessageMediaPhoto' } },
    { id: 3, message: '', date: 3, groupedId: 555, media: { _: 'MessageMediaPhoto' } },
    { id: 4, message: 'separate', date: 2 },
  ];
  const out = messagesToStatuses(messages, channel);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'tg:123:1');
  assert.equal(out[1].id, 'tg:123:4');
});

test('private channel without username still gets a usable url', () => {
  const status = messageToStatus(
    { id: 5, message: 'x', date: 1 },
    { id: 999, title: 'Private' },
  );
  assert.equal(status.url, 'https://t.me/c/999/5');
  assert.equal(status.account.acct, '999@telegram');
});
