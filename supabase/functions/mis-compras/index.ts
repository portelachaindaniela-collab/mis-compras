import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Asistente de Mis Compras (la app de la mamá para comprar por mayor). Sin cuentas: la app guarda un código largo al azar
// que llega en el link; acá solo se compara su SHA-256 con compras_acceso. Las tablas no tienen políticas RLS, así que solo
// esta función (service role) las lee y escribe.

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const env = Deno.env.toObject();
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELO = env.COMPRAS_MODELO || "openai/gpt-oss-120b";
const RESPALDO = "llama-3.3-70b-versatile";
const LIMITE_DIARIO = 200;
const hoyAR = () => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
const diaAR = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
const texto = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : "";

async function sha256(t: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const SISTEMA = (hoy: string) => `Sos el asistente de "Mis Compras", la app de una señora de Argentina que está empezando a comprar mercadería por mayor para revender. Hoy es ${hoy}.

Cómo hablás:
- Español rioplatense, cálido y respetuoso (vos, tenés). Como una amiga que sabe de comercio y le explica con paciencia.
- Frases cortas y claras, sin palabras técnicas ni en inglés (nada de "margen bruto", "markup", "stock": decí "ganancia", "lo que te queda", "mercadería"). Si usás una palabra difícil, explicala.
- Respuestas cortas: unas 80 a 120 palabras salvo que pida más. Usá listas cortas cuando ayuden. Sin títulos ni tablas.
- Si la pregunta no se entiende, preguntá una sola cosa para aclarar.

Cuentas — tenés que hacerlas perfectas:
- Costo por unidad = precio del bulto ÷ unidades del bulto. Ganancia por unidad = precio de venta − costo por unidad. Ganancia del bulto = ganancia por unidad × unidades. Porcentaje de ganancia = ganancia por unidad ÷ costo por unidad × 100.
- Hacé las cuentas paso a paso en tu cabeza y revisalas antes de responder. Mostrale la cuenta de forma simple (ej.: "$12.000 ÷ 12 = $1.000 cada una").
- Escribí la plata como en Argentina: $12.000, $1.250,50. Redondeá precios de venta sugeridos a números cómodos (terminados en 0 o 50).
- Recordale, cuando venga al caso, sumar gastos que se olvidan: viaje/envío, bolsas o packaging, comisiones de Mercado Pago o tarjeta.

En qué la ayudás: qué comprar para revender, cómo ponerle precio, cuánto comprar para empezar sin arriesgar mucha plata, cómo comparar locales, qué preguntar al mayorista (compra mínima, si se puede mezclar talles/colores, formas de pago, si hacen factura, cambios), dónde suele haber mayoristas en Argentina (por ejemplo Once, Avellaneda/Flores y La Salada en Buenos Aires) y cómo vender (WhatsApp, Instagram, Marketplace, ferias, conocidos).
- No inventes precios actuales, direcciones exactas ni teléfonos de locales reales: si no los tenés en sus datos, decile que no los sabés con seguridad y qué podría preguntar o buscar.
- Usá SUS datos (te los paso abajo) cuando pregunte por sus productos, locales o notas. Si algo no está anotado, decíselo.

Acciones: podés proponer anotar cosas con las herramientas (nota, producto, local, marcar como comprado). Ella confirma con un botón, así que no digas que ya lo anotaste: decí que le dejaste el botón para guardarlo. Proponé una acción solo si ella lo pide o si está claro que le sirve (por ejemplo, te dicta un precio o un local). Los números van sin signo $ ni puntos de miles (ej. 12000).`;

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const HERRAMIENTAS = [
  fn("agregar_nota", "Propone guardar una nota.", { texto: { type: "string" } }, ["texto"]),
  fn("agregar_producto", "Propone anotar un producto que busca para vender.", {
    nombre: { type: "string" }, bulto: { type: "number", description: "Precio del bulto o paquete, en pesos" },
    unidades: { type: "number", description: "Unidades que trae el bulto" }, venta: { type: "number", description: "Precio de venta por unidad, en pesos" },
    local: { type: "string", description: "Nombre del local donde se compra, tal como está en sus locales" }, nota: { type: "string" },
  }, ["nombre"]),
  fn("agregar_local", "Propone anotar un local mayorista.", {
    nombre: { type: "string" }, vende: { type: "string" }, direccion: { type: "string" }, telefono: { type: "string" }, nota: { type: "string" },
  }, ["nombre"]),
  fn("marcar_comprado", "Propone marcar un producto suyo como ya comprado.", { nombre: { type: "string", description: "Nombre del producto tal como está anotado" } }, ["nombre"]),
];

async function preguntar(codigoHash: string, body: any) {
  const dia = diaAR();
  const { data: uso } = await db.from("compras_uso").select("cantidad").eq("codigo_hash", codigoHash).eq("dia", dia).maybeSingle();
  if ((uso?.cantidad ?? 0) >= LIMITE_DIARIO) return { texto: "Por hoy ya charlamos muchísimo. ¡Mañana sigo ayudándote! 😊", acciones: [] };
  await db.from("compras_uso").upsert({ codigo_hash: codigoHash, dia, cantidad: (uso?.cantidad ?? 0) + 1 });
  if (!env.GROQ_API_KEY) return { error: "ia" };

  const historial = (Array.isArray(body.historial) ? body.historial : []).slice(-16)
    .filter((m: any) => (m?.rol === "user" || m?.rol === "assistant") && typeof m.texto === "string" && m.texto)
    .map((m: any) => ({ role: m.rol, content: m.texto.slice(0, 3000) }));
  const pregunta = texto(body.mensaje, 4000).trim();
  if (!pregunta) return { error: "vacio" };

  const messages = [
    { role: "system", content: SISTEMA(hoyAR()) },
    { role: "system", content: "Sus datos anotados en la app ahora:\n" + (texto(body.contexto, 12000) || "(todavía no anotó nada)") },
    ...historial,
    { role: "user", content: pregunta },
  ];
  const pedir = (model: string, msgs: unknown[], eleccion = "auto") => fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: msgs, temperature: 0.4, max_tokens: 2000, tools: HERRAMIENTAS, tool_choice: eleccion }),
    signal: AbortSignal.timeout(45000),
  });
  let modelo = MODELO;
  let r = await pedir(modelo, messages);
  if (!r.ok && r.status !== 429) { console.warn("mis-compras: falla", modelo, r.status, (await r.text()).slice(0, 300)); modelo = RESPALDO; r = await pedir(modelo, messages); }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    console.error("mis-compras IA", r.status, JSON.stringify(data).slice(0, 400));
    return { error: r.status === 429 ? "ocupado" : "ia" };
  }
  const m = data?.choices?.[0]?.message ?? {};
  const llamadas = m.tool_calls ?? [];
  const acciones = llamadas.map((t: any) => {
    try { return { ...JSON.parse(t.function.arguments || "{}"), accion: t.function.name }; } catch { return null; }
  }).filter(Boolean);
  let respuesta = String(m.content ?? "").trim();
  // Cuando propone una acción el modelo suele no escribir nada: le pido la explicación aparte.
  if (!respuesta && llamadas.length) {
    const seguir = [...messages, { role: "assistant", content: "", tool_calls: llamadas },
      ...llamadas.map((t: any) => ({ role: "tool", tool_call_id: t.id, content: "Le mostré el botón para que lo confirme. Ahora respondele con texto (con las cuentas si hay) y avisale que tiene el botón para guardarlo." }))];
    const r2 = await pedir(modelo, seguir, "none");
    const d2 = await r2.json().catch(() => null);
    respuesta = String(d2?.choices?.[0]?.message?.content ?? "").trim();
  }
  return { texto: respuesta, acciones };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "metodo" }, 405);
  const body = await req.json().catch(() => null);
  const codigo = body?.codigo;
  if (typeof codigo !== "string" || codigo.length < 16 || codigo.length > 100) return json({ error: "codigo" }, 401);
  const hash = await sha256(codigo);
  const { data: acceso } = await db.from("compras_acceso").select("codigo_hash").eq("codigo_hash", hash).maybeSingle();
  if (!acceso) return json({ error: "codigo" }, 401);
  if (body.accion === "probar") return json({ ok: true });
  if (body.accion !== "preguntar") return json({ error: "accion" }, 400);
  try {
    return json(await preguntar(hash, body));
  } catch (e) {
    console.error("mis-compras", e);
    return json({ error: "ia" }, 500);
  }
});
