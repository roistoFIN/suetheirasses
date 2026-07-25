-- CreateTable
CREATE TABLE "event_log" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "roomId" TEXT,
    "playerId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_log_eventType_idx" ON "event_log"("eventType");

-- CreateIndex
CREATE INDEX "event_log_roomId_idx" ON "event_log"("roomId");

-- CreateIndex
CREATE INDEX "event_log_severity_idx" ON "event_log"("severity");

-- CreateIndex
CREATE INDEX "event_log_createdAt_idx" ON "event_log"("createdAt");
