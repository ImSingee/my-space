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
import { Button } from '../src/ui/button';
import {
  Busy,
  Card,
  Highlight,
  Wordmark,
  errorText,
} from '../src/ui/primitives';
import { GlyphTile, Group, ListRow } from '../src/ui/rows';
import { SectionLabel } from '../src/ui/screen';
import { Text, type } from '../src/ui/text';
import { fonts, palette as c } from '../src/ui/theme';

type Approval = {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
};
export default function ConnectScreen() {
  const { connect, origins, authError } = useSession();
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
  const step = code ? 2 : pending ? 2 : 1;
  const steps = [
    'Enter your Hatch address',
    'Approve this phone in your browser',
    'Come back — you’re in',
  ];
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.paper }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 22,
            paddingTop: 28,
            paddingBottom: 48,
            gap: 22,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <Wordmark size={34} />
          <View style={{ gap: 10 }}>
            <Text accessibilityRole="header" style={type.display}>
              Your own software, in your pocket.
            </Text>
            <Text style={type.callout}>
              Hatch runs on your server. Point this phone at it and approve the
              sign-in from your browser.
            </Text>
          </View>
          <View style={{ gap: 8 }}>
            {steps.map((label, index) => {
              const active = index + 1 === step;
              return (
                <View
                  key={label}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <Text
                    style={[
                      type.meta,
                      { color: active ? c.ink : c.inkFaint, minWidth: 22 },
                    ]}
                  >
                    {String(index + 1).padStart(2, '0')}
                  </Text>
                  <Highlight active={active}>
                    <Text
                      style={[
                        type.callout,
                        {
                          color: active ? c.ink : c.inkSoft,
                          fontWeight: active ? '600' : '400',
                        },
                      ]}
                    >
                      {label}
                    </Text>
                  </Highlight>
                </View>
              );
            })}
          </View>
          <View style={{ gap: 10 }}>
            <Text style={type.meta}>Instance address</Text>
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
            {!pending ? (
              <Button
                size="large"
                fullWidth
                label="Connect"
                disabled={!url.trim()}
                onPress={() => void begin()}
              />
            ) : null}
          </View>
          {code ? (
            <Card style={{ backgroundColor: c.ink, gap: 14 }}>
              <Text style={[type.meta, { color: c.lime }]}>Approval code</Text>
              <Text
                selectable
                accessibilityLabel={`Approval code ${code.userCode.split('').join(' ')}`}
                style={{
                  color: c.card,
                  fontFamily: fonts.mono,
                  fontSize: 34,
                  lineHeight: 42,
                  fontWeight: '600',
                  letterSpacing: 4,
                }}
              >
                {code.userCode}
              </Text>
              <Text style={[type.small, { color: c.card, opacity: 0.86 }]}>
                Check that your browser shows this same code. Approve only the
                request you just started; this screen continues on its own.
              </Text>
              <Button
                fullWidth
                variant="secondary"
                glyph="browser"
                label="Reopen approval page"
                onPress={() =>
                  void openLoginBrowser(code.verificationUrl).catch(
                    (failure: unknown) => setError(errorText(failure)),
                  )
                }
              />
            </Card>
          ) : pending ? (
            <Busy label="Starting secure sign-in" />
          ) : null}
          {pending ? (
            <Button
              fullWidth
              variant="secondary"
              label="Cancel sign-in"
              onPress={cancel}
            />
          ) : null}
          {error ? (
            <Card style={{ backgroundColor: c.dangerSoft, gap: 6 }}>
              <Text accessibilityRole="header" style={type.heading}>
                Couldn’t connect
              </Text>
              <Text
                accessibilityRole="alert"
                style={[type.callout, { color: c.danger }]}
              >
                {error}
              </Text>
            </Card>
          ) : null}
          {!pending && origins.length ? (
            <View>
              <SectionLabel count={origins.length}>Recent</SectionLabel>
              <Group>
                {origins.map((item) => (
                  <ListRow
                    key={item}
                    title={item.replace(/^https?:\/\//, '')}
                    leading={<GlyphTile glyph="server" size={36} />}
                    accessibilityHint="Fills in this address"
                    onPress={() => setUrl(item)}
                  />
                ))}
              </Group>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
