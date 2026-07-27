-- AlterTable
ALTER TABLE "legal_case_history" ADD COLUMN     "baseProbability" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "plaintiffFullyInvestigated" BOOLEAN NOT NULL DEFAULT false;
