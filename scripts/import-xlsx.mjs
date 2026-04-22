import { fileURLToPath } from "url";
import { dirname, join } from "path";
import XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const dbPath = join(projectRoot, "prisma", "dev.db");
const adapter = new PrismaLibSql({ url: `file:${dbPath}` });
const prisma = new PrismaClient({ adapter });

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/import-xlsx.mjs <fichier.xlsx>");
  process.exit(1);
}

const wb = XLSX.readFile(filePath);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

const header = rows[0];
const dataRows = rows.slice(1).filter((r) => r.length > 0);

console.log(`${dataRows.length} lignes à importer...`);

let importedClients = 0;
let importedVelos = 0;
let skipped = 0;

for (const row of dataRows) {
  const entreprise = String(row[15] || "").trim();
  if (!entreprise) {
    skipped++;
    continue;
  }

  const nbVelos = parseInt(row[14]);
  if (isNaN(nbVelos) || nbVelos <= 0 || nbVelos > 10000) {
    skipped++;
    continue;
  }

  const siren = row[18] ? String(row[18]).trim() : null;
  const operationNumero = row[0] ? String(row[0]).trim() : null;
  const referenceOperation = row[3] ? String(row[3]).trim() : null;
  const apporteur = row[16] ? String(row[16]).trim() : null;
  const adresse = row[19] ? String(row[19]).trim() : null;
  const codePostal = row[20] ? String(row[20]).trim() : null;
  const departement = row[21] ? String(row[21]).trim() : null;
  const ville = row[22] ? String(row[22]).trim() : null;
  const telephone = row[23] ? String(row[23]).trim() : null;
  const email = row[24] ? String(row[24]).trim() : null;
  const devisSignee = String(row[35] || "").trim().toUpperCase() === "OUI";

  const client = await prisma.client.create({
    data: {
      entreprise,
      siren,
      email,
      telephone,
      adresse,
      ville,
      codePostal,
      departement,
      nbVelosCommandes: nbVelos,
      operationNumero,
      referenceOperation,
      apporteur,
      devisSignee,
      signatureOk: devisSignee,
    },
  });

  const prefix = entreprise
    .substring(0, 4)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "X");
  const velosData = Array.from({ length: nbVelos }, (_, i) => ({
    clientId: client.id,
    reference: `${prefix}-${String(i + 1).padStart(4, "0")}`,
  }));

  await prisma.velo.createMany({ data: velosData });

  importedClients++;
  importedVelos += nbVelos;

  if (importedClients % 50 === 0) {
    console.log(
      `  ${importedClients} clients, ${importedVelos} vélos importés...`
    );
  }
}

console.log(`\nImport terminé :`);
console.log(`  ${importedClients} clients créés`);
console.log(`  ${importedVelos} vélos créés`);
console.log(`  ${skipped} lignes ignorées`);

await prisma.$disconnect();
