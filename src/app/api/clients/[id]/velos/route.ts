import { gasPost } from "@/lib/gas";
import { NextRequest } from "next/server";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: clientId } = await params;
  const body = await request.json();
  const result = await gasPost("updateVelos", { ...body, clientId });
  return Response.json(result);
}
