ALTER TYPE "public"."finding_status" ADD VALUE 'superseded';--> statement-breakpoint
ALTER TYPE "public"."review_trigger" ADD VALUE 'manual';--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "superseded_by_finding_id" uuid;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_superseded_by_finding_id_findings_id_fk" FOREIGN KEY ("superseded_by_finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;