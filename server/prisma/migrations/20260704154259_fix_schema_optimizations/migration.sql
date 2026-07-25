/*
  Warnings:

  - You are about to alter the column `value` on the `Asset` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(15,2)`.
  - You are about to alter the column `cash` on the `Company` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(15,2)`.
  - You are about to alter the column `claimAmount` on the `Lawsuit` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(15,2)`.
  - You are about to drop the column `created_at` on the `Room` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Lawsuit_defendantId_idx";

-- DropIndex
DROP INDEX "Lawsuit_plaintiffId_idx";

-- DropIndex
DROP INDEX "Player_bankrupt_idx";

-- DropIndex
DROP INDEX "Player_socketId_key";

-- DropIndex
DROP INDEX "Room_created_at_idx";

-- AlterTable
ALTER TABLE "Asset" ALTER COLUMN "value" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "Company" ALTER COLUMN "cash" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "Lawsuit" ALTER COLUMN "claimAmount" SET DATA TYPE DECIMAL(15,2);

-- AlterTable
ALTER TABLE "Room" DROP COLUMN "created_at";

-- CreateIndex
CREATE INDEX "Lawsuit_plaintiffId_resolved_idx" ON "Lawsuit"("plaintiffId", "resolved");

-- CreateIndex
CREATE INDEX "Lawsuit_defendantId_resolved_idx" ON "Lawsuit"("defendantId", "resolved");

-- CreateIndex
CREATE INDEX "Player_roomId_bankrupt_idx" ON "Player"("roomId", "bankrupt");

-- CreateIndex
CREATE INDEX "Room_createdAt_idx" ON "Room"("createdAt");
