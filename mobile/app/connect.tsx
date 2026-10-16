import { FormButton } from '../src/ui/form-button';
import { useEffect, useRef, useState } from 'react';
import { FieldGroup, Host, Text, TextInput } from '@expo/ui';
import {
  accessibilityLabel,
  font,
  foregroundStyle,
  textSelection,
} from '@expo/ui/swift-ui/modifiers';
import { PlatformColor } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DeviceLogin, canonicalizeInstanceUrl } from '../src/core';
import { createNativeClient, openLoginBrowser } from '../src/core/native';
import {
  allowDevelopmentLoopback,
  useSession,
  vault,
} from '../src/state/session';
import { errorText, styles, usePalette } from '../src/ui/primitives';
import { useFieldState } from '../src/ui/use-field-state';

type Approval = {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
};
export default function ConnectScreen() {
  const { connect, origins, authError } = useSession();
  const c = usePalette();
  const [url, setUrl] = useState(origins[0] ?? '');
  const urlField = useFieldState(url, setUrl);
  const [pending, setPending] = useState(false);
  const [code, setCode] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(authError);
  const login = useRef<DeviceLogin | null>(null);
  const attemptController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  const activating = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (!activating.current) {
        login.current?.cancel();
        attemptController.current?.abort();
      }
    };
  }, []);

  const begin = async () => {
    if (pending) return;
    activating.current = false;
    const attempt = ++generation.current;
    const controller = new AbortController();
    attemptController.current = controller;
    setError(null);
    setPending(true);
    setCode(null);
    try {
      const origin = canonicalizeInstanceUrl(url, { allowDevelopmentLoopback });
      setUrl(origin);
      const client = createNativeClient({
        origin,
        vault,
        allowDevelopmentLoopback,
      });
      const flow = new DeviceLogin(client);
      login.current = flow;
      await flow.start({
        signal: controller.signal,
        onCode: (approval) => {
          if (alive.current && attempt === generation.current)
            setCode(approval);
        },
        openBrowser: openLoginBrowser,
        validateSession: async (signal) => {
          await client.config(signal);
          if (
            !alive.current ||
            attempt !== generation.current ||
            signal.aborted
          )
            throw new Error('Sign-in cancelled.');
          // Successful activation remounts navigation. That unmount must not
          // cancel a completed login; an explicit Cancel still aborts it.
          activating.current = true;
          await connect(origin, signal);
        },
      });
    } catch (failure) {
      activating.current = false;
      if (alive.current && attempt === generation.current)
        setError(errorText(failure));
    } finally {
      if (alive.current && attempt === generation.current) {
        setPending(false);
        setCode(null);
      }
    }
  };
  const cancel = () => {
    activating.current = false;
    generation.current++;
    attemptController.current?.abort();
    login.current?.cancel();
    setPending(false);
    setCode(null);
    setError(null);
  };
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]}>
      <Host style={styles.screen}>
        <FieldGroup>
          <FieldGroup.Section title="Connect to Hatch">
            <Text modifiers={[font({ textStyle: 'title2', weight: 'bold' })]}>
              Your Hatch. In your pocket.
            </Text>
            <Text>
              Open your apps, talk with your Agent, and pick up where you left
              off.
            </Text>
          </FieldGroup.Section>
          <FieldGroup.Section title="Instance URL">
            <TextInput
              {...urlField}
              editable={!pending}
              placeholder="https://hatch.example.com"
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="url"
              returnKeyType="go"
              onSubmitEditing={() => void begin()}
              modifiers={[accessibilityLabel('Hatch instance URL')]}
            />
            {!pending ? (
              <FormButton
                label="Continue in browser"

                unavailable={!url.trim()}
                onPress={() => void begin()}
              />
            ) : null}
            <FieldGroup.SectionFooter>
              <Text>
                Use your HTTPS Hatch address. Sign-in opens this instance in
                your system browser. Approving grants this phone full account
                access.
              </Text>
            </FieldGroup.SectionFooter>
          </FieldGroup.Section>
          {code ? (
            <FieldGroup.Section title="Check this code in your browser">
              <Text
                modifiers={[
                  font({
                    textStyle: 'title',
                    design: 'monospaced',
                    weight: 'bold',
                  }),
                  textSelection(true),
                ]}
              >
                {code.userCode}
              </Text>
              <FormButton
                label="Reopen approval page"

                onPress={() =>
                  void openLoginBrowser(code.verificationUrl).catch(
                    (failure: unknown) => setError(errorText(failure)),
                  )
                }
              />
              <FieldGroup.SectionFooter>
                <Text>
                  Approve only the request you just started. Return here after
                  approval; your session will connect automatically.
                </Text>
              </FieldGroup.SectionFooter>
            </FieldGroup.Section>
          ) : null}
          {pending ? (
            <FieldGroup.Section>
              <FormButton label="Cancel sign-in" onPress={cancel} />
            </FieldGroup.Section>
          ) : null}
          {error ? (
            <FieldGroup.Section title="Couldn’t connect">
              <Text modifiers={[foregroundStyle(PlatformColor('systemRed'))]}>
                {error}
              </Text>
            </FieldGroup.Section>
          ) : null}
          {!pending && origins.length ? (
            <FieldGroup.Section title="Recent instances">
              {origins.map((item) => (
                <FormButton
                  key={item}
                  label={item.replace(/^https?:\/\//, '')}

                  onPress={() => setUrl(item)}
                />
              ))}
            </FieldGroup.Section>
          ) : null}
        </FieldGroup>
      </Host>
    </SafeAreaView>
  );
}
