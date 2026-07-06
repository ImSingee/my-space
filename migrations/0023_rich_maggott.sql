ALTER TABLE "agent_run_events" ADD COLUMN "runner_seq" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "pending_answer" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "runner_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_events_run_runner_seq_idx" ON "agent_run_events" USING btree ("run_id","runner_seq");