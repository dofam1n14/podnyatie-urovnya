// Посредник для онлайн-рейтинга: приложение обращается к нашему сайту (podnyatie-urovnya.pages.dev/sb/…),
// а Cloudflare уже сам ходит в Supabase. Нужен тем, у кого провайдер или блокировщик
// не пускает к supabase.co напрямую. Работает как Cloudflare Pages Function.
const SB = "https://jhoqjypixkilfnshonmk.supabase.co/rest/v1/";
const KEY = "sb_publishable_UtLoaxB21zedKXUD0wberQ_ozjqaE1D"; // публичный ключ (тот же, что у калькулятора)
// Пропускаем только то, что нужно рейтингу: витрину для чтения и три функции базы
const ALLOWED = /^(sys_leaderboard|rpc\/(sys_check_nick|sys_submit|sys_leave))$/;

// Android-приложение открывается с адреса https://localhost, поэтому разрешаем запросы с других адресов
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequest({ request, params }) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = [].concat(params.path || []).join("/");
  if (!ALLOWED.test(path)) return new Response("Not found", { status: 404, headers: CORS });
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
  const body = request.method === "POST" ? await request.text() : undefined;
  if (body && body.length > 2000) return new Response("Too large", { status: 413, headers: CORS });
  const r = await fetch(SB + path + new URL(request.url).search, {
    method: request.method,
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body,
  });
  return new Response(r.body, {
    status: r.status,
    headers: { ...CORS, "Content-Type": r.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store" },
  });
}
