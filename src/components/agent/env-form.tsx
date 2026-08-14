import {
  Button,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { IconKey } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import type { EnvVariableField } from '~agent/events';
import classes from './chat.module.css';

export type EnvEntry = { key: string; value: string; secret: boolean };

function initialValues(variables: EnvVariableField[]): Record<string, string> {
  return Object.fromEntries(variables.map((variable) => [variable.key, '']));
}

function initialPrivacy(
  variables: EnvVariableField[],
): Record<string, boolean> {
  return Object.fromEntries(
    variables.map((variable) => [variable.key, variable.secret]),
  );
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function EnvForm({
  reason,
  variables,
  onSubmit,
  disabled,
}: {
  reason: string;
  variables: EnvVariableField[];
  onSubmit: (entries: EnvEntry[]) => Promise<boolean>;
  disabled?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialValues(variables),
  );
  const [privacy, setPrivacy] = useState<Record<string, boolean>>(() =>
    initialPrivacy(variables),
  );
  const [submitting, setSubmitting] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const submittingRef = useRef(false);
  const sharedCount = variables.filter(
    (variable) => !(privacy[variable.key] ?? variable.secret),
  ).length;
  const privateCount = variables.length - sharedCount;
  const variableCountLabel = countLabel(variables.length, 'variable');
  const sharedCountLabel = countLabel(sharedCount, 'value');
  const summary =
    sharedCount === 0
      ? `${variableCountLabel} will be saved privately. 0 values will be shared with the AI.`
      : `${variableCountLabel} will be saved. ${sharedCountLabel} will be ` +
        'shared with the AI in plaintext and retained in the chat history.';
  const submitLabel = `Save ${variableCountLabel}, share ${sharedCount} with AI`;

  const submit = async () => {
    if (disabled || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setAnnouncement(
      sharedCount === 0
        ? `Saving ${variableCountLabel} privately.`
        : `Saving ${variableCountLabel} and sharing ${sharedCountLabel} with the AI.`,
    );
    const entries = variables.map((variable) => ({
      key: variable.key,
      value: values[variable.key] ?? '',
      secret: privacy[variable.key] ?? variable.secret,
    }));
    try {
      if (await onSubmit(entries)) {
        setValues(initialValues(variables));
        setAnnouncement('Environment variables saved.');
      } else {
        setAnnouncement(
          'Environment variables were not saved. Your values are still here.',
        );
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Paper
      className={classes.envCard}
      radius="md"
      p="md"
      withBorder
      aria-busy={submitting || undefined}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap="md">
          <Stack gap={6}>
            <Group gap={6}>
              <IconKey size={16} className={classes.envIcon} />
              <Text size="xs" fw={600} className={classes.envHeading}>
                Agent needs environment variables
              </Text>
            </Group>
            <Text size="sm" fw={600}>
              {reason}
            </Text>
            <Text size="xs" c="dimmed" className={classes.envNote}>
              Every value is saved in this chat&apos;s workspace. Keep private
              prevents this form from sending the value to the AI, while Agent
              commands can still use it. Turn it off only for non-sensitive
              configuration: the plaintext value is sent to the AI and retained
              in the chat history.
            </Text>
          </Stack>

          {variables.map((variable) => {
            const isPrivate = privacy[variable.key] ?? variable.secret;
            const isVisible = visible[variable.key] ?? false;
            return (
              <Stack key={variable.key} gap={8} className={classes.envVariable}>
                <PasswordInput
                  label={variable.key}
                  description={variable.description}
                  value={values[variable.key] ?? ''}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setValues((current) => ({
                      ...current,
                      [variable.key]: value,
                    }));
                  }}
                  disabled={disabled || submitting}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  visible={isVisible}
                  onVisibilityChange={(nextVisible) => {
                    setVisible((current) => ({
                      ...current,
                      [variable.key]: nextVisible,
                    }));
                  }}
                  visibilityToggleButtonProps={{
                    'aria-label': `${isVisible ? 'Hide' : 'Show'} value for ${variable.key}`,
                    tabIndex: 0,
                  }}
                  styles={{
                    label: {
                      fontFamily: 'var(--mantine-font-family-monospace)',
                    },
                  }}
                />
                <Switch
                  checked={isPrivate}
                  onChange={(event) => {
                    const nextPrivate = event.currentTarget.checked;
                    setPrivacy((current) => ({
                      ...current,
                      [variable.key]: nextPrivate,
                    }));
                  }}
                  disabled={disabled || submitting}
                  color="ember.7"
                  label="Keep private"
                  aria-label={`Keep ${variable.key} private`}
                  description={
                    isPrivate
                      ? 'Saved for Agent commands without being sent to the AI by this form.'
                      : 'This plaintext value will be sent to the AI and retained in the chat history.'
                  }
                />
              </Stack>
            );
          })}

          <Stack gap={6}>
            <Text
              size="xs"
              c={sharedCount > 0 ? 'orange.8' : 'dimmed'}
              className={classes.envSummary}
            >
              {summary}
            </Text>
            <Group justify="flex-end">
              <Button
                type="submit"
                size="sm"
                color="ember.7"
                loading={submitting}
                disabled={disabled || submitting}
              >
                {submitLabel}
              </Button>
            </Group>
          </Stack>
          <Text
            component="output"
            className={classes.visuallyHidden}
            aria-live="polite"
            aria-atomic="true"
          >
            {announcement ||
              `Agent needs ${variableCountLabel}. ${privateCount} private, ${sharedCount} shared.`}
          </Text>
        </Stack>
      </form>
    </Paper>
  );
}
