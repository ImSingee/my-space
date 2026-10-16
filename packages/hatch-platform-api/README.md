# Hatch Platform API contract

Shared Connect/Protobuf contract for CLI and native/mobile clients. This package
contains no platform server code. Its TypeScript export is the generated service
and message descriptors; other languages generate clients from `proto/` using
Buf and their language's Connect plugin. Authentication uses native Better Auth
HTTP lifecycle plus credentials on Connect requests.

From the repository root:

```sh
pnpm platform-api:generate
pnpm platform-api:check
```

Generated TypeScript and `buf.lock` are committed. Public request validation uses
Protovalidate annotations, enforced by the platform; clients need not duplicate
validation to call RPCs. Field numbers and presence are public contracts.
See [Platform API](../../docs/platform-api.md) for routing, authentication,
validation, errors and release policy. No OpenAPI endpoint is provided.

Proto files are organized by domain: `app.proto`, `workflow.proto`, `auth.proto`
and `sdk.proto` include each service and its request/response messages. Shared
App/Workflow resource and release messages live in `lifecycle.proto`; shared file
payloads and business errors live in `file.proto` and `error.proto`. Dependencies
point from domain files to these shared definitions. The package entry point
re-exports all generated descriptors.
