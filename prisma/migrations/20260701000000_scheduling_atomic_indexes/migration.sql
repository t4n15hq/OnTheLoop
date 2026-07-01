-- AlterTable
ALTER TABLE "schedules" ADD COLUMN     "nextFireAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "favorites_userId_idx" ON "favorites"("userId");

-- CreateIndex
CREATE INDEX "schedules_enabled_idx" ON "schedules"("enabled");

-- CreateIndex
CREATE INDEX "schedules_nextFireAt_idx" ON "schedules"("nextFireAt");

-- CreateIndex
CREATE INDEX "schedules_userId_idx" ON "schedules"("userId");

-- CreateIndex
CREATE INDEX "schedules_favoriteId_idx" ON "schedules"("favoriteId");

-- CreateIndex
CREATE INDEX "notification_logs_scheduleId_idx" ON "notification_logs"("scheduleId");
