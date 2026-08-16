/*
  Thin wrapper over teleproto (the maintained fork of GramJS).

  Everything here is lazy: the MTProto stack is ~577 KB gzipped, and a user who
  only has Mastodon accounts should never download it. Nothing imports
  'teleproto' at module scope — it arrives through a dynamic import the first
  time a Telegram session is actually needed.

  Credentials: api_id/api_hash are the *user's own*, entered in the login form
  and kept in localStorage. They are deliberately not baked into the bundle —
  a shared api_id in a public build is both against Telegram's terms and a
  single point of revocation for everyone using it.

  UNVERIFIED AT AUTHORING TIME: the code below has never opened a socket. The
  environment it was written in cannot reach Telegram's data centres, so the
  request shapes, the login state machine and the media download path are
  reasoned from the library's API, not observed. The pure parts it feeds —
  entity parsing, album collapsing, timeline merging — are covered by tests.
*/

import { createMergedTimeline } from './merge-timelines';
import store from './store';
import { messagesToStatuses } from './telegram-adapter';

const SESSION_KEY = 'telegram:session';
const CREDS_KEY = 'telegram:credentials';
const CHANNELS_PER_PAGE = 12;
const MESSAGES_PER_CHANNEL = 15;

let clientPromise = null;
let libPromise = null;

/*
  Loads the MTProto library once, on demand.

  Do not rewrite this as `Promise.all([...]).then(([a, b]) => ({ ...a, ...b }))`.
  Rolldown cannot see through a spread of a dynamic-import namespace object: it
  decides the result is empty, folds the call to Promise.resolve({}) and drops
  teleproto from the bundle entirely. The build stays green and the failure only
  appears at runtime as "TelegramClient is not a constructor". Naming each
  binding explicitly keeps the reference analysable.
*/
function loadLib() {
  if (!libPromise) {
    libPromise = (async () => {
      const lib = await import('teleproto');
      const sessions = await import('teleproto/sessions');
      return {
        TelegramClient: lib.TelegramClient,
        Api: lib.Api,
        StringSession: sessions.StringSession,
      };
    })();
  }
  return libPromise;
}

