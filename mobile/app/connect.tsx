import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
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
  Card,
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
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: 46 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View
            style={{
              width: 68,
              height: 68,
              borderRadius: 23,
              backgroundColor: c.accent,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 8,
            }}
          >
            <Text
              style={{ fontSize: 39, color: c.background, fontWeight: '700' }}
            >
              h
            </Text>
          </View>
          <Text
            accessibilityRole="header"
            style={{
              fontSize: 37,
              letterSpacing: -1.5,
              color: c.text,
              fontWeight: '700',
            }}
          >
            {'Your Hatch.\nIn your pocket.'}
          </Text>
          <Text style={[styles.body, { color: c.muted }]}>
            Open your apps, talk with your Agent, and pick up where you left
            off.
          </Text>
          <Card>
            <Text style={[styles.label, { color: c.muted }]}>INSTANCE URL</Text>
            <TextInput
              accessibilityLabel="Hatch instance URL"
              value={url}
              onChangeText={setUrl}
              editable={!pending}
              placeholder="https://hatch.example.com"
              placeholderTextColor={c.muted}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="URL"
              returnKeyType="go"
              onSubmitEditing={() => void begin()}
              style={[styles.input, { color: c.text, borderColor: c.border }]}
            />
            <Text style={[styles.caption, { color: c.muted }]}>
              Use your HTTPS Hatch address. Sign-in opens this instance in your
              system browser. Approving grants this phone full account access.
            </Text>
            {!pending ? (
              <Action
                label="Continue in browser"
                disabled={!url.trim()}
                onPress={() => void begin()}
              />
            ) : null}
          </Card>
          {code ? (
            <Card>
              <Text style={[styles.label, { color: c.muted }]}>
                CHECK THIS CODE IN YOUR BROWSER
              </Text>
              <Text
                selectable
                style={{
                  fontSize: 34,
                  letterSpacing: 4,
                  fontWeight: '700',
                  color: c.text,
                }}
              >
                {code.userCode}
              </Text>
              <Text style={[styles.body, { color: c.muted }]}>
                Approve only the request you just started. Return here after
                approval; your session will connect automatically.
              </Text>
              <Action
                secondary
                label="Reopen approval page"
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
              secondary
              label={code ? 'Cancel sign-in' : 'Cancel connection'}
              onPress={cancel}
            />
          ) : null}
          {error ? (
            <Text
              accessibilityRole="alert"
              style={[styles.body, { color: c.danger }]}
            >
              {error}
            </Text>
          ) : null}
          {!pending && origins.length > 0 ? (
            <View style={{ gap: 10 }}>
              <Text style={[styles.label, { color: c.muted }]}>
                RECENT INSTANCES
              </Text>
              {origins.map((item) => (
                <Action
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
