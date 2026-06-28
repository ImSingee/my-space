import {
  Alert,
  Button,
  Group,
  JsonInput,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { workflowRunsQueryOptions } from '~queries/workflows';
import { runWorkflowFn } from '~server/workflows';

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  title?: string;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

/**
 * Unwrap a zod-emitted union (`anyOf`/`oneOf`, used for `.nullable()` and
 * simple unions) to the concrete member that drives the input: drop the `null`
 * branch and take the first remaining member, keeping any metadata the parent
 * node carries. Without this, a required nullable field has no top-level `type`
 * and falls back to a raw JSON editor that submit() then drops. Mirrors the
 * server validator, which also understands these union nodes.
 */
function effectiveSchema(schema: JsonSchema): JsonSchema {
  const union = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(union) || union.length === 0) return schema;
  const member = union.find((m) => m && m.type !== 'null') ?? union[0] ?? {};
  return {
    ...member,
    title: schema.title ?? member.title,
    description: schema.description ?? member.description,
    enum: schema.enum ?? member.enum,
    default: 'default' in schema ? schema.default : member.default,
  };
}

type Field = {
  key: string;
  schema: JsonSchema;
  required: boolean;
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'json';
};

function typeOf(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type)) {
    return schema.type.find((t) => t !== 'null') ?? schema.type[0];
  }
  return schema.type;
}

function fieldKind(schema: JsonSchema): Field['kind'] {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return 'enum';
  const t = typeOf(schema);
  if (t === 'string') return 'string';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'json';
}

/** Build flat field descriptors from an object schema, or null if not inferable. */
function inferFields(schema: JsonSchema | null): Field[] | null {
  if (!schema || typeOf(schema) !== 'object' || !schema.properties) return null;
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([key, propSchema]) => {
    const eff = effectiveSchema(propSchema);
    return {
      key,
      schema: eff,
      required: required.has(key),
      kind: fieldKind(eff),
    };
  });
}

function initialValues(fields: Field[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    if ('default' in f.schema) {
      values[f.key] = f.schema.default;
    } else if (f.kind === 'boolean') {
      // Leave an optional boolean unset so an untouched switch is omitted on
      // submit and the schema's own default applies; a required one still
      // starts at false (a valid value the user can flip).
      values[f.key] = f.required ? false : undefined;
    } else {
      values[f.key] = '';
    }
  }
  return values;
}

