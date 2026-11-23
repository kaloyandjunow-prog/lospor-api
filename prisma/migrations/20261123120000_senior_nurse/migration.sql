-- The senior nurse role, and a nurse putting herself on a case. Added only: nothing existing changes.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ANAESTHESIA_SENIOR_NURSE';
ALTER TYPE "CaseNurseSource" ADD VALUE IF NOT EXISTS 'SELF';
