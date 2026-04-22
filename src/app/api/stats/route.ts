import { gasGet } from "@/lib/gas";

export async function GET() {
  const result = await gasGet("getStats");
  return Response.json(result);
}
