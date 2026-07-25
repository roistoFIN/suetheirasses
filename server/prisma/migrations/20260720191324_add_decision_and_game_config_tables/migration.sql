-- CreateTable
CREATE TABLE "decisions" (
    "name" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "game_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "gameSettings" JSONB NOT NULL,
    "playerStartingValues" JSONB NOT NULL,
    "adminVariables" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_config_pkey" PRIMARY KEY ("id")
);
