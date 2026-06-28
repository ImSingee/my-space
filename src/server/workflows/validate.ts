/**
 * Server-only: validate a workflow's trigger input against the JSON Schema that
 * was captured (from the workflow's zod schema) at deploy time.
 *
 * The workflow bundle re-validates with the *real* zod schema at run time, so
 * this platform-side check is a fast, structural gate rather than the source of
 * truth. It deliberately errs toward acceptance: constraints it can't faithfully
 * represent (formats, patterns) are skipped instead of risking a false reject.
 * Per the design, the gate is built by turning the stored JSON Schema back into
 * a zod schema ("zod from json schema") and parsing the input with it.
 */
import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

function asSchema(value: unknown): JsonSchema | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonSchema)
    : null;
}

function typeOf(schema: JsonSchema): string | string[] | undefined {
  return schema.type as string | string[] | undefined;
}

/** Build a lenient zod schema from a (zod-produced) JSON Schema node. */
export function jsonSchemaToZod(input: unknown): z.ZodTypeAny {
  const schema = asSchema(input);
  if (!schema) return z.any();

  // Unions first — zod emits these for `.or()`, nullable, and enums of objects.
  const union = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(union) && union.length > 0) {
    const options = union.map((u) => jsonSchemaToZod(u));
    return options.length === 1
      ? options[0]
      : z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  if ('const' in schema) {
    return z.literal(schema.const as z.core.util.Literal);
  }

  if (Array.isArray(schema.enum)) {
    const values = schema.enum as unknown[];
    return z.custom((v) => values.some((e) => Object.is(e, v) || e === v), {
      message: 'Invalid enum value',
    });
  }

  const type = typeOf(schema);
  if (Array.isArray(type)) {
    // e.g. ["string", "null"] -> string | null
    const options = type.map((t) => jsonSchemaToZod({ ...schema, type: t }));
    return options.length === 1
      ? options[0]
      : z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  switch (type) {
    case 'string': {
      let s = z.string();
      if (typeof schema.minLength === 'number') s = s.min(schema.minLength);
      if (typeof schema.maxLength === 'number') s = s.max(schema.maxLength);
      return s;
    }
    case 'integer':
    case 'number': {
      let n = z.number();
      if (type === 'integer') n = n.int();
      if (typeof schema.minimum === 'number') n = n.min(schema.minimum);
      if (typeof schema.maximum === 'number') n = n.max(schema.maximum);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const items = asSchema(schema.items);
      return z.array(items ? jsonSchemaToZod(items) : z.any());
    }
    case 'object':
      return objectToZod(schema);
    default:
      // No declared type but has object-ish keys -> treat as object.
      if (schema.properties) return objectToZod(schema);
      return z.any();
  }
}

function objectToZod(schema: JsonSchema): z.ZodTypeAny {
  const props = asSchema(schema.properties) ?? {};
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(props)) {
    const child = asSchema(raw) ?? {};
    let field = jsonSchemaToZod(child);
    if ('default' in child) {
      field = field.default(child.default as never);
    } else if (!required.has(key)) {
      field = field.optional();
    }
    shape[key] = field;
  }
  const obj = z.object(shape);
  // Mirror additionalProperties: false (the default for zod-produced schemas)
  // by stripping unknown keys rather than rejecting, to stay lenient.
  return schema.additionalProperties === false ? obj.strip() : obj.loose();
}

/** Collect the candidate JSON Schema types for a node, peering into unions. */
function collectTypes(schema: JsonSchema): Set<string> {
  const types = new Set<string>();
  const t = typeOf(schema);
  if (typeof t === 'string') types.add(t);
  else if (Array.isArray(t)) for (const x of t) types.add(x);
  const union = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(union)) {
    for (const u of union) {
      const child = asSchema(u);
      if (child) for (const x of collectTypes(child)) types.add(x);
    }
  }
  return types;
}

/** Coerce a single query-string value toward the type the schema expects. */
function coerceScalar(schema: JsonSchema, value: string): unknown {
  // Enums carry their own (possibly numeric/boolean) member types.
  if (Array.isArray(schema.enum)) {
    const members = schema.enum as unknown[];
    if (members.length > 0 && members.every((m) => typeof m === 'number')) {
      const n = Number(value);
      if (value.trim() !== '' && !Number.isNaN(n)) return n;
    }
    if (members.length > 0 && members.every((m) => typeof m === 'boolean')) {
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
    return value;
  }
  const types = collectTypes(schema);
  if (types.has('number') || types.has('integer')) {
    const n = Number(value);
    if (value.trim() !== '' && !Number.isNaN(n)) return n;
  }
  if (types.has('boolean')) {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return value;
}

/**
 * Coerce a flat query-string record toward the workflow's input schema so GET
 * webhooks (whose params are always strings) can satisfy numeric/boolean fields.
 * Unknown fields and unrepresentable types pass through untouched; the real zod
 * schema inside the bundle remains the source of truth.
 */
export function coerceWorkflowQueryInput(
  jsonSchema: unknown,
  raw: Record<string, string>,
): Record<string, unknown> {
  const schema = asSchema(jsonSchema);
  const props = schema ? asSchema(schema.properties) : null;
  if (!props) return { ...raw };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const child = asSchema(props[key]);
    out[key] = child ? coerceScalar(child, value) : value;
  }
  return out;
}

export type WorkflowValidationResult =
  | { success: true; data: unknown }
  | { success: false; message: string };

/** Validate raw trigger input against a stored JSON Schema. */
export function validateWorkflowInput(
  jsonSchema: unknown,
  rawInput: unknown,
): WorkflowValidationResult {
  if (!asSchema(jsonSchema)) {
    // No schema captured (e.g. a workflow with no declared input) — accept.
    return { success: true, data: rawInput ?? {} };
  }
  const zodSchema = jsonSchemaToZod(jsonSchema);
  const parsed = zodSchema.safeParse(rawInput ?? {});
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  const message = parsed.error.issues
    .map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
  return { success: false, message: message || 'Invalid input' };
}
