/*
  Warnings:

  - You are about to drop the column `isReady` on the `Player` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Player" DROP COLUMN "isReady",
ADD COLUMN     "isHost" BOOLEAN NOT NULL DEFAULT false;
