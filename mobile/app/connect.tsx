import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { NativeField, type NativeFieldRef } from '../src/ui/native-field';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DeviceLogin, canonicalizeInstanceUrl } from '../src/core';
import { createNativeClient, openLoginBrowser } from '../src/core/native';
import {
  allowDevelopmentLoopback,
  useSession,
  vault,
} from '../src/state/session';
import {
  Action,
  Brand,
  Card,
  PageHeading,
  Text,
  errorText,
  styles,
  usePalette,
} from '../src/ui/primitives';

type Approval = {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
};
export default function ConnectScreen() {
  const { connect, origins, authError } = useSession();
  const c = usePalette();
  const [url, setUrl] = useState(origins[0] ?? '');
  const urlField = useRef<NativeFieldRef>(null);
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
      const origin = canonicalizeInstanceUrl(
        urlField.current?.getText() ?? url,
        {
          allowDevelopmentLoopback,
        },
      );
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
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: 48, gap: 24 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <Brand />
          <PageHeading
            title="Welcome to Hatch"
            detail="Your apps and ideas, wherever you are."
          />
          <View style={{ gap: 12, paddingVertical: 8 }}>
            <Text style={[styles.label, { color: c.muted }]}>
              Instance address
            </Text>
            <NativeField
              ref={urlField}
              label="Hatch instance URL"
              value={url}
              onChange={setUrl}
              unavailable={pending}
              placeholder="https://hatch.example.com"
              keyboardType="url"
              onSubmitEditing={() => void begin()}
            />
            <Text style={[styles.caption, { color: c.muted }]}>
              Enter your Hatch address. You’ll sign in securely in your browser
              and grant this phone access to your instance.
            </Text>
            {!pending ? (
              <Action
                fullWidth
                label="Connect to Hatch"
                disabled={!url.trim()}
                onPress={() => void begin()}
              />
            ) : null}
          </View>
          {code ? (
            <Card>
              <Text
                accessibilityRole="header"
                style={[styles.heading, { color: c.text }]}
              >
                Check this code in your browser
              </Text>
              <Text
                selectable
                style={{
                  color: c.text,
                  fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                  fontSize: 28,
                  fontWeight: '600',
                }}
              >
                {code.userCode}
              </Text>
              <Text style={[styles.body, { color: c.muted }]}>
                Approve only the request you just started. Return here after
                approval; your session will connect automatically.
              </Text>
              <Action
                fullWidth
                label="Reopen approval page"
                secondary
                onPress={() =>
                  void openLoginBrowser(code.verificationUrl).catch(
                    (failure: unknown) => setError(errorText(failure)),
                  )
                }
              />
            </Card>
          ) : null}
          {pending ? (
            <Action
              fullWidth
              label="Cancel sign-in"
              secondary
              onPress={cancel}
            />
          ) : null}
          {error ? (
            <View style={{ gap: 8 }}>
              <Text
                accessibilityRole="header"
                style={[styles.heading, { color: c.text }]}
              >
                Couldn’t connect
              </Text>
              <Text
                accessibilityRole="alert"
                style={[styles.body, { color: c.danger }]}
              >
                {error}
              </Text>
            </View>
          ) : null}
          {!pending && origins.length ? (
            <View style={{ gap: 8 }}>
              <Text style={[styles.label, { color: c.muted }]}>
                Recent instances
              </Text>
              {origins.map((item) => (
                <Action
                  fullWidth
                  key={item}
                  label={item.replace(/^https?:\/\//, '')}
                  secondary
                  onPress={() => setUrl(item)}
                />
              ))}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
