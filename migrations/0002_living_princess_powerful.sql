CREATE TABLE IF NOT EXISTS "dashboards" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "dashboards" ("id", "name", "sort_order") VALUES ('default', 'My Dashboard', 0) ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD COLUMN IF NOT EXISTS "dashboard_id" text;--> statement-breakpoint
UPDATE "dashboard_widgets" SET "dashboard_id" = 'default' WHERE "dashboard_id" IS NULL;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ALTER COLUMN "dashboard_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
