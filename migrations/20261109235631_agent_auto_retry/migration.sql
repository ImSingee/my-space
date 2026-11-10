ALTER TABLE "agent_runs" ADD COLUMN "failure_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "auto_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_runs_auto_retry_at_idx" ON "agent_runs" ("auto_retry_at") WHERE "agent_runs"."auto_retry_at" is not null;