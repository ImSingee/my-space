CREATE TABLE "agent_models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"name" text NOT NULL,
	"reasoning" boolean DEFAULT false NOT NULL,
	"input" jsonb DEFAULT '["text"]'::jsonb NOT NULL,
	"context_window" integer DEFAULT 128000 NOT NULL,
	"max_tokens" integer DEFAULT 8192 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"api_type" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"subapp_id" text,
	"provider_id" text,
	"model_id" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_widgets" (
	"id" text PRIMARY KEY NOT NULL,
	"subapp_id" text NOT NULL,
	"widget_id" text NOT NULL,
	"x" integer DEFAULT 0 NOT NULL,
	"y" integer DEFAULT 0 NOT NULL,
	"w" integer DEFAULT 4 NOT NULL,
	"h" integer DEFAULT 3 NOT NULL,
	"config" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"subapp_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"manifest_normalized" jsonb,
	"build_log" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" text PRIMARY KEY NOT NULL,
	"subapp_id" text,
	"source" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sidebar_items" (
	"id" text PRIMARY KEY NOT NULL,
	"subapp_id" text NOT NULL,
	"label" text NOT NULL,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subapps" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"capabilities" jsonb,
	"manifest" jsonb,
	"backend_mode" text,
	"db_name" text,
	"current_deployment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_models" ADD CONSTRAINT "agent_models_provider_id_agent_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."agent_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_subapp_id_subapps_id_fk" FOREIGN KEY ("subapp_id") REFERENCES "public"."subapps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_subapp_id_subapps_id_fk" FOREIGN KEY ("subapp_id") REFERENCES "public"."subapps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_subapp_id_subapps_id_fk" FOREIGN KEY ("subapp_id") REFERENCES "public"."subapps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sidebar_items" ADD CONSTRAINT "sidebar_items_subapp_id_subapps_id_fk" FOREIGN KEY ("subapp_id") REFERENCES "public"."subapps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");