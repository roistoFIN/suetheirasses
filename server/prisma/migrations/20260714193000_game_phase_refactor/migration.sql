-- AlterEnum
BEGIN;
CREATE TYPE "RoomStatus_new" AS ENUM ('WAITING', 'GAME_PHASE', 'AFTERMATH');
ALTER TABLE "public"."Room" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Room" ALTER COLUMN "status" TYPE "RoomStatus_new" USING ("status"::text::"RoomStatus_new");
ALTER TYPE "RoomStatus" RENAME TO "RoomStatus_old";
ALTER TYPE "RoomStatus_new" RENAME TO "RoomStatus";
DROP TYPE "public"."RoomStatus_old";
ALTER TABLE "Room" ALTER COLUMN "status" SET DEFAULT 'WAITING';
COMMIT;

-- DropForeignKey
ALTER TABLE "Lawsuit" DROP CONSTRAINT "Lawsuit_defendantId_fkey";

-- DropForeignKey
ALTER TABLE "Lawsuit" DROP CONSTRAINT "Lawsuit_plaintiffId_fkey";

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "engineState" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "lastTurnSnapshot" JSONB DEFAULT '{}',
ADD COLUMN     "variables" JSONB NOT NULL DEFAULT '{}';

-- DropTable
DROP TABLE "Lawsuit";

-- DropEnum
DROP TYPE "Verdict";

