/*
  Turns Telegram channel messages into objects shaped like Mastodon statuses,
  so the existing Phanpy timeline can render them without knowing what they are.

  Deliberately pure: no MTProto types, no network, no DOM. It takes plain
  objects that mirror the shape teleproto hands back. That is what makes it
  testable in Node — see tests/telegram-adapter.test.js — and the entity→HTML
  conversion is precisely the part where off-by-one errors hide.

  What is intentionally lost
  --------------------------
  Reactions, view counts, forward attribution and polls have no Mastodon
  equivalent, so they are dropped rather than faked. Everything produced here
  is read-only; Phanpy's reply/boost/favourite paths are disabled for these
  items by `_readonly`.
*/

/** Telegram sends offsets/lengths in UTF-16 code units, like JS strings. */
const ENTITY_TAGS = {
  MessageEntityBold: ['<strong>', '</strong>'],
  MessageEntityItalic: ['<em>', '</em>'],
  MessageEntityStrike: ['<del>', '</del>'],
  MessageEntityUnderline: ['<u>', '</u>'],
  MessageEntityCode: ['<code>', '</code>'],
  MessageEntityPre: ['<pre><code>', '</code></pre>'],
  MessageEntitySpoiler: ['<span class="spoiler">', '</span>'],
  MessageEntityBlockquote: ['<blockquote>', '</blockquote>'],
};

