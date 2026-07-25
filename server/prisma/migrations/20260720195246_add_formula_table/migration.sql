-- CreateTable
CREATE TABLE "formulas" (
    "key" TEXT NOT NULL,
    "expression" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "formulas_pkey" PRIMARY KEY ("key")
);
