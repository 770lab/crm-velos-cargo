import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

export async function GET() {
  const clients = await prisma.client.findMany({
    where: {
      latitude: { not: null },
      longitude: { not: null },
    },
    select: {
      id: true,
      entreprise: true,
      ville: true,
      departement: true,
      adresse: true,
      codePostal: true,
      latitude: true,
      longitude: true,
      nbVelosCommandes: true,
      modeLivraison: true,
      telephone: true,
      email: true,
      kbisRecu: true,
      attestationRecue: true,
      signatureOk: true,
      inscriptionBicycle: true,
      devisSignee: true,
      _count: { select: { velos: true } },
      velos: {
        select: { photoQrPrise: true, certificatRecu: true },
      },
    },
  });

  return Response.json(
    clients.map((c) => ({
      id: c.id,
      entreprise: c.entreprise,
      ville: c.ville,
      departement: c.departement,
      adresse: c.adresse,
      codePostal: c.codePostal,
      lat: c.latitude,
      lng: c.longitude,
      nbVelos: c.nbVelosCommandes,
      modeLivraison: c.modeLivraison,
      telephone: c.telephone,
      email: c.email,
      docsComplets:
        c.kbisRecu && c.attestationRecue && c.signatureOk && c.devisSignee,
      velosLivres: c.velos.filter((v) => v.photoQrPrise).length,
    }))
  );
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { clientId, mode, maxDistance = 50 } = body;

  const allClients = await prisma.client.findMany({
    where: { latitude: { not: null }, longitude: { not: null } },
    select: {
      id: true,
      entreprise: true,
      ville: true,
      latitude: true,
      longitude: true,
      nbVelosCommandes: true,
      modeLivraison: true,
      velos: { select: { photoQrPrise: true } },
    },
  });

  const target = allClients.find((c) => c.id === clientId);
  if (!target || !target.latitude || !target.longitude) {
    return Response.json({ error: "Client non trouvé" }, { status: 404 });
  }

  const capacite = mode === "sursite" ? 54 : 6;

  const nearby = allClients
    .filter((c) => c.id !== clientId)
    .map((c) => ({
      ...c,
      distance: haversineKm(
        target.latitude!,
        target.longitude!,
        c.latitude!,
        c.longitude!
      ),
      velosRestants: c.nbVelosCommandes - c.velos.filter((v) => v.photoQrPrise).length,
    }))
    .filter((c) => c.distance <= maxDistance && c.velosRestants > 0)
    .sort((a, b) => a.distance - b.distance);

  const velosTarget =
    target.nbVelosCommandes -
    target.velos.filter((v) => v.photoQrPrise).length;
  let velosRestantsCamion = capacite - velosTarget;
  const tournee = [
    {
      id: target.id,
      entreprise: target.entreprise,
      ville: target.ville,
      lat: target.latitude,
      lng: target.longitude,
      nbVelos: velosTarget,
      distance: 0,
    },
  ];

  for (const c of nearby) {
    if (velosRestantsCamion <= 0) break;
    const velosAChercher = Math.min(c.velosRestants, velosRestantsCamion);
    tournee.push({
      id: c.id,
      entreprise: c.entreprise,
      ville: c.ville,
      lat: c.latitude!,
      lng: c.longitude!,
      nbVelos: velosAChercher,
      distance: Math.round(c.distance * 10) / 10,
    });
    velosRestantsCamion -= velosAChercher;
  }

  return Response.json({
    mode,
    capacite,
    tournee,
    totalVelos: tournee.reduce((s, c) => s + c.nbVelos, 0),
    clientsProches: nearby.slice(0, 20).map((c) => ({
      id: c.id,
      entreprise: c.entreprise,
      ville: c.ville,
      lat: c.latitude,
      lng: c.longitude,
      distance: Math.round(c.distance * 10) / 10,
      velosRestants: c.velosRestants,
    })),
  });
}