function escapeHTML(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function entityClassName(entity) {
  // teleproto instances expose className; plain objects in tests use _.
  return entity?.className || entity?._ || '';
}

function openTagFor(entity, channelUsername) {
  const cls = entityClassName(entity);
  const pair = ENTITY_TAGS[cls];
  if (pair) return pair[0];
  if (cls === 'MessageEntityTextUrl') {
    return `<a href="${escapeHTML(entity.url || '')}" rel="nofollow noopener" target="_blank">`;
  }
  if (cls === 'MessageEntityUrl')
    return '<a class="_tg-autolink" rel="nofollow noopener" target="_blank">';
  if (cls === 'MessageEntityMention') return '<a class="mention _tg-mention">';
  if (cls === 'MessageEntityHashtag')
    return '<a class="mention hashtag _tg-hashtag">';
  return '';
}

function closeTagFor(entity) {
  const cls = entityClassName(entity);
  const pair = ENTITY_TAGS[cls];
  if (pair) return pair[1];
  if (
    cls === 'MessageEntityTextUrl' ||
    cls === 'MessageEntityUrl' ||
    cls === 'MessageEntityMention' ||
    cls === 'MessageEntityHashtag'
  ) {
    return '</a>';
  }
  return '';
}

/**
 * Applies Telegram entities to raw text, producing HTML.
 *
 * Entities may nest and may share boundaries. Rather than splicing strings —
 * which shifts every later offset — tags are collected per character index and
 * emitted while walking the text once. Closing tags at a given index are
 * emitted before opening ones so that nesting stays balanced.
 */
export function entitiesToHTML(text = '', entities = []) {
  if (!text) return '';
  const chars = Array.from(text);
  // Telegram counts UTF-16 units; Array.from splits by code point. Build a
  // map from UTF-16 offset to code-point index so emoji don't shift things.
  const offsetToIndex = new Map();
  let utf16 = 0;
  chars.forEach((ch, i) => {
    offsetToIndex.set(utf16, i);
    utf16 += ch.length;
  });
  offsetToIndex.set(utf16, chars.length);

  const opens = new Map();
  const closes = new Map();

  const sorted = [...(entities || [])]
    .filter((e) => Number.isInteger(e?.offset) && Number.isInteger(e?.length))
    .sort((a, b) => a.offset - b.offset || b.length - a.length);

  for (const entity of sorted) {
    const start = offsetToIndex.get(entity.offset);
    const end = offsetToIndex.get(entity.offset + entity.length);
    if (start === undefined || end === undefined) continue;
    const open = openTagFor(entity, null);
    const close = closeTagFor(entity);
    if (!open) continue;
    if (!opens.has(start)) opens.set(start, []);
    if (!closes.has(end)) closes.set(end, []);
    opens.get(start).push(open);
    // Later-opened entities must close first.
    closes.get(end).unshift(close);
  }

  let out = '';
  for (let i = 0; i <= chars.length; i++) {
    if (closes.has(i)) out += closes.get(i).join('');
    if (opens.has(i)) out += opens.get(i).join('');
    if (i < chars.length) out += escapeHTML(chars[i]);
  }

  // Telegram text uses bare newlines; Mastodon content is block HTML.
  return out
    .split('\n\n')
    .map((para) => `<p>${para.split('\n').join('<br />')}</p>`)
    .join('');
}

function channelToAccount(channel, instanceHost) {
  const username = channel?.username || null;
  const id = String(channel?.id ?? 'unknown');
  return {
    id: `tg:${id}`,
    username: username || id,
    acct: username ? `${username}@telegram` : `${id}@telegram`,
    displayName: channel?.title || username || 'Telegram',
    url: username ? `https://t.me/${username}` : `https://t.me/c/${id}`,
    avatar: channel?._avatarURL || '',
    avatarStatic: channel?._avatarURL || '',
    bot: false,
    locked: !username,
    emojis: [],
    createdAt: new Date(0).toISOString(),
    note: '',
    _telegram: true,
  };
}

const PHOTO_CLASSES = new Set(['MessageMediaPhoto', 'Photo']);

/**
 * Maps Telegram media onto Mastodon-ish attachments.
 * `resolveMedia` is injected so this module stays free of the download layer;
 * it receives the message and returns a URL (usually a blob: URL) or null.
 */
function mediaToAttachments(message, resolveMedia) {
  const media = message?.media;
  if (!media) return [];
  const cls = entityClassName(media);
  let type = 'unknown';
  if (PHOTO_CLASSES.has(cls)) type = 'image';
  else if (cls === 'MessageMediaDocument') {
    const mime = media.document?.mimeType || '';
    if (mime.startsWith('video/')) type = 'video';
    else if (mime.startsWith('audio/')) type = 'audio';
    else if (mime.startsWith('image/')) type = 'image';
  } else if (cls === 'MessageMediaWebPage') {
    return []; // link previews are not attachments
  }

  const url = resolveMedia ? resolveMedia(message) : null;
  return [
    {
      id: `tg:${message.id}:0`,
      type,
      url: url || null,
      previewUrl: url || null,
      remoteUrl: null,
      description: null,
      blurhash: null,
      meta: {},
      _pending: !url,
    },
  ];
}

/**
 * @param {Object} message  teleproto message (or a plain object of same shape)
 * @param {Object} channel  the channel it belongs to
 * @param {Object} [opts]
 * @param {Function} [opts.resolveMedia] (message) => url | null
 * @returns {Object|null} status-shaped object, or null if unrenderable
 */
export function messageToStatus(message, channel, opts = {}) {
  if (!message || message.id == null) return null;
  // Service messages (joins, pins, title changes) carry no content.
  if (entityClassName(message) === 'MessageService') return null;

  const text = message.message || '';
  const hasMedia = !!message.media;
  if (!text && !hasMedia) return null;

  const account = channelToAccount(channel);
  const dateSeconds =
    typeof message.date === 'number'
      ? message.date
      : Math.floor(new Date(message.date || 0).getTime() / 1000);
  const createdAt = new Date(dateSeconds * 1000).toISOString();
  const username = channel?.username;
  const url = username
    ? `https://t.me/${username}/${message.id}`
    : `https://t.me/c/${channel?.id}/${message.id}`;

  return {
    id: `tg:${channel?.id}:${message.id}`,
    uri: url,
    url,
    createdAt,
    editedAt: message.editDate
      ? new Date(message.editDate * 1000).toISOString()
      : null,
    account,
    content: entitiesToHTML(text, message.entities),
    text,
    spoilerText: '',
    visibility: 'public',
    sensitive: false,
    language: null,
    mediaAttachments: mediaToAttachments(message, opts.resolveMedia),
    mentions: [],
    tags: [],
    emojis: [],
    reblog: null,
    reblogsCount: message.forwards || 0,
    favouritesCount: 0,
    repliesCount: message.replies?.replies || 0,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    pinned: !!message.pinned,
    poll: null,
    card: null,
    application: null,
    inReplyToId: null,
    inReplyToAccountId: null,
    // Markers the UI uses to keep read-only items out of interactive paths.
    _telegram: true,
    _readonly: true,
    _instance: 'telegram',
    _accountLabel: channel?.title || 'Telegram',
  };
}

/**
 * Convenience for a page of messages from one channel.
 * Albums (several messages sharing a groupedId) collapse into the first
 * message of the group so a 10-photo post is not 10 timeline entries.
 */
export function messagesToStatuses(messages = [], channel, opts = {}) {
  const seenGroups = new Set();
  const out = [];
  for (const message of messages) {
    const group = message?.groupedId;
    if (group != null) {
      const key = String(group);
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
    }
    const status = messageToStatus(message, channel, opts);
    if (status) out.push(status);
  }
  return out;
}