export function getStoredCredentials() {
  try {
    const raw = store.local.get(CREDS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function storeCredentials({ apiId, apiHash }) {
  store.local.set(CREDS_KEY, JSON.stringify({ apiId: Number(apiId), apiHash }));
}

export function hasTelegramSession() {
  return !!store.local.get(SESSION_KEY) && !!getStoredCredentials();
}

export function clearTelegramSession() {
  store.local.del(SESSION_KEY);
  clientPromise = null;
  revokeAllMedia();
}

/**
 * Returns a connected client, reusing one across calls.
 * Throws if there is no stored session — call the login flow first.
 */
export async function getTelegramClient() {
  if (clientPromise) return clientPromise;

  const creds = getStoredCredentials();
  const sessionString = store.local.get(SESSION_KEY);
  if (!creds || !sessionString) {
    throw new Error('No Telegram session');
  }

  clientPromise = (async () => {
    const { TelegramClient, StringSession } = await loadLib();
    const client = new TelegramClient(
      new StringSession(sessionString),
      creds.apiId,
      creds.apiHash,
      {
        // Browsers cannot open raw TCP, so the transport has to be WebSocket.
        useWSS: true,
        connectionRetries: 3,
        // Telegram's spam heuristics look at these; leaving them at library
        // defaults is what most third-party clients do.
        appVersion: '1.0.0',
      },
    );
    await client.connect();
    return client;
  })();

  try {
    return await clientPromise;
  } catch (e) {
    clientPromise = null;
    throw e;
  }
}

/**
 * Drives the interactive login. `callbacks` supplies whatever the user types.
 *
 * @param {Object} args
 * @param {number} args.apiId
 * @param {string} args.apiHash
 * @param {string} args.phone
 * @param {Function} args.getCode      () => Promise<string>
 * @param {Function} args.getPassword  () => Promise<string>   (2FA, may be unused)
 * @param {Function} [args.onError]
 */
export async function startTelegramLogin({
  apiId,
  apiHash,
  phone,
  getCode,
  getPassword,
  onError,
}) {
  const { TelegramClient, StringSession } = await loadLib();
  const client = new TelegramClient(
    new StringSession(''),
    Number(apiId),
    apiHash,
    {
      useWSS: true,
      connectionRetries: 3,
      appVersion: '1.0.0',
    },
  );

  await client.start({
    phoneNumber: async () => phone,
    phoneCode: getCode,
    password: getPassword,
    onError: (err) => {
      onError?.(err);
      // Returning false tells the library to stop rather than retry forever.
      return false;
    },
  });

  const sessionString = client.session.save();
  store.local.set(SESSION_KEY, sessionString);
  storeCredentials({ apiId, apiHash });
  clientPromise = Promise.resolve(client);
  return client;
}

/**
 * Broadcast channels the user follows, newest-activity first.
 * Groups and private chats are excluded: this is a reader, not a messenger.
 */
export async function getChannels({ limit = CHANNELS_PER_PAGE } = {}) {
  const client = await getTelegramClient();
  const dialogs = await client.getDialogs({ limit: limit * 4 });
  return dialogs
    .filter((d) => d.isChannel && !d.isGroup)
    .slice(0, limit)
    .map((d) => ({
      id: d.entity?.id?.toString?.() ?? String(d.id),
      username: d.entity?.username || null,
      title: d.title || d.name || 'Channel',
      entity: d.entity,
    }));
}

// ---------------------------------------------------------------------------
// Media
//
// Telegram attachments have no plain HTTP URL: bytes come down over MTProto and
// have to be wrapped in blob: URLs. They are cached by message key and revoked
// on logout, otherwise a long scroll leaks memory steadily.
// ---------------------------------------------------------------------------

const mediaCache = new Map();
const mediaInFlight = new Map();

function mediaKey(channelID, messageID) {
  return `${channelID}:${messageID}`;
}

export function getCachedMedia(channelID, messageID) {
  return mediaCache.get(mediaKey(channelID, messageID)) || null;
}

/** Fires a download and resolves to a blob URL. Safe to call repeatedly. */
export async function resolveMedia(channelID, message) {
  const key = mediaKey(channelID, message.id);
  if (mediaCache.has(key)) return mediaCache.get(key);
  if (mediaInFlight.has(key)) return mediaInFlight.get(key);

  const task = (async () => {
    try {
      const client = await getTelegramClient();
      // thumb: -1 asks for the largest available preview rather than the full
      // original — a feed does not need 4K originals, and full videos would be
      // ruinous over mobile data.
      const bytes = await client.downloadMedia(message, { thumb: -1 });
      if (!bytes) return null;
      const blob = new Blob([bytes]);
      const url = URL.createObjectURL(blob);
      mediaCache.set(key, url);
      return url;
    } catch (e) {
      console.error('Telegram media download failed', key, e);
      return null;
    } finally {
      mediaInFlight.delete(key);
    }
  })();

  mediaInFlight.set(key, task);
  return task;
}

export function revokeAllMedia() {
  for (const url of mediaCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch (e) {}
  }
  mediaCache.clear();
}

// ---------------------------------------------------------------------------
// Timeline source
// ---------------------------------------------------------------------------

/**
 * One paginating source per channel, merged with the same tested merge core
 * used for Mastodon accounts. The result is a single source that can itself be
 * handed to the top-level merge, so Telegram sits alongside each Mastodon
 * account rather than being special-cased.
 */
export async function createTelegramSource({ channelLimit } = {}) {
  const channels = await getChannels({ limit: channelLimit });
  if (!channels.length) return null;

  const perChannel = channels.map((channel) => {
    let offsetId;
    let finished = false;
    return {
      id: `tg:${channel.id}`,
      fetchPage: async (firstLoad) => {
        if (firstLoad) {
          offsetId = undefined;
          finished = false;
        }
        if (finished) return { value: [], done: true };

        const client = await getTelegramClient();
        const messages = await client.getMessages(channel.entity, {
          limit: MESSAGES_PER_CHANNEL,
          ...(offsetId ? { offsetId } : {}),
        });
        if (!messages?.length) {
          finished = true;
          return { value: [], done: true };
        }
        offsetId = messages[messages.length - 1].id;

        const statuses = messagesToStatuses(messages, channel, {
          // Media resolves asynchronously; the attachment starts as _pending
          // and the cached URL is picked up on a later render.
          resolveMedia: (message) => {
            const cached = getCachedMedia(channel.id, message.id);
            if (cached) return cached;
            resolveMedia(channel.id, message);
            return null;
          },
        });
        return {
          value: statuses,
          done: messages.length < MESSAGES_PER_CHANNEL,
        };
      },
    };
  });

  const merger = createMergedTimeline({
    sources: perChannel,
    limit: MESSAGES_PER_CHANNEL,
    // Block body, not a concise one. vite-plugin-remove-console strips
    // console.* calls at build time; a concise arrow whose entire body is a
    // console call gets its body deleted, leaving `(id, e) =>` and a parse
    // error at the end of the file. Same trap applies anywhere in src/.
    onSourceError: (id, e) => {
      console.error('Telegram channel failed', id, e);
    },
  });

  return {
    id: 'telegram',
    label: 'Telegram',
    fetchPage: (firstLoad) => merger.next(firstLoad),
  };
}
