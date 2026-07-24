-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('MEMBER', 'HEAD_OF_DEPT', 'ADMIN', 'CLINICIAN', 'RESEARCHER');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'AWAITING_REVIEW', 'COMPLETE');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "BloodType" AS ENUM ('A', 'B', 'AB', 'O');

-- CreateEnum
CREATE TYPE "RhFactor" AS ENUM ('POSITIVE', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "MallampatiClass" AS ENUM ('I', 'II', 'III', 'IV');

-- CreateEnum
CREATE TYPE "NeckMobility" AS ENUM ('FULL', 'LIMITED', 'FIXED');

-- CreateEnum
CREATE TYPE "UpperLipBiteTest" AS ENUM ('CLASS_I', 'CLASS_II', 'CLASS_III');

-- CreateEnum
CREATE TYPE "CormackLehane" AS ENUM ('I', 'IIa', 'IIb', 'III', 'IV');

-- CreateEnum
CREATE TYPE "ASAScore" AS ENUM ('I', 'II', 'III', 'IV', 'V', 'VI');

-- CreateEnum
CREATE TYPE "PatientPosition" AS ENUM ('SUPINE', 'PRONE', 'LEFT_LATERAL', 'RIGHT_LATERAL', 'LITHOTOMY', 'GYNECOLOGICAL', 'TRENDELENBURG', 'REVERSE_TRENDELENBURG', 'FOWLER', 'SITTING', 'BEACH_CHAIR', 'JACKKNIFE', 'LLOYD_DAVIES', 'KNEE_CHEST', 'LATERAL_DECUBITUS');

-- CreateEnum
CREATE TYPE "AnesthesiaTechnique" AS ENUM ('GENERAL_INHALATION', 'GENERAL_TIVA', 'GENERAL_COMBINED', 'SPINAL', 'EPIDURAL', 'COMBINED_SPINAL_EPIDURAL', 'PERIPHERAL_NERVE_BLOCK', 'LOCAL', 'SEDATION');

-- CreateEnum
CREATE TYPE "AirwayDevice" AS ENUM ('FACE_MASK', 'LMA', 'ORAL_ETT', 'NASAL_ETT', 'SURGICAL_AIRWAY');

-- CreateEnum
CREATE TYPE "VolatileAgent" AS ENUM ('SEVOFLURANE', 'DESFLURANE', 'ISOFLURANE');

-- CreateEnum
CREATE TYPE "CVKSite" AS ENUM ('INTERNAL_JUGULAR', 'EXTERNAL_JUGULAR', 'SUBCLAVIAN', 'FEMORAL');

-- CreateEnum
CREATE TYPE "ArterialLineSite" AS ENUM ('RADIAL', 'DORSALIS_PEDIS', 'FEMORAL', 'BRACHIAL');

-- CreateEnum
CREATE TYPE "PlexusBlock" AS ENUM ('AXILLARY', 'INTERSCALENE', 'SUPRACLAVICULAR', 'INFRACLAVICULAR', 'FEMORAL', 'SCIATIC', 'POPLITEAL', 'TAP', 'ERECTOR_SPINAE');

-- CreateEnum
CREATE TYPE "Disposition" AS ENUM ('WARD', 'PACU', 'ICU');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "institutionId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "acceptedTermsAt" TIMESTAMP(3),
    "acceptedPrivacyAt" TIMESTAMP(3),
    "termsVersion" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Institution" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'Bulgaria',

    CONSTRAINT "Institution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "caseCode" TEXT,
    "notes" TEXT,
    "userId" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'DRAFT',
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseLock" (
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseLock_pkey" PRIMARY KEY ("caseId")
);

