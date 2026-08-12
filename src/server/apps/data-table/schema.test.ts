import { describe, expect, it } from 'vitest';
import { parseDataSchemaDescriptor } from './schema';

describe('managed Data Table schema validation', () => {
  it.each([{ $hatch: 'evil' }, { $hatch: 'now', extra: true }])(
    'rejects an inexact datetime default marker',
    (value) => {
      expect(() =>
        parseDataSchemaDescriptor({
          version: 1,
          tables: {
            events: {
              fields: {
                occurredAt: {
                  kind: 'datetime',
                  optional: false,
                  default: value,
                },
              },
              indexes: [],
            },
          },
        }),
      ).toThrow('default does not match datetime field');
    },
  );

  it('preserves a JSON default that merely contains a $hatch key', () => {
    const parsed = parseDataSchemaDescriptor({
      version: 1,
      tables: {
        events: {
          fields: {
            metadata: {
              kind: 'json',
              optional: false,
              default: { $hatch: 'value', nested: true },
            },
          },
          indexes: [],
        },
      },
    });
    expect(parsed.tables.events.fields.metadata?.default).toEqual({
      $hatch: 'value',
      nested: true,
    });
  });

  it('treats the exact defaultNow marker as ordinary JSON on JSON fields', () => {
    const parsed = parseDataSchemaDescriptor({
      version: 1,
      tables: {
        events: {
          fields: {
            metadata: {
              kind: 'json',
              optional: false,
              default: { $hatch: 'now' },
            },
          },
          indexes: [],
        },
      },
    });

    expect(parsed.tables.events.fields.metadata?.default).toEqual({
      $hatch: 'now',
    });
  });

  it.each(['infinity', '-infinity', 'epoch', 'not-a-date'])(
    'rejects runtime-incompatible datetime default %s',
    (value) => {
      expect(() =>
        parseDataSchemaDescriptor({
          version: 1,
          tables: {
            events: {
              fields: {
                occurredAt: {
                  kind: 'datetime',
                  optional: false,
                  default: value,
                },
              },
              indexes: [],
            },
          },
        }),
      ).toThrow('default does not match datetime field');
    },
  );

  it.each(['created_at', 'updated_at'])(
    'reserves the physical platform column %s',
    (field) => {
      expect(() =>
        parseDataSchemaDescriptor({
          version: 1,
          tables: {
            events: {
              fields: {
                [field]: { kind: 'string', optional: false },
              },
              indexes: [],
            },
          },
        }),
      ).toThrow(`${field} is a platform-managed field`);
    },
  );

  it.each(['tableoid', 'xmin', 'cmin', 'xmax', 'cmax', 'ctid'])(
    'rejects PostgreSQL system column %s as a field name',
    (field) => {
      expect(() =>
        parseDataSchemaDescriptor({
          version: 1,
          tables: {
            events: {
              fields: {
                [field]: { kind: 'string', optional: false },
              },
              indexes: [],
            },
          },
        }),
      ).toThrow(`${field} is a PostgreSQL system column`);
    },
  );

  it.each(['tableoid', 'xmin', 'cmin', 'xmax', 'cmax', 'ctid'])(
    'rejects PostgreSQL system column %s as a field rename source',
    (field) => {
      expect(() =>
        parseDataSchemaDescriptor({
          version: 1,
          tables: {
            events: {
              fields: {
                value: {
                  kind: 'string',
                  optional: false,
                  renamedFrom: field,
                },
              },
              indexes: [],
            },
          },
        }),
      ).toThrow(`${field} is a PostgreSQL system column`);
    },
  );

  it('allows PostgreSQL system column names for non-column identifiers', () => {
    expect(() =>
      parseDataSchemaDescriptor({
        version: 1,
        tables: {
          xmin: {
            renamedFrom: 'xmax',
            fields: {
              value: { kind: 'string', optional: false },
            },
            indexes: [{ name: 'ctid', fields: ['value'], unique: false }],
          },
        },
      }),
    ).not.toThrow();
  });

  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'rejects Object prototype table names such as %s',
    (name) => {
      expect(() =>
        parseDataSchemaDescriptor({
          version: 1,
          tables: {
            [name]: { fields: {}, indexes: [] },
          },
        }),
      ).toThrow('must not collide with an Object prototype property');
    },
  );

  it('rejects Object prototype field, index, and reference names', () => {
    expect(() =>
      parseDataSchemaDescriptor({
        version: 1,
        tables: {
          events: {
            fields: {
              constructor: { kind: 'string', optional: false },
              owner: {
                kind: 'reference',
                optional: false,
                referenceTable: 'toString',
              },
            },
            indexes: [
              { name: 'valueOf', fields: ['constructor'], unique: false },
            ],
          },
        },
      }),
    ).toThrow('must not collide with an Object prototype property');
  });

  it('rejects duplicate fields within a compound index', () => {
    expect(() =>
      parseDataSchemaDescriptor({
        version: 1,
        tables: {
          events: {
            fields: {
              category: { kind: 'string', optional: false },
            },
            indexes: [
              {
                name: 'by_category',
                fields: ['category', 'category'],
                unique: false,
              },
            ],
          },
        },
      }),
    ).toThrow('index by_category fields must be unique');
  });
});
