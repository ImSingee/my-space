DROP INDEX "workflow_run_steps_run_seq_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_steps_run_seq_attempt_idx" ON "workflow_run_steps" USING btree ("run_id","seq","attempt");