-- CreateTable
CREATE TABLE "CaseTransfer" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CaseTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "RoleRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Icd10BgCode" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "Icd10BgCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Icd11Code" (
    "code" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelBg" TEXT,

    CONSTRAINT "Icd11Code_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "RevokedToken" (
    "jti" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevokedToken_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomTerm" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "termType" TEXT NOT NULL,
    "institutionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreoperativeAssessment" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "ageYears" INTEGER,
    "sex" "Sex" NOT NULL,
    "heightCm" DOUBLE PRECISION,
    "weightKg" DOUBLE PRECISION,
    "bmi" DOUBLE PRECISION,
    "bloodType" "BloodType",
    "rhFactor" "RhFactor",
    "diagnosis" TEXT NOT NULL,
    "diagnosesJson" JSONB,
    "plannedProcedure" TEXT NOT NULL,
    "proceduresJson" JSONB,
    "icdCode" TEXT,
    "teamNotes" TEXT,
    "comorbidities" JSONB NOT NULL DEFAULT '[]',
    "allergies" BOOLEAN NOT NULL DEFAULT false,
    "allergyDetails" TEXT,
    "latexAllergy" BOOLEAN NOT NULL DEFAULT false,
    "currentMedications" TEXT,
    "familyAnesthesiaProblems" BOOLEAN NOT NULL DEFAULT false,
    "familyAnesthesiaDetails" TEXT,
    "dentalProsthetics" BOOLEAN NOT NULL DEFAULT false,
    "looseTeeth" BOOLEAN NOT NULL DEFAULT false,
    "smoking" BOOLEAN NOT NULL DEFAULT false,
    "substanceAbuse" BOOLEAN NOT NULL DEFAULT false,
    "bpSystolic" INTEGER,
    "bpDiastolic" INTEGER,
    "heartRate" INTEGER,
    "heartArrhythmia" BOOLEAN NOT NULL DEFAULT false,
    "spO2" DOUBLE PRECISION,
    "temperature" DOUBLE PRECISION,
    "respiratoryRate" INTEGER,
    "mallampati" "MallampatiClass",
    "mouthOpeningCm" DOUBLE PRECISION,
    "thyromental" DOUBLE PRECISION,
    "neckMobility" "NeckMobility",
    "upperLipBiteTest" "UpperLipBiteTest",
    "retrognathia" BOOLEAN NOT NULL DEFAULT false,
    "prominentIncisors" BOOLEAN NOT NULL DEFAULT false,
    "facialHair" BOOLEAN NOT NULL DEFAULT false,
    "difficultAirwayHistory" BOOLEAN NOT NULL DEFAULT false,
    "difficultAirwayNotes" TEXT,
    "cormackLehane" "CormackLehane",
    "asaScore" "ASAScore",
    "emergencySurgery" BOOLEAN NOT NULL DEFAULT false,
    "rcriScore" INTEGER,
    "gutaScore" DOUBLE PRECISION,
    "apfelScore" INTEGER,
    "stopBangScore" INTEGER,
    "labResults" JSONB NOT NULL DEFAULT '[]',
    "aiOptIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreoperativeAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntraoperativeRecord" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "monthYear" TEXT,
    "durationMinutes" INTEGER,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "positions" JSONB NOT NULL DEFAULT '[]',
    "techniques" JSONB NOT NULL DEFAULT '[]',
    "airwayDevice" "AirwayDevice",
    "tubeSize" DOUBLE PRECISION,
    "cuffed" BOOLEAN,
    "peepCmH2O" DOUBLE PRECISION,
    "ippv" BOOLEAN NOT NULL DEFAULT false,
    "jetVentilation" BOOLEAN NOT NULL DEFAULT false,
    "fob" BOOLEAN NOT NULL DEFAULT false,
    "airwayTools" JSONB NOT NULL DEFAULT '[]',
    "airwayNotes" TEXT,
    "cormackLehane" "CormackLehane",
    "airwayDevices" JSONB NOT NULL DEFAULT '[]',
    "ventilationModes" JSONB NOT NULL DEFAULT '[]',
    "dltType" TEXT,
    "dltSide" TEXT,
    "dltSize" DOUBLE PRECISION,
    "endobronchialSize" DOUBLE PRECISION,
    "volatileAgent" "VolatileAgent",
    "n2oPercent" DOUBLE PRECISION,
    "o2Percent" DOUBLE PRECISION,
    "n2oLitersPerMin" DOUBLE PRECISION,
    "o2LitersPerMin" DOUBLE PRECISION,
    "plexusBlock" "PlexusBlock",
    "cvkSite" "CVKSite",
    "arterialLineSite" "ArterialLineSite",
    "ecg" BOOLEAN NOT NULL DEFAULT false,
    "urinaryCatheter" BOOLEAN NOT NULL DEFAULT false,
    "stomachTube" BOOLEAN NOT NULL DEFAULT false,
    "spO2Monitor" BOOLEAN NOT NULL DEFAULT true,
    "invasiveBP" BOOLEAN NOT NULL DEFAULT false,
    "cvpMonitor" BOOLEAN NOT NULL DEFAULT false,
    "bglMonitor" BOOLEAN NOT NULL DEFAULT false,
    "bloodGasMonitor" BOOLEAN NOT NULL DEFAULT false,
    "neuroMonitor" BOOLEAN NOT NULL DEFAULT false,
    "nbpMonitor" BOOLEAN NOT NULL DEFAULT true,
    "etco2Monitor" BOOLEAN NOT NULL DEFAULT false,
    "tempMonitor" BOOLEAN NOT NULL DEFAULT false,
    "paCatheter" BOOLEAN NOT NULL DEFAULT false,
    "tee" BOOLEAN NOT NULL DEFAULT false,
    "bis" BOOLEAN NOT NULL DEFAULT false,
    "entropyMonitor" BOOLEAN NOT NULL DEFAULT false,
    "nirsMonitor" BOOLEAN NOT NULL DEFAULT false,
    "evokedPotentials" BOOLEAN NOT NULL DEFAULT false,
    "tofMonitor" BOOLEAN NOT NULL DEFAULT false,
    "vascularAccesses" JSONB NOT NULL DEFAULT '[]',
    "premedicationEvening" TEXT,
    "premedicationMorning" TEXT,
    "drugsAdministered" JSONB NOT NULL DEFAULT '[]',
    "crystalloidsMl" INTEGER,
    "colloidsMl" INTEGER,
    "bloodMl" INTEGER,
    "bloodProductsNote" TEXT,
    "urineMl" INTEGER,
    "timeSeriesData" JSONB NOT NULL DEFAULT '[]',
    "keyEvents" JSONB NOT NULL DEFAULT '[]',
    "complications" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntraoperativeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostoperativeRecord" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "aldreteActivity" INTEGER,
    "aldreteRespiration" INTEGER,
    "aldreteCirculation" INTEGER,
    "aldreteConsciousness" INTEGER,
    "aldreteSpO2" INTEGER,
    "aldreteTotal" INTEGER,
    "painScoreNRS" INTEGER,
    "ponv" BOOLEAN NOT NULL DEFAULT false,
    "temperatureCelsius" DOUBLE PRECISION,
    "timeInRecoveryMin" INTEGER,
    "complications" TEXT,
    "disposition" "Disposition",
    "dispositionNotes" TEXT,
    "handoverItems" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostoperativeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Case_caseCode_key" ON "Case"("caseCode");

-- CreateIndex
CREATE INDEX "RevokedToken_expiresAt_idx" ON "RevokedToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomTerm_code_key" ON "CustomTerm"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PreoperativeAssessment_caseId_key" ON "PreoperativeAssessment"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "IntraoperativeRecord_caseId_key" ON "IntraoperativeRecord"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "PostoperativeRecord_caseId_key" ON "PostoperativeRecord"("caseId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseLock" ADD CONSTRAINT "CaseLock_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseTransfer" ADD CONSTRAINT "CaseTransfer_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseTransfer" ADD CONSTRAINT "CaseTransfer_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseTransfer" ADD CONSTRAINT "CaseTransfer_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleRequest" ADD CONSTRAINT "RoleRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreoperativeAssessment" ADD CONSTRAINT "PreoperativeAssessment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntraoperativeRecord" ADD CONSTRAINT "IntraoperativeRecord_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostoperativeRecord" ADD CONSTRAINT "PostoperativeRecord_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
