-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entreprise" TEXT NOT NULL,
    "siren" TEXT,
    "contact" TEXT,
    "email" TEXT,
    "telephone" TEXT,
    "adresse" TEXT,
    "ville" TEXT,
    "codePostal" TEXT,
    "departement" TEXT,
    "nbVelosCommandes" INTEGER NOT NULL DEFAULT 0,
    "operationNumero" TEXT,
    "referenceOperation" TEXT,
    "apporteur" TEXT,
    "devisSignee" BOOLEAN NOT NULL DEFAULT false,
    "kbisRecu" BOOLEAN NOT NULL DEFAULT false,
    "attestationRecue" BOOLEAN NOT NULL DEFAULT false,
    "signatureOk" BOOLEAN NOT NULL DEFAULT false,
    "inscriptionBicycle" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Client" ("adresse", "attestationRecue", "codePostal", "contact", "createdAt", "email", "entreprise", "id", "inscriptionBicycle", "kbisRecu", "nbVelosCommandes", "notes", "signatureOk", "telephone", "updatedAt", "ville") SELECT "adresse", "attestationRecue", "codePostal", "contact", "createdAt", "email", "entreprise", "id", "inscriptionBicycle", "kbisRecu", "nbVelosCommandes", "notes", "signatureOk", "telephone", "updatedAt", "ville" FROM "Client";
DROP TABLE "Client";
ALTER TABLE "new_Client" RENAME TO "Client";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
