import { Trans, useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'preact/hooks';
import { useNavigate } from 'react-router-dom';

import Icon from '../components/icon';
import Link from '../components/link';
import Loader from '../components/loader';
import store from '../utils/store';
import {
  clearTelegramSession,
  getStoredCredentials,
  hasTelegramSession,
  startTelegramLogin,
} from '../utils/telegram-client';
import useTitle from '../utils/useTitle';

/*
  The login is a state machine driven by callbacks the MTProto library invokes:
  it asks for the code, and later possibly the 2FA password, from inside
  client.start(). Those callbacks are wired to deferred promises that resolve
  when the user submits the corresponding form.
*/
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function TelegramLogin() {
  const { t } = useLingui();
  useTitle(
    t({ id: 'telegram.login.title', message: 'Telegram' }),
    '/telegram/login',
  );
  const navigate = useNavigate();

  const stored = getStoredCredentials();
  const [apiId, setApiId] = useState(stored?.apiId ? String(stored.apiId) : '');
  const [apiHash, setApiHash] = useState(stored?.apiHash || '');
  const [phone, setPhone] = useState('');
  const [step, setStep] = useState(
    hasTelegramSession() ? 'done' : 'credentials',
  );
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const codeDeferred = useRef(null);
  const passwordDeferred = useRef(null);
  const [codeValue, setCodeValue] = useState('');
  const [passwordValue, setPasswordValue] = useState('');

  async function begin() {
    setError(null);
    setBusy(true);
    try {
      await startTelegramLogin({
        apiId,
        apiHash,
        phone,
        getCode: async () => {
          codeDeferred.current = deferred();
          setStep('code');
          setBusy(false);
          const code = await codeDeferred.current.promise;
          setBusy(true);
          return code;
        },
        getPassword: async () => {
          passwordDeferred.current = deferred();
          setStep('password');
          setBusy(false);
          const password = await passwordDeferred.current.promise;
          setBusy(true);
          return password;
        },
        onError: (e) => setError(e?.message || String(e)),
      });
      setStep('done');
      // Mirrors the Mastodon OAuth callback in app.jsx: if something sent the
      // user here to authenticate before continuing (TelegramOrAuthRoute),
      // send them back. Otherwise land on the merged timeline — /telegram/login
      // itself has nothing further to show once connected.
      const redirectPath = store.session.get('loginRedirect');
      store.session.del('loginRedirect');
      navigate(redirectPath || '/merged', { replace: true });
    } catch (e) {
      setError(e?.message || String(e));
      setStep('credentials');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="telegram-login-page" class="deck-container">
      <div class="deck">
        <header>
          <div class="header-grid">
            <div class="header-side">
              <Link to="/" class="button plain">
                <Icon icon="home" size="l" />
              </Link>
            </div>
            <h1>Telegram</h1>
          </div>
        </header>
        <main tabIndex="-1">
          <div class="timeline-start">
            {step === 'done' ? (
              <>
                <p>
                  <Trans>
                    Telegram is connected. Channels appear in the merged
                    timeline.
                  </Trans>
                </p>
                <p>
                  <button
                    type="button"
                    class="light danger"
                    onClick={() => {
                      clearTelegramSession();
                      setStep('credentials');
                    }}
                  >
                    <Trans>Disconnect Telegram</Trans>
                  </button>
                </p>
              </>
            ) : (
              <>
                <p>
                  <Trans>
                    Telegram requires your own API credentials. Create an
                    application at my.telegram.org under "API development tools"
                    and paste the values here. They are stored on this device
                    only.
                  </Trans>
                </p>
                <p class="insignificant">
                  <Trans>
                    Signing in to a third-party client is something Telegram
                    sometimes treats as suspicious. There is a real chance of
                    your account being limited or banned.
                  </Trans>
                </p>
              </>
            )}

            {step === 'credentials' && (
              <div class="telegram-login-form">
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="api_id"
                  value={apiId}
                  disabled={busy}
                  onInput={(e) => setApiId(e.currentTarget.value)}
                />
                <input
                  type="text"
                  placeholder="api_hash"
                  value={apiHash}
                  disabled={busy}
                  onInput={(e) => setApiHash(e.currentTarget.value)}
                />
                <input
                  type="tel"
                  placeholder="+1234567890"
                  value={phone}
                  disabled={busy}
                  onInput={(e) => setPhone(e.currentTarget.value)}
                />
                <button
                  type="button"
                  class="large"
                  disabled={busy || !apiId || !apiHash || !phone}
                  onClick={begin}
                >
                  <Trans>Send code</Trans> {busy && <Loader abrupt />}
                </button>
              </div>
            )}

            {step === 'code' && (
              <div class="telegram-login-form">
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder={t`Code from Telegram`}
                  value={codeValue}
                  onInput={(e) => setCodeValue(e.currentTarget.value)}
                />
                <button
                  type="button"
                  class="large"
                  disabled={!codeValue}
                  onClick={() => codeDeferred.current?.resolve(codeValue)}
                >
                  <Trans>Confirm</Trans>
                </button>
              </div>
            )}

            {step === 'password' && (
              <div class="telegram-login-form">
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder={t`Two-step verification password`}
                  value={passwordValue}
                  onInput={(e) => setPasswordValue(e.currentTarget.value)}
                />
                <button
                  type="button"
                  class="large"
                  disabled={!passwordValue}
                  onClick={() =>
                    passwordDeferred.current?.resolve(passwordValue)
                  }
                >
                  <Trans>Confirm</Trans>
                </button>
              </div>
            )}

            {error && (
              <p class="error">
                <Icon icon="alert" /> {error}
              </p>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default TelegramLogin;
