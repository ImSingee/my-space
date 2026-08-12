import { defineSchema, defineTable, t } from '@hatch/data';

export default defineSchema({
  counters: defineTable({
    name: t.string(),
    value: t.integer().default(0),
  }).uniqueIndex('by_name', ['name']),
});
