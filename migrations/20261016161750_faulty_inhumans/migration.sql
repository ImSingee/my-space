ALTER TABLE "agent_models" ALTER COLUMN "input" SET DEFAULT '["text","image"]';
--> statement-breakpoint
-- The model form previously hardcoded ['text'] without an image-input control.
-- Repair that historical default once; future text-only choices stay explicit.
UPDATE "agent_models"
SET "input" = '["text","image"]'::jsonb
WHERE "input" = '["text"]'::jsonb;
