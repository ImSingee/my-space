---
name: tool-call-contracts
description: Implement or review Hatch Agent tool declarations and execution contracts, including models that populate optional fields with empty values. Use when changing platform Agent tools or debugging argument validation; not for App application schemas.
---

# Tool call contracts

Do not assume a model can omit fields from a tool call. Every schema-optional
control field must accept `null`, `""`, `[]`, `{}` and numeric `0` as the
omitted/default spelling, including optional enum, boolean, numeric, object and
array fields. Passing each empty spelling must have exactly the same final
behavior as omitting the field. This includes defaults, platform requests and
errors for fields required by the selected action. Declare that spelling in the
model-visible schema and normalize it before provider argument coercion and
execution. Required fields remain required and must declare their actual
nonempty, length, numeric and action-specific constraints.

The shared `tool()` boundary in `src/agent/tools/shared.ts` handles optional
placeholders, including nested declared properties. Keep tools on this boundary;
do not independently strip all empty values or rely on truthiness. Preserve
explicit `false`, whitespace strings and all required/action-required data
values according to their existing contracts. Optional control zero means
omission; required data zero (such as an increment amount) is a real value.
Empty data can be meaningful: KV `set.value: ""` is a real write, and empty
strings inside JSON records or filter values are data.
Declare a `preserveEmptyValue` exception for fields that are schema-optional
only because the tool supports multiple actions, but required data in the
selected action (KV set.value, mutation value and increment amount).
Normalization must never recurse into arbitrary user JSON records.

For multi-action tools, remove only declared optional empty placeholders. Then
validate the active action's required and allowed fields with its strict runtime
schema. A populated inactive `key: null` or another empty spelling means omission;
an inactive nonempty key or an unknown field is still an error. Never discard a nonempty invalid
field to make a request succeed. Platform REST endpoints can remain strict and
receive canonical requests; explicit backward-compatible aliases such as empty
pagination cursors must be accepted consistently at the advertised boundary.

Keep raw model arguments unchanged in tool-start events and the transcript.
Create separate normalized execution arguments at the raw boundary, before
pi-ai coercion. Empty values select omission directly; do not first convert
every null or scalar into another spelling. Validate the original types and
enum membership of remaining optional arguments before conversion. Checking
only string type is insufficient: an invalid enum string `"0"` can be coerced
to the permitted numeric `0` placeholder and silently select a default.
Likewise, false in a numeric field must not become a default. Raw null remains valid
inside JSON data, but is rejected for action-required string/number data.

Verify public behavior with calls that populate optional fields with each of
`null`, `""`, `[]`, `{}` and `0`, not just calls that omit them. Cover default
paths and pagination, active empty writes and nested JSON, valid nonempty
values, invalid nonempty types and enum values that could coerce to empty
placeholders, and length bounds,
strict action/unknown-field rejection, platform side effects, and unchanged raw
history. Inspect actual supported provider payloads to confirm an object root
and all optional empty alternatives survive adaptation. Keep durable behavior
and contract tests; do not retain helper-only or exact-copy tests.
