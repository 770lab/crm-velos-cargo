const GAS_URL = process.env.NEXT_PUBLIC_GAS_URL || "";

export async function gasGet(action: string, params?: Record<string, string>) {
  const url = new URL(GAS_URL);
  url.searchParams.set("action", action);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), { cache: "no-store" });
  return res.json();
}

export async function gasPost(action: string, body: unknown) {
  const url = new URL(GAS_URL);
  url.searchParams.set("action", action);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
