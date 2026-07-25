-- AlterTable
ALTER TABLE "Room" ALTER COLUMN "maxPlayers" SET DEFAULT 4;

-- CreateIndex
CREATE INDEX "Player_socketId_idx" ON "Player"("socketId");

-- CreateIndex
CREATE INDEX "Room_id_currentPhaseRound_idx" ON "Room"("id", "currentPhaseRound");
