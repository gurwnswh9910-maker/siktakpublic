ALTER TABLE "Application"
  ADD COLUMN "deferredCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastDeferredDate" TEXT;
ALTER TABLE "Application" ADD CONSTRAINT "Application_deferredCount_nonnegative"
  CHECK ("deferredCount" >= 0);

-- Historical explicit schedule transfers establish prior deferral eligibility.
UPDATE "Application" AS a SET "deferredCount" = h.n
FROM (
  SELECT "objectId", COUNT(*)::INTEGER AS n
  FROM "AuditLog" WHERE action = 'MATCH_TRANSFERRED' GROUP BY "objectId"
) AS h WHERE a.id = h."objectId";
