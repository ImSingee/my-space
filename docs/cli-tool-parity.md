# App and Workflow Tool / CLI capability parity

All methods below use Connect RPC under `/api/rpc/hatch.platform.v1`.
Tools remain available, and every
valid native session, API key or Run JWT has full public authority. The shared
contract and SDK are shipped with the same platform build. No database migration,
App/Workflow compatibility bump or protocol-18 wire change is required.

| Original Tool        | CLI                                     | Public API / shared behavior                                                                              |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| list_apps            | app list                                | AppService/ListApps; currentVersion, compatibility, capabilities                                          |
| get_app              | app get                                 | AppService/GetApp; full safe inspection, URLs, runtime, history                                           |
| checkout_app         | app clone / update / adopt              | GetApp/GetAppSource, SdkService/GetSdk, AssociateAppSession; frozen preparation, force/recovery           |
| create_app           | app create                              | AppService/CreateApp; template, pin, directory, SDK, ID/slug/path/recovery                                |
| deploy_app           | app deploy                              | AppService/DeployApp; normalized release/URLs, generation, migration approval, Run association            |
| rollback_app         | app rollback                            | AppService/RollbackApp; compatibility and forward-only data/source recovery                               |
| query_app_db         | app db query                            | AppService/QueryAppDb; registered DB lifecycle lock, DDL/DML, caps/cancellation; no implicit provisioning |
| query_app_kv         | app kv list/get/set/delete              | AppService/QueryAppKv; empty/large UTF-8, masking/reveal, preserve/clear secret, pagination               |
| query_app_data_table | app data-table inspect/query/mutate/sql | AppService/QueryAppDataTable; schema/counts, JSON, cursors/revision, atomic mutations, bounded SQL        |
| list_workflows       | workflow list                           | WorkflowService/ListWorkflows; liveVersion, compatibility, webhook, cronCount                             |
| get_workflow         | workflow get                            | WorkflowService/GetWorkflow; input Schema, network/triggers, runs/history/errors                          |
| checkout_workflow    | workflow clone / update / adopt         | GetWorkflow/GetWorkflowSource, SdkService/GetSdk; history/dirty/generation, force/recovery                |
| create_workflow      | workflow create                         | WorkflowService/CreateWorkflow; template, pin/directory, SDK, ID/slug/path/recovery                       |
| deploy_workflow      | workflow deploy                         | WorkflowService/DeployWorkflow; normalized release/triggers and generation                                |
| rollback_workflow    | workflow rollback                       | WorkflowService/RollbackWorkflow; compatibility and source recovery                                       |

CLI extends local checkout output with head/master, dirty/status,
replacedExisting/synchronizedExisting and preparation. Text and JSON modes retain
the complete result. CLI adopts only proven Agent checkout identity/history and
never modifies the original origin or resets dirty source. Empty canonical
source creates a recoverable empty Git checkout, never a second resource.

The production HTTP/PostgreSQL suite in
`src/server/platform-api/lifecycle.integration.test.ts` calls all fifteen actual
Tools through the internal REST client and compares public CLI outputs and
resource effects. It also covers session/key/Run auth, full lifecycle, migration
approval and retained data, data commands, and PostgreSQL-observed cancellation.
Workspace concurrency/recovery cases run real child processes/Git in
`packages/hatch-cli/src/workspace.test.ts`. Existing Tool normalization and domain
security/migration regressions remain part of the unit suite. The tests require
an isolated database and a production build; a skipped suite is not evidence.

Local acceptance records should distinguish observed outputs/side effects,
programmatic quality gates, installed-package/container results, and genuinely
untested operating systems. No host credential injection/renewal, Tool removal,
Workflow run/cancel, storage/key management or durable operation service is part
of this feature.