export function TriggerForm({
  workflowId,
  inputSchema,
  disabled,
}: {
  workflowId: string;
  inputSchema: unknown;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const schema = (inputSchema ?? null) as JsonSchema | null;
  const fields = inferFields(schema);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    fields ? initialValues(fields) : {},
  );
  // Raw JSON editor used when the schema isn't a simple flat object.
  const [rawJson, setRawJson] = useState('{}');
  const [error, setError] = useState<string | null>(null);

  // Reset the form when the workflow (or its input schema) changes without a
  // remount — e.g. navigating between two workflow pages, or a redeploy that
  // alters the schema. Otherwise stale values leak across workflows and new
  // defaults never apply. (React's "adjust state during render" pattern.)
  const resetKey = `${workflowId}|${JSON.stringify(inputSchema ?? null)}`;
  const [appliedKey, setAppliedKey] = useState(resetKey);
  if (appliedKey !== resetKey) {
    setAppliedKey(resetKey);
    setValues(fields ? initialValues(fields) : {});
    setRawJson('{}');
    setError(null);
  }

  const run = useMutation({
    mutationFn: (input: unknown) =>
      runWorkflowFn({ data: { id: workflowId, input } }),
    onSuccess: (result) => {
      // A validation failure still records a (failed) run rather than throwing,
      // so report it as an error instead of "started" — but still link to the
      // recorded run so the user can see why it was rejected.
      if (result.status === 'failed') {
        toast.error('Input rejected — see the execution for details.');
      } else {
        toast.success('Execution started');
      }
      void queryClient.invalidateQueries(workflowRunsQueryOptions(workflowId));
      void navigate({
        to: '/workflows/$workflowId/executions/$runId',
        params: { workflowId, runId: result.runId },
      });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const setValue = (key: string, value: unknown) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const submit = () => {
    setError(null);
    let input: unknown;
    if (fields) {
      // A required object/array is rendered as a raw JSON editor whose empty
      // value would otherwise be silently dropped, so the run fails server-side
      // for missing input. Surface that inline. Other kinds aren't checked
      // here: an empty string is a valid required value (schema only requires
      // the property to be present), so the server stays the source of truth.
      for (const f of fields) {
        if (!f.required || f.kind !== 'json') continue;
        const v = values[f.key];
        // Only the string editor value can be empty. A non-string value is a
        // schema default (object/array) the server applies when the field is
        // omitted, so don't block those.
        if (typeof v === 'string' && !v.trim()) {
          setError(`Field "${f.schema.title ?? f.key}" is required.`);
          return;
        }
      }
      const obj: Record<string, unknown> = {};
      for (const f of fields) {
        const v = values[f.key];
        if (f.kind === 'json') {
          if (typeof v === 'string' && v.trim()) {
            try {
              obj[f.key] = JSON.parse(v);
            } catch {
              setError(`Field "${f.key}" must be valid JSON.`);
              return;
            }
          }
          continue;
        }
        // Skip empty optional fields so schema defaults apply.
        if ((v === '' || v === undefined) && !f.required) continue;
        if (f.kind === 'enum') {
          // The Select stores the stringified option label; map it back to the
          // original enum value so non-string enums (e.g. [1, 2]) keep their
          // type and pass server-side validation.
          const original = (f.schema.enum ?? []).find((o) => String(o) === v);
          obj[f.key] = original === undefined ? v : original;
          continue;
        }
        obj[f.key] = v;
      }
      input = obj;
    } else {
      try {
        input = rawJson.trim() ? JSON.parse(rawJson) : {};
      } catch {
        setError('Input must be valid JSON.');
        return;
      }
    }
    run.mutate(input);
  };

  return (
    <Stack gap="md">
      {fields && fields.length > 0 ? (
        fields.map((f) => {
          const label = f.schema.title ?? f.key;
          const desc = f.schema.description;
          if (f.kind === 'boolean') {
            return (
              <Switch
                key={f.key}
                label={label}
                description={desc}
                checked={Boolean(values[f.key])}
                onChange={(e) => setValue(f.key, e.currentTarget.checked)}
                disabled={disabled}
              />
            );
          }
          if (f.kind === 'enum') {
            return (
              <Select
                key={f.key}
                label={label}
                description={desc}
                required={f.required}
                data={(f.schema.enum ?? []).map((o) => String(o))}
                value={values[f.key] == null ? null : String(values[f.key])}
                onChange={(v) => setValue(f.key, v ?? '')}
                disabled={disabled}
              />
            );
          }
          if (f.kind === 'number') {
            return (
              <NumberInput
                key={f.key}
                label={label}
                description={desc}
                required={f.required}
                min={f.schema.minimum}
                max={f.schema.maximum}
                value={
                  values[f.key] === '' || values[f.key] == null
                    ? ''
                    : Number(values[f.key])
                }
                onChange={(v) => setValue(f.key, v)}
                disabled={disabled}
              />
            );
          }
          if (f.kind === 'json') {
            return (
              <JsonInput
                key={f.key}
                label={label}
                description={desc}
                required={f.required}
                autosize
                minRows={2}
                formatOnBlur
                value={
                  typeof values[f.key] === 'string'
                    ? (values[f.key] as string)
                    : ''
                }
                onChange={(v) => setValue(f.key, v)}
                disabled={disabled}
              />
            );
          }
          return (
            <TextInput
              key={f.key}
              label={label}
              description={desc}
              required={f.required}
              value={
                typeof values[f.key] === 'string'
                  ? (values[f.key] as string)
                  : ''
              }
              onChange={(e) => setValue(f.key, e.currentTarget.value)}
              disabled={disabled}
            />
          );
        })
      ) : fields ? (
        <Text size="sm" c="dimmed">
          This workflow takes no input.
        </Text>
      ) : (
        <JsonInput
          label="Input (JSON)"
          description="This workflow's input schema is custom — provide raw JSON."
          autosize
          minRows={4}
          formatOnBlur
          value={rawJson}
          onChange={setRawJson}
          disabled={disabled}
        />
      )}

      {error ? (
        <Alert color="red" variant="light" py="xs">
          {error}
        </Alert>
      ) : null}

      <Group justify="flex-end">
        <Button
          type="button"
          leftSection={<IconPlayerPlay size={16} stroke={1.8} />}
          loading={run.isPending}
          disabled={disabled}
          onClick={submit}
        >
          Run now
        </Button>
      </Group>
    </Stack>
  );
}
