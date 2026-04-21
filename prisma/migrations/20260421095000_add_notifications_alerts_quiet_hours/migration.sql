-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('AUTO', 'EMAIL', 'TELEGRAM', 'BOTH');

-- AlterTable
ALTER TABLE "schedules" ADD COLUMN     "channel" "Channel" NOT NULL DEFAULT 'AUTO',
ADD COLUMN     "lastTriggeredAt" TIMESTAMP(3),
ADD COLUMN     "leadMinutes" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notificationsPausedUntil" TIMESTAMP(3),
ADD COLUMN     "quietHoursEnd" TEXT,
ADD COLUMN     "quietHoursStart" TEXT;

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_logs_userId_createdAt_idx" ON "notification_logs"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

