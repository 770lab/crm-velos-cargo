import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
  const body = await request.json();

  if (body.veloId && body.updates) {
    const velo = await prisma.velo.update({
      where: { id: body.veloId, clientId },
      data: body.updates,
    });
    return Response.json(velo);
  }

  if (body.bulkAction) {
    const action = body.bulkAction;
    const veloIds: string[] = body.veloIds || [];

    if (action === "marquer_certificat") {
      await prisma.velo.updateMany({
        where: { id: { in: veloIds }, clientId },
        data: { certificatRecu: true },
      });
    } else if (action === "marquer_photo_qr") {
      await prisma.velo.updateMany({
        where: { id: { in: veloIds }, clientId },
        data: { photoQrPrise: true },
      });
    } else if (action === "marquer_facturable") {
      await prisma.velo.updateMany({
        where: {
          id: { in: veloIds },
          clientId,
          photoQrPrise: true,
          certificatRecu: true,
        },
        data: { facturable: true },
      });
    } else if (action === "marquer_facture") {
      await prisma.velo.updateMany({
        where: { id: { in: veloIds }, clientId, facturable: true },
        data: { facture: true },
      });
    }

    return Response.json({ ok: true });
  }

  return Response.json({ error: "Action invalide" }, { status: 400 });
}
