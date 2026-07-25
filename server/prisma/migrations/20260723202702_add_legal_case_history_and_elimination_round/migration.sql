-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "eliminatedRound" INTEGER;

-- CreateTable
CREATE TABLE "legal_case_history" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "plaintiffId" TEXT NOT NULL,
    "plaintiffName" TEXT NOT NULL,
    "defendantId" TEXT NOT NULL,
    "defendantName" TEXT NOT NULL,
    "decisionName" TEXT NOT NULL,
    "groundName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "stakes" DECIMAL(15,2) NOT NULL,
    "filedRound" INTEGER NOT NULL,
    "resolvedRound" INTEGER,
    "verdict" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_case_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_case_history_roomId_idx" ON "legal_case_history"("roomId");

-- CreateIndex
CREATE INDEX "legal_case_history_roomId_filedRound_idx" ON "legal_case_history"("roomId", "filedRound");

-- AddForeignKey
ALTER TABLE "legal_case_history" ADD CONSTRAINT "legal_case_history_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
