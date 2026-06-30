CREATE TABLE "app_cron_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"job_name" text NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"status" integer,
	"ok" boolean DEFAULT false NOT NULL,
	"target" text,
	"detail" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_cron_runs" ADD CONSTRAINT "app_cron_runs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_cron_runs_app_created_idx" ON "app_cron_runs" USING btree ("app_id","created_at");