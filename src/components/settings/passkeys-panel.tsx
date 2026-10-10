import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import type { Passkey } from '@better-auth/passkey';
import {
  IconAlertCircle,
  IconCheck,
  IconEdit,
  IconKey,
  IconPlus,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import { getAuthenticatorName } from '~auth/authenticator-names';
import { getPasskeyOriginError } from '~auth/passkey-origin';
import {
  browserSupportsPasskeys,
  isPasskeyCancellation,
  passkeyErrorMessage,
} from '~auth/passkey-browser';
import classes from './passkeys-panel.module.css';

type EditingName = {
  id: string;
  value: string;
};

export function PasskeysPanel({ appOrigin }: { appOrigin: string }) {
  const { data: passkeys, isPending, error } = authClient.useListPasskeys();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EditingName | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const supported = browserSupportsPasskeys(appOrigin);
  const originError = getPasskeyOriginError(appOrigin, window.location.origin);
  const editingId = editing?.id;

  useEffect(() => {
    if (editingId) nameInputRef.current?.focus();
  }, [editingId]);

  const addPasskey = async () => {
    setAdding(true);
    try {
      const result = await authClient.passkey.addPasskey();
      if (result.error) {
        if (!isPasskeyCancellation(result.error)) {
          toast.error(
            passkeyErrorMessage(result.error, 'Could not add the passkey.'),
          );
        }
        return;
      }

      toast.success('Passkey added');
    } catch {
      toast.error('Could not add the passkey. Please try again.');
    } finally {
      setAdding(false);
    }
  };

  const saveName = async () => {
    if (!editing) return;

    const name = editing.value.trim();
    if (!name) return;

    setSavingId(editing.id);
    try {
      const result = await authClient.passkey.updatePasskey({
        id: editing.id,
        name,
      });
      if (result.error) {
        toast.error(
          passkeyErrorMessage(result.error, 'Could not rename the passkey.'),
        );
        return;
      }

      setEditing(null);
      toast.success('Passkey renamed');
    } catch {
      toast.error('Could not rename the passkey. Please try again.');
    } finally {
      setSavingId(null);
    }
  };

  const deletePasskey = async (passkey: Passkey) => {
    setDeletingId(passkey.id);
    try {
      const result = await authClient.passkey.deletePasskey({ id: passkey.id });
      if (result.error) {
        toast.error(
          passkeyErrorMessage(result.error, 'Could not delete the passkey.'),
        );
        return;
      }

      if (editing?.id === passkey.id) setEditing(null);
      toast.success('Passkey deleted');
    } catch {
      toast.error('Could not delete the passkey. Please try again.');
    } finally {
      setDeletingId(null);
    }
  };

  const confirmDelete = (passkey: Passkey) => {
    const name = displayName(passkey);
    modals.openConfirmModal({
      title: `Delete ${name}?`,
      centered: true,
      children: (
        <Text size="sm">
          This passkey will stop working for sign-in. You can continue to use
          your password or another passkey.
        </Text>
      ),
      labels: { confirm: 'Delete passkey', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => void deletePasskey(passkey),
    });
  };

  return (
    <Stack gap="md">
      <Group
        justify="space-between"
        align="flex-start"
        wrap="nowrap"
        className={classes.header}
      >
        <Stack gap={2}>
          <Text fw={600}>Passkeys</Text>
          <Text size="sm" c="dimmed">
            Sign in with your device, password manager, or a security key.
          </Text>
        </Stack>
        <Button
          leftSection={<IconPlus size={16} stroke={1.8} />}
          loading={adding}
          disabled={!supported}
          onClick={addPasskey}
          className={classes.addButton}
        >
          Add passkey
        </Button>
      </Group>

      {!supported && (
        <Alert
          icon={<IconAlertCircle size={18} />}
          title={
            originError
              ? 'Passkeys are not available at this address'
              : 'Passkeys are not available in this browser'
          }
          color="yellow"
        >
          {originError ??
            'Open Hatch from a secure, supported browser to add or use a passkey.'}{' '}
          You can still manage passkeys already linked to your account.
        </Alert>
      )}

      {isPending ? (
        <PasskeysSkeleton />
      ) : error ? (
        <Alert
          icon={<IconAlertCircle size={18} />}
          title="Passkeys could not be loaded"
          color="red"
        >
          Refresh the page to try again. Password sign-in is unaffected.
        </Alert>
      ) : passkeys && passkeys.length > 0 ? (
        <div className={classes.list}>
          {passkeys.map((passkey) => {
            const name = displayName(passkey);
            const isEditing = editing?.id === passkey.id;

            return (
              <div className={classes.row} key={passkey.id}>
                <Group gap="sm" wrap="nowrap" className={classes.identity}>
                  <ThemeIcon variant="light" size="lg" radius="md">
                    <IconKey size={18} stroke={1.7} />
                  </ThemeIcon>
                  {isEditing ? (
                    <TextInput
                      aria-label={`Name for ${name}`}
                      value={editing.value}
                      onChange={(event) =>
                        setEditing({
                          id: passkey.id,
                          value: event.currentTarget.value,
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveName();
                        if (event.key === 'Escape') setEditing(null);
                      }}
                      disabled={savingId === passkey.id}
                      error={editing.value.trim() ? undefined : 'Enter a name'}
                      ref={nameInputRef}
                      className={classes.nameInput}
                    />
                  ) : (
                    <Stack gap={0} miw={0}>
                      <Text size="sm" fw={600} truncate>
                        {name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        Added {dayjs(passkey.createdAt).format('MMM D, YYYY')}
                      </Text>
                    </Stack>
                  )}
                </Group>

                <Group gap={4} wrap="nowrap" className={classes.actions}>
                  {isEditing ? (
                    <>
                      <Tooltip label="Save name">
                        <ActionIcon
                          variant="subtle"
                          aria-label={`Save name for ${name}`}
                          loading={savingId === passkey.id}
                          disabled={!editing.value.trim()}
                          onClick={() => void saveName()}
                        >
                          <IconCheck size={17} stroke={1.7} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Cancel">
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Cancel renaming ${name}`}
                          disabled={savingId === passkey.id}
                          onClick={() => setEditing(null)}
                        >
                          <IconX size={17} stroke={1.7} />
                        </ActionIcon>
                      </Tooltip>
                    </>
                  ) : (
                    <>
                      <Tooltip label="Rename">
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={`Rename ${name}`}
                          disabled={deletingId === passkey.id}
                          onClick={() =>
                            setEditing({ id: passkey.id, value: name })
                          }
                        >
                          <IconEdit size={17} stroke={1.7} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={`Delete ${name}`}
                          loading={deletingId === passkey.id}
                          onClick={() => confirmDelete(passkey)}
                        >
                          <IconTrash size={17} stroke={1.7} />
                        </ActionIcon>
                      </Tooltip>
                    </>
                  )}
                </Group>
              </div>
            );
          })}
        </div>
      ) : (
        <div className={classes.empty}>
          <ThemeIcon variant="light" size={42} radius="xl">
            <IconKey size={21} stroke={1.7} />
          </ThemeIcon>
          <Stack gap={2} align="center">
            <Text size="sm" fw={600}>
              No passkeys yet
            </Text>
            <Text size="sm" c="dimmed" ta="center">
              {supported
                ? 'Add one to sign in without typing your password.'
                : 'Password sign-in is still available.'}
            </Text>
          </Stack>
        </div>
      )}
    </Stack>
  );
}

function displayName(passkey: Passkey): string {
  return (
    passkey.name?.trim() || getAuthenticatorName(passkey.aaguid) || 'Passkey'
  );
}

function PasskeysSkeleton() {
  return (
    <Stack gap="xs" aria-label="Loading passkeys">
      {[0, 1].map((key) => (
        <Group key={key} gap="sm" wrap="nowrap" py="xs">
          <Skeleton height={34} width={34} radius="md" />
          <Stack gap={5} flex={1}>
            <Skeleton height={14} width="35%" radius="sm" />
            <Skeleton height={10} width="24%" radius="sm" />
          </Stack>
        </Group>
      ))}
    </Stack>
  );
}
