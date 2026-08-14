CREATE TYPE "public"."dashboard_breakpoint" AS ENUM('desktop', 'tablet', 'mobile');--> statement-breakpoint
CREATE TABLE "dashboard_widget_layouts" (
	"dashboard_widget_id" text NOT NULL,
	"breakpoint" "dashboard_breakpoint" NOT NULL,
	"x" integer DEFAULT 0 NOT NULL,
	"y" integer DEFAULT 0 NOT NULL,
	"w" integer DEFAULT 4 NOT NULL,
	"h" integer DEFAULT 3 NOT NULL,
	CONSTRAINT "dashboard_widget_layouts_dashboard_widget_id_breakpoint_pk" PRIMARY KEY("dashboard_widget_id","breakpoint")
);
--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "editor_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_widget_layouts" ADD CONSTRAINT "dashboard_widget_layouts_dashboard_widget_id_dashboard_widgets_id_fk" FOREIGN KEY ("dashboard_widget_id") REFERENCES "public"."dashboard_widgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "dashboard_widget_layouts" ("dashboard_widget_id", "breakpoint", "x", "y", "w", "h")
SELECT "id", 'desktop', "x", "y", "w", "h"
FROM "dashboard_widgets";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" DROP COLUMN "x";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" DROP COLUMN "y";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" DROP COLUMN "w";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" DROP COLUMN "h";
