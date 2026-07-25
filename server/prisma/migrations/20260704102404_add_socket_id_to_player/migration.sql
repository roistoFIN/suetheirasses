-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('WAITING', 'STRATEGY', 'RESULTS', 'LAWSUITS', 'RESOLVING');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('WON', 'LOST', 'SETTLED');

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'WAITING',
    "maxPlayers" INTEGER NOT NULL DEFAULT 6,
    "currentPhaseRound" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "isReady" BOOLEAN NOT NULL DEFAULT false,
    "bankrupt" BOOLEAN NOT NULL DEFAULT false,
    "socketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "cash" DOUBLE PRECISION NOT NULL DEFAULT 100000,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lawsuit" (
    "id" TEXT NOT NULL,
    "plaintiffId" TEXT NOT NULL,
    "defendantId" TEXT NOT NULL,
    "claimAmount" DOUBLE PRECISION NOT NULL,
    "grounds" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "verdict" "Verdict",
    "resolution" TEXT DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lawsuit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Room_status_idx" ON "Room"("status");

-- CreateIndex
CREATE INDEX "Room_created_at_idx" ON "Room"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Player_socketId_key" ON "Player"("socketId");

-- CreateIndex
CREATE UNIQUE INDEX "Player_companyId_key" ON "Player"("companyId");

-- CreateIndex
CREATE INDEX "Player_roomId_idx" ON "Player"("roomId");

-- CreateIndex
CREATE INDEX "Player_bankrupt_idx" ON "Player"("bankrupt");

-- CreateIndex
CREATE UNIQUE INDEX "Company_playerId_key" ON "Company"("playerId");

-- CreateIndex
CREATE INDEX "Company_playerId_idx" ON "Company"("playerId");

-- CreateIndex
CREATE INDEX "Asset_companyId_idx" ON "Asset"("companyId");

-- CreateIndex
CREATE INDEX "Lawsuit_plaintiffId_idx" ON "Lawsuit"("plaintiffId");

-- CreateIndex
CREATE INDEX "Lawsuit_defendantId_idx" ON "Lawsuit"("defendantId");

-- CreateIndex
CREATE INDEX "Lawsuit_resolved_idx" ON "Lawsuit"("resolved");

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lawsuit" ADD CONSTRAINT "Lawsuit_plaintiffId_fkey" FOREIGN KEY ("plaintiffId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lawsuit" ADD CONSTRAINT "Lawsuit_defendantId_fkey" FOREIGN KEY ("defendantId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
