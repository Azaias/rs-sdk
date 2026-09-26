-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "koth_capture";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "runite_mine" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timestamp" DATETIME NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'main',
    "username" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "runite_mine_timestamp_idx" ON "runite_mine"("timestamp");

