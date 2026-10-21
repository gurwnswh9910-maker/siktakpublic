-- The calculation is an explicit mock/demo snapshot, not a real PG policy.
-- Null preserves refunds created before the versioned demo calculation.
ALTER TABLE "Refund" ADD COLUMN "calculation" JSONB;
