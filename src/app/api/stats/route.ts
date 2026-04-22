import { prisma } from "@/lib/prisma";

export async function GET() {
  const [
    totalClients,
    totalVelos,
    velosLivres,
    certificatsRecus,
    velosFacturables,
    velosFactures,
    clientsDocsComplets,
    livraisons,
  ] = await Promise.all([
    prisma.client.count(),
    prisma.velo.count(),
    prisma.velo.count({ where: { photoQrPrise: true } }),
    prisma.velo.count({ where: { certificatRecu: true } }),
    prisma.velo.count({ where: { facturable: true } }),
    prisma.velo.count({ where: { facture: true } }),
    prisma.client.count({
      where: {
        kbisRecu: true,
        attestationRecue: true,
        signatureOk: true,
      },
    }),
    prisma.livraison.groupBy({
      by: ["statut"],
      _count: true,
    }),
  ]);

  const livraisonsParStatut = Object.fromEntries(
    livraisons.map((l) => [l.statut, l._count])
  );

  return Response.json({
    totalClients,
    totalVelos,
    velosLivres,
    certificatsRecus,
    velosFacturables,
    velosFactures,
    clientsDocsComplets,
    progression: totalVelos > 0 ? Math.round((velosLivres / totalVelos) * 100) : 0,
    livraisonsParStatut,
  });
}
