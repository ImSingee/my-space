import { Button, Group, Stack, Textarea, TextInput } from '@mantine/core';
import { modals } from '@mantine/modals';
import { useState } from 'react';

type TextPromptOptions = {
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  /** Save button caption (defaults to "Save"). */
  submitLabel?: string;
  /** Render a multi-line textarea; submit is button-only (Enter = newline). */
  multiline?: boolean;
  /** Permit saving an empty value (e.g. to clear a description). */
  allowEmpty?: boolean;
  /**
   * Persist the value (single-line values arrive trimmed). Resolve to close
   * the modal; reject to keep it open for a retry — the rejection toast comes
   * from the global mutation error handler, not from here.
   */
  onSubmit: (value: string) => Promise<unknown>;
};

function TextPromptForm({
  modalId,
  options,
}: {
  modalId: string;
  options: TextPromptOptions;
}) {
  const [value, setValue] = useState(options.initialValue ?? '');
  const [pending, setPending] = useState(false);
  const allowEmpty = options.allowEmpty ?? false;
  const canSubmit = allowEmpty || value.trim().length > 0;

  const submit = async () => {
    if (!canSubmit || pending) return;
    setPending(true);
    try {
      await options.onSubmit(options.multiline ? value : value.trim());
      modals.close(modalId);
    } catch {
      setPending(false);
    }
  };

  const inputProps = {
    'data-autofocus': true,
    label: options.label,
    placeholder: options.placeholder,
    value,
  };

  return (
    <Stack gap="sm">
      {options.multiline ? (
        <Textarea
          {...inputProps}
          autosize
          minRows={3}
          maxRows={6}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
      ) : (
        <TextInput
          {...inputProps}
          onChange={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
      )}
      <Group justify="flex-end">
        <Button
          type="button"
          loading={pending}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {options.submitLabel ?? 'Save'}
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * One-line "prompt" modal (rename things, edit a description, …) so every
 * caller doesn't hand-roll the same Modal + TextInput + Enter-to-submit +
 * pending-button wiring with its own open/value state pair.
 */
export function openTextPromptModal(options: TextPromptOptions): void {
  const modalId = `text-prompt-${Math.random().toString(36).slice(2)}`;
  modals.open({
    modalId,
    title: options.title,
    centered: true,
    children: <TextPromptForm modalId={modalId} options={options} />,
  });
}
