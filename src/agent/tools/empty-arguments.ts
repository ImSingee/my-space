import { Type, type TSchema } from '@earendil-works/pi-ai';

type ObjectSchema = TSchema & {
  description?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, TSchema>;
  required?: string[];
  items?: TSchema;
  anyOf?: TSchema[];
};

export type PreserveEmptyValue = (
  fieldPath: string,
  input: Record<string, unknown>,
) => boolean;

function isEmptyOptionalValue(value: unknown): boolean {
  return (
    value === null ||
    value === '' ||
    value === 0 ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}

function hasDeclaredTypeAndEnumValue(
  value: unknown,
  shape: ObjectSchema,
): boolean {
  if (Object.hasOwn(shape, 'const') && value !== shape.const) return false;
  if (shape.enum && !shape.enum.includes(value)) return false;
  if (shape.anyOf) {
    return shape.anyOf.some((member) =>
      hasDeclaredTypeAndEnumValue(value, member as ObjectSchema),
    );
  }
  const type =
    shape.type ??
    (Object.hasOwn(shape, 'const') ? typeof shape.const : undefined);
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'integer') return typeof value === 'number';
  return typeof type !== 'string' || typeof value === type;
}

/** Optional fields need a placeholder for models that always emit them. */
export function withEmptyOptionalFields(schema: TSchema): TSchema {
  const source = schema as ObjectSchema;
  const result: ObjectSchema = { ...source };
  if (source.anyOf) {
    result.anyOf = source.anyOf.map(withEmptyOptionalFields);
  }
  if (source.items) result.items = withEmptyOptionalFields(source.items);
  if (source.properties) {
    result.properties = Object.fromEntries(
      Object.entries(source.properties).map(([key, field]) => {
        const adapted = withEmptyOptionalFields(field);
        return [
          key,
          source.required?.includes(key)
            ? adapted
            : Type.Union(
                [
                  adapted,
                  Type.Literal(''),
                  Type.Null(),
                  Type.Literal(0),
                  Type.Array(Type.Any(), { maxItems: 0 }),
                  Type.Object({}, { additionalProperties: false }),
                ],
                typeof (field as ObjectSchema).description === 'string'
                  ? { description: (field as ObjectSchema).description }
                  : {},
              ),
        ];
      }),
    );
  }
  return result;
}

/** Only visit declared fields, never arbitrary JSON records or user data. */
export function normalizeEmptyOptionalFields(
  input: Record<string, unknown>,
  schema: TSchema,
  preserve?: PreserveEmptyValue,
): Record<string, unknown> {
  function normalize(
    value: unknown,
    shape: ObjectSchema,
    path: string,
  ): unknown {
    if (Array.isArray(value) && shape.items) {
      return value.map((item, index) =>
        normalize(item, shape.items as ObjectSchema, `${path}.${index}`),
      );
    }
    if (!value || typeof value !== 'object' || !shape.properties) return value;
    const result: Record<string, unknown> = { ...value };
    for (const [key, field] of Object.entries(shape.properties)) {
      if (!Object.hasOwn(result, key)) continue;
      const fieldPath = path ? `${path}.${key}` : key;
      const optional = !shape.required?.includes(key);
      if (
        isEmptyOptionalValue(result[key]) &&
        optional &&
        !preserve?.(fieldPath, input)
      ) {
        delete result[key];
      } else {
        // Check original types and enum membership before pi-ai can turn a
        // nonempty invalid value (for example "0") into an empty spelling.
        if (
          optional &&
          result[key] !== undefined &&
          !hasDeclaredTypeAndEnumValue(result[key], field as ObjectSchema)
        ) {
          throw new Error(
            `Invalid tool argument ${fieldPath}: expected ${String((field as ObjectSchema).type ?? 'declared type or enum value')}.`,
          );
        }
        result[key] = normalize(result[key], field as ObjectSchema, fieldPath);
      }
    }
    return result;
  }
  return normalize(input, schema as ObjectSchema, '') as Record<
    string,
    unknown
  >;
}
