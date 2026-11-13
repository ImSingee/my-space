CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"kinds" jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" text PRIMARY KEY,
	"notification_id" text NOT NULL,
	"destination_id" text,
	"destination_type" text NOT NULL,
	"destination_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"http_status" integer,
	"result" text,
	"route_ids" jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_destinations" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"session_id" text,
	"user_id" text,
	"platform" text,
	"apns_token" text,
	"apns_environment" text,
	"e2e_key_id" text,
	"e2e_key_ciphertext" text,
	"url" text,
	"secret_ciphertext" text,
	"app_id" text,
	"disabled_reason" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_destinations_type_check" CHECK ((
        ("notification_destinations"."type" = 'device'
          and "notification_destinations"."session_id" is not null
          and "notification_destinations"."user_id" is not null
          and "notification_destinations"."platform" is not null
          and "notification_destinations"."apns_token" is not null
          and "notification_destinations"."apns_environment" is not null
          and "notification_destinations"."e2e_key_id" is not null
          and "notification_destinations"."e2e_key_ciphertext" is not null
          and "notification_destinations"."url" is null
          and "notification_destinations"."app_id" is null)
        or ("notification_destinations"."type" = 'webhook'
          and "notification_destinations"."url" is not null
          and "notification_destinations"."secret_ciphertext" is not null
          and "notification_destinations"."session_id" is null
          and "notification_destinations"."app_id" is null)
        or ("notification_destinations"."type" = 'app'
          and "notification_destinations"."app_id" is not null
          and "notification_destinations"."session_id" is null
          and "notification_destinations"."url" is null)
      ))
);
--> statement-breakpoint
CREATE TABLE "notification_group_members" (
	"group_id" text,
	"destination_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_group_members_pkey" PRIMARY KEY("group_id","destination_id")
);
--> statement-breakpoint
CREATE TABLE "notification_groups" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_routes" (
	"id" text PRIMARY KEY,
	"name" text,
	"source_type" text NOT NULL,
	"app_id" text,
	"channel_id" text,
	"kind" text,
	"target_group_id" text,
	"target_destination_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_routes_target_check" CHECK ((("notification_routes"."target_group_id" is null) <> ("notification_routes"."target_destination_id" is null))),
	CONSTRAINT "notification_routes_source_check" CHECK ((
        ("notification_routes"."source_type" = 'app' and "notification_routes"."channel_id" is null)
        or ("notification_routes"."source_type" = 'channel' and "notification_routes"."app_id" is null)
        or ("notification_routes"."source_type" = 'any' and "notification_routes"."app_id" is null and "notification_routes"."channel_id" is null)
      ))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY,
	"source_type" text NOT NULL,
	"app_id" text,
	"channel_id" text,
	"source_name" text NOT NULL,
	"kind" text NOT NULL,
	"kind_name" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"url" text,
	"data" jsonb,
	"dedupe_key" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_source_check" CHECK ((
        ("notifications"."source_type" = 'app' and "notifications"."channel_id" is null)
        or ("notifications"."source_type" = 'channel' and "notifications"."app_id" is null)
        or ("notifications"."source_type" = 'platform' and "notifications"."app_id" is null and "notifications"."channel_id" is null)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_token_hash_idx" ON "notification_channels" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_notification_destination_idx" ON "notification_deliveries" ("notification_id","destination_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" ("status","next_attempt_at") WHERE "notification_deliveries"."status" in ('pending', 'in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "notification_destinations_session_idx" ON "notification_destinations" ("session_id") WHERE "notification_destinations"."session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_destinations_apns_token_idx" ON "notification_destinations" ("apns_token") WHERE "notification_destinations"."apns_token" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_destinations_app_idx" ON "notification_destinations" ("app_id") WHERE "notification_destinations"."app_id" is not null;--> statement-breakpoint
CREATE INDEX "notification_group_members_destination_idx" ON "notification_group_members" ("destination_id");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_app_created_idx" ON "notifications" ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_channel_created_idx" ON "notifications" ("channel_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_app_dedupe_idx" ON "notifications" ("app_id","dedupe_key") WHERE "notifications"."app_id" is not null and "notifications"."dedupe_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_channel_dedupe_idx" ON "notifications" ("channel_id","dedupe_key") WHERE "notifications"."channel_id" is not null and "notifications"."dedupe_key" is not null;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_XUCLu7lx5KQj_fkey" FOREIGN KEY ("destination_id") REFERENCES "notification_destinations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notification_destinations" ADD CONSTRAINT "notification_destinations_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_destinations" ADD CONSTRAINT "notification_destinations_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_destinations" ADD CONSTRAINT "notification_destinations_app_id_apps_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_group_members" ADD CONSTRAINT "notification_group_members_group_id_notification_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "notification_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_group_members" ADD CONSTRAINT "notification_group_members_QZwoZEK6ukKy_fkey" FOREIGN KEY ("destination_id") REFERENCES "notification_destinations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_routes" ADD CONSTRAINT "notification_routes_app_id_apps_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_routes" ADD CONSTRAINT "notification_routes_channel_id_notification_channels_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_routes" ADD CONSTRAINT "notification_routes_target_group_id_notification_groups_id_fkey" FOREIGN KEY ("target_group_id") REFERENCES "notification_groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_routes" ADD CONSTRAINT "notification_routes_Zorj5JPds3Cb_fkey" FOREIGN KEY ("target_destination_id") REFERENCES "notification_destinations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_app_id_apps_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channel_id_notification_channels_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE SET NULL;