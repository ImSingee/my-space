import { Alert, Anchor, Button, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import {
  formatUserCode,
  normalizeUserCode,
  USER_CODE_LENGTH,
} from './device-api';
import { ViewHeader } from './layout';
import type { EntryProblem } from './problems';
import classes from './device-approval.module.css';

const PROBLEM_TEXT: Record<Exclude<EntryProblem, 'invalid'>, string> = {
  'rate-limited': 'Too many attempts. Wait a minute, then try again.',
  network: 'Couldn’t reach Hatch. Check your connection and try again.',
  server: 'Hatch couldn’t open this request. Try again in a moment.',
};

type CodeEntryProps = {
  code: string;
  onCodeChange: (code: string) => void;
  onSubmit: () => void;
  pending: boolean;
  problem: EntryProblem | null;
  account: string | null;
  onSwitchAccount: () => void;
  /** Move focus to the field: no code was supplied, or the person started over. */
  focus: boolean;
};

export function CodeEntry({
  code,
  onCodeChange,
  onSubmit,
  pending,
  problem,
  account,
  onSwitchAccount,
  focus,
}: CodeEntryProps) {
  const input = useRef<HTMLInputElement>(null);
  const [incomplete, setIncomplete] = useState(false);

  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);

  const fieldError = incomplete
    ? `Enter all ${USER_CODE_LENGTH} characters of the code.`
    : problem === 'invalid'
      ? 'No open request uses this code. Check it against your device.'
      : undefined;

  return (
    <>
      <ViewHeader title="Connect a device">
        Enter the code shown on your device.
      </ViewHeader>

      <form
        className={classes.sheet}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          if (code.length !== USER_CODE_LENGTH) {
            setIncomplete(true);
            input.current?.focus();
            return;
          }
          onSubmit();
        }}
      >
        <TextInput
          ref={input}
          label="Device code"
          placeholder="XXXX-XXXX"
          value={formatUserCode(code)}
          onChange={(event) => {
            setIncomplete(false);
            onCodeChange(normalizeUserCode(event.currentTarget.value));
          }}
          readOnly={pending}
          error={fieldError}
          size="lg"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          classNames={{ input: classes.codeInput, label: classes.codeLabel }}
        />
        {problem && problem !== 'invalid' ? (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertTriangle size={18} stroke={1.75} />}
            role="alert"
          >
            {PROBLEM_TEXT[problem]}
          </Alert>
        ) : null}
        <Button type="submit" size="md" fullWidth loading={pending}>
          Review request
        </Button>
      </form>

      <Text size="sm" c="dimmed" ta="center" className={classes.footnote}>
        {account ? (
          <>
            Signed in as{' '}
            <Text span size="sm" fw={500} c="var(--mantine-color-text)">
              {account}
            </Text>
            .{' '}
          </>
        ) : null}
        <Anchor
          component="button"
          type="button"
          size="sm"
          onClick={onSwitchAccount}
        >
          Use a different account
        </Anchor>
      </Text>
    </>
  );
}
