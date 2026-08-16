import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo, useRef, useState } from 'preact/hooks';
import { useSnapshot } from 'valtio';

import Timeline from '../components/timeline';
import { api } from '../utils/api';
import { createMergedTimeline } from '../utils/merge-timelines';
import states, { saveStatus } from '../utils/states';
import { getAccounts } from '../utils/store-utils';
import {
  createTelegramSource,
  hasTelegramSession,
} from '../utils/telegram-client';
import { dedupeBoosts } from '../utils/timeline-utils';
import useTitle from '../utils/useTitle';

const LIMIT = 20;

/*
  One timeline fed by every logged-in account at once.

  Each status carries the instance it came from on `_instance`. Timeline and
  Status prefer that over the timeline-wide `instance` prop, and api({instance})
  already resolves an instance back to its stored account — so replying,
  boosting and favouriting act as the account that actually sees the post,
  without any extra plumbing.

  Known limit: two accounts on the *same* instance cannot be told apart this
  way, because api() resolves by instance. Their posts merge correctly but
  actions run as whichever of the two is stored first.
*/
function Merged({ title, path, id, ...props }) {
  const { t } = useLingui();
  useTitle(
    title || t({ id: 'merged.title', message: 'All accounts' }),
    path || '/merged',
  );
  const snapStates = useSnapshot(states);
  const accounts = useMemo(() => getAccounts(), []);
  const [failures, setFailures] = useState([]);

  // The current account still decides the fallback instance, which Timeline
  // uses for anything not tied to a specific status.
  const { instance: currentInstance } = api();

  const merger = useRef();
  const latestKey = useRef();

  function buildSources() {
    setFailures([]);
    return accounts.map((account) => {
      const { masto, instance } = api({ account });
      let iterator;
      return {
        id: `${account.info.id}@${account.instanceURL}`,
        label: `@${account.info.acct}`,
        fetchPage: async (firstLoad) => {
          if (firstLoad || !iterator) {
            iterator = masto.v1.timelines.home
              .list({ limit: LIMIT })
              .values();
          }
          const { value, done } = await iterator.next();
          if (!value?.length) return { value: [], done: true };

          value.forEach((item) => saveStatus(item, instance));
          const deduped = dedupeBoosts(value, instance);
          // Tag each status so the renderer knows which account owns it.
          deduped.forEach((item) => {
            item._instance = instance;
            item._accountLabel = `@${account.info.acct}`;
          });
          return { value: deduped, done };
        },
      };
    });
  }

  async function fetchMerged(firstLoad) {
    if (firstLoad || !merger.current) {
      const sources = buildSources();
      // Telegram joins as one more source. It fails soft: a broken or expired
      // session must not take the Mastodon timelines down with it.
      if (hasTelegramSession()) {
        try {
          const telegram = await createTelegramSource();
          if (telegram) sources.push(telegram);
        } catch (e) {
          console.error('Telegram source unavailable', e);
          setFailures((prev) =>
            prev.includes('telegram') ? prev : [...prev, 'telegram'],
          );
        }
      }
      merger.current = createMergedTimeline({
        sources,
        limit: LIMIT,
        onSourceError: (sourceID, error) => {
          console.error('Merged timeline source failed', sourceID, error);
          setFailures((prev) =>
            prev.includes(sourceID) ? prev : [...prev, sourceID],
          );
        },
      });
    }
    const { value, done } = await merger.current.next(firstLoad);
    if (firstLoad && value?.length) {
      latestKey.current = `${value[0]._instance}:${value[0].id}`;
    }
    return { value, done };
  }

  async function checkForUpdates() {
    if (!latestKey.current) return false;
    try {
      const heads = await Promise.all(
        accounts.map(async (account) => {
          const { masto, instance } = api({ account });
          const { value } = await masto.v1.timelines.home
            .list({ limit: 1 })
            .values()
            .next();
          const top = value?.[0];
          return top ? `${instance}:${top.id}` : null;
        }),
      );
      return heads.some((key) => key && key !== latestKey.current);
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  if (!accounts.length) return null;

  return (
    <Timeline
      title={title || t({ id: 'merged.title', message: 'All accounts' })}
      id={id || 'merged'}
      emptyText={t`Nothing to see here.`}
      errorText={t`Unable to load posts.`}
      instance={currentInstance}
      fetchItems={fetchMerged}
      checkForUpdates={checkForUpdates}
      boostsCarousel={snapStates.settings.boostsCarousel}
      timelineStart={
        failures.length ? (
          <div class="timeline-deleted">
            <Trans>Some accounts failed to load. Pull to refresh.</Trans>
          </div>
        ) : null
      }
      {...props}
      filterContext="home"
      showFollowedTags
      showReplyParent
    />
  );
}

export default Merged;
