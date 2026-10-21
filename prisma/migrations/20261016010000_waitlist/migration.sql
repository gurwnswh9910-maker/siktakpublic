CREATE TABLE "WaitlistEntry" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "tableId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'WAITING',
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WaitlistEntry_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WaitlistEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EventSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WaitlistEntry_status_check" CHECK ("status" IN ('WAITING', 'OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN', 'CLOSED'))
);
CREATE UNIQUE INDEX "WaitlistEntry_applicationId_key" ON "WaitlistEntry"("applicationId");
CREATE INDEX "WaitlistEntry_eventId_status_createdAt_idx" ON "WaitlistEntry"("eventId", "status", "createdAt");
CREATE INDEX "WaitlistEntry_tableId_status_idx" ON "WaitlistEntry"("tableId", "status");
CREATE UNIQUE INDEX "WaitlistEntry_one_offer_per_table" ON "WaitlistEntry"("tableId") WHERE "status" = 'OFFERED';
ALTER TABLE "WaitlistEntry" ENABLE ROW LEVEL SECURITY;
