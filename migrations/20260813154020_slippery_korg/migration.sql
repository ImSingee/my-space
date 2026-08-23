ALTER TABLE "agent_runs" ADD COLUMN "pending_env_request" jsonb;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "workspace_runner_id" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "workspace_affinity_state" text DEFAULT 'uninitialized' NOT NULL;--> statement-breakpoint
WITH "latest_runner" AS (
	SELECT DISTINCT ON ("run"."session_id")
		"run"."session_id",
		"run"."runner_id"
	FROM "agent_runs" AS "run"
	WHERE
		"run"."runner_id" IS NOT NULL
		AND EXISTS (
			SELECT 1
			FROM "agent_run_events" AS "event"
			WHERE
				"event"."run_id" = "run"."id"
				AND "event"."runner_seq" IS NOT NULL
		)
	ORDER BY "run"."session_id", "run"."created_at" DESC, "run"."id" DESC
)
UPDATE "agent_sessions"
SET
	"workspace_runner_id" = "latest_runner"."runner_id",
	"workspace_affinity_state" = 'claimed'
FROM "latest_runner"
WHERE "agent_sessions"."id" = "latest_runner"."session_id";--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_workspace_affinity_check" CHECK ((
        ("agent_sessions"."workspace_affinity_state" = 'claimed' and "agent_sessions"."workspace_runner_id" is not null)
        or
        ("agent_sessions"."workspace_affinity_state" = 'uninitialized' and "agent_sessions"."workspace_runner_id" is null)
      ));
