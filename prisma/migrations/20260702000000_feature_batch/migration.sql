-- AlterTable
ALTER TABLE "schedules" ADD COLUMN     "startLabel" TEXT,
ADD COLUMN     "startLat" DOUBLE PRECISION,
ADD COLUMN     "startLon" DOUBLE PRECISION,
ADD COLUMN     "stopLat" DOUBLE PRECISION,
ADD COLUMN     "stopLon" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "accessibilityAlerts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "disruptionAlerts" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "arrival_observations" (
    "id" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "direction" TEXT,
    "predictedMin" INTEGER,
    "delayed" BOOLEAN NOT NULL DEFAULT false,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledUp" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "arrival_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reliability_buckets" (
    "id" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT '',
    "hourOfWeek" INTEGER NOT NULL,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "delayedCount" INTEGER NOT NULL DEFAULT 0,
    "sumPredictedMin" INTEGER NOT NULL DEFAULT 0,
    "predictedSampleCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reliability_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sent_alerts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "alertKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sent_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "arrival_observations_rolledUp_idx" ON "arrival_observations"("rolledUp");

-- CreateIndex
CREATE INDEX "arrival_observations_stopId_routeId_observedAt_idx" ON "arrival_observations"("stopId", "routeId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "reliability_buckets_stopId_routeId_direction_hourOfWeek_key" ON "reliability_buckets"("stopId", "routeId", "direction", "hourOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "sent_alerts_userId_alertKey_key" ON "sent_alerts"("userId", "alertKey");

-- AddForeignKey
ALTER TABLE "sent_alerts" ADD CONSTRAINT "sent_alerts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

