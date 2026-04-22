-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entreprise" TEXT NOT NULL,
    "contact" TEXT,
    "email" TEXT,
    "telephone" TEXT,
    "adresse" TEXT,
    "ville" TEXT,
    "codePostal" TEXT,
    "nbVelosCommandes" INTEGER NOT NULL DEFAULT 0,
    "kbisRecu" BOOLEAN NOT NULL DEFAULT false,
    "attestationRecue" BOOLEAN NOT NULL DEFAULT false,
    "signatureOk" BOOLEAN NOT NULL DEFAULT false,
    "inscriptionBicycle" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Velo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reference" TEXT,
    "qrCode" TEXT,
    "certificatRecu" BOOLEAN NOT NULL DEFAULT false,
    "certificatNumero" TEXT,
    "photoQrPrise" BOOLEAN NOT NULL DEFAULT false,
    "facturable" BOOLEAN NOT NULL DEFAULT false,
    "facture" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT NOT NULL,
    "livraisonId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Velo_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Velo_livraisonId_fkey" FOREIGN KEY ("livraisonId") REFERENCES "Livraison" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Livraison" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "datePrevue" DATETIME,
    "dateEffective" DATETIME,
    "statut" TEXT NOT NULL DEFAULT 'planifiee',
    "notes" TEXT,
    "clientId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Livraison_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Velo_qrCode_key" ON "Velo"("qrCode");
