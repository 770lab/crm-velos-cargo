import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const data: Record<string, unknown> = {};
  if (body.statut) data.statut = body.statut;
  if (body.datePrevue) data.datePrevue = new Date(body.datePrevue);
  if (body.dateEffective) data.dateEffective = new Date(body.dateEffective);
  if (body.notes !== undefined) data.notes = body.notes;

  const livraison = await prisma.livraison.update({ where: { id }, data });
  return Response.json(livraison);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.velo.updateMany({
    where: { livraisonId: id },
    data: { livraisonId: null },
  });
  await prisma.livraison.delete({ where: { id } });
  return Response.json({ ok: true });
}
