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
// Groq gratis tiene un cupo diario de tokens POR MODELO, compartido con las otras apps de SB: si uno se agota (429) se
// pasa al siguiente. Para buscar se arranca por el grande, que es el más rápido con browser_search.
const MODELOS = [env.COMPRAS_MODELO || "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];
const MODELOS_BUSQUEDA = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const GEMINI_MODELO = env.COMPRAS_GEMINI || "gemini-3.8-flash";
const LIMITE_DIARIO = 200;
const hoyAR = () => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());
const diaAR = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
const texto = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : "";

async function sha256(t: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const SISTEMA = (hoy: string) => `Te llamás Frida: sos la asistente de "Mis Compras" (tu dibujito es una muñequita con flores en el pelo y vestido bordado de colores). Sos la ayudante de la app de una señora de Argentina que está empezando a comprar mercadería por mayor para revender. Hoy es ${hoy}.

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
- Usá SUS datos (te los paso abajo) cuando pregunte por sus productos, locales o notas. Si algo no está anotado, decíselo.

Buscador: tenés la herramienta buscar_en_internet, que busca en internet de verdad. Usala SIEMPRE que pregunte precios actuales, cuánto sale algo por mayor o por menor, dónde conseguir algo, mayoristas, direcciones, teléfonos, horarios o qué se está vendiendo. Escribí la búsqueda como en Google (corta, con "por mayor", "precio" y la zona si la dijo). Hacé UNA sola búsqueda por pregunta (es lenta): si necesitás comparar precio mayorista y de venta al público, poné las dos cosas en la misma búsqueda (ej.: "medias algodón precio docena por mayor y precio unidad Mercado Libre").
- Con los resultados, dale datos concretos: nombre del local o sitio, precio y presentación (por unidad, docena, pack). Nombrá de dónde sale cada precio. Si hay precio mayorista y de venta al público, calculale cuánto ganaría.
- Aclarale en una frase que los precios cambian seguido y conviene confirmarlos con el vendedor.
- NUNCA inventes precios, locales, direcciones ni teléfonos: si la búsqueda no los trae, decíselo y sugerile qué preguntar.
- No pegues las URLs en tu respuesta: la app ya le muestra los links de las fuentes debajo.

Acciones: podés proponer anotar cosas con las herramientas (nota, producto, local, marcar como comprado). Ella confirma con un botón, así que no digas que ya lo anotaste: decí que le dejaste el botón para guardarlo. Proponé una acción solo si ella lo pide o si está claro que le sirve (por ejemplo, te dicta un precio o un local). Los números van sin signo $ ni puntos de miles (ej. 12000).`;

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const HERRAMIENTAS = [
  fn("buscar_en_internet", "Busca en internet (Argentina) precios, mayoristas, locales, direcciones o cualquier dato actual. Devuelve resultados con sus fuentes.", {
    consulta: { type: "string", description: "Lo que buscarías en Google, ej: 'medias de algodón por mayor precio docena Once'" },
  }, ["consulta"]),
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

// Búsqueda web real con el buscador que Groq incorpora en gpt-oss (browser_search: busca y lee páginas). No se puede
// mezclar con herramientas propias en la misma llamada, por eso va aparte. Las URLs también se mandan a la app.
async function buscarEnInternet(consulta: string) {
  if (!consulta) return { texto: "Búsqueda vacía.", fuentes: [] as string[] };
  const pedido = `Hoy es ${hoyAR()}. Buscá en internet, en Argentina, y respondé en español con datos concretos y actuales, sin tablas. ` +
    `Hasta 6 resultados; para cada uno: nombre del local o vendedor, precio en pesos argentinos, presentación (unidad, docena, pack, mínimo de compra), ` +
    `zona o dirección si aparece, y la URL exacta. Preferí mayoristas, Mercado Libre y tiendas argentinas. ` +
    `No inventes nada: si no encontrás precios, decilo. Búsqueda: ${consulta}`;
  for (const model of MODELOS_BUSQUEDA) {
    try {
      const r = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: pedido }], temperature: 0.2, max_tokens: 2000, tools: [{ type: "browser_search" }], reasoning_effort: "low" }),
        signal: AbortSignal.timeout(25000),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) { console.warn("mis-compras búsqueda", model, r.status, JSON.stringify(d).slice(0, 300)); continue; }
      const m = d?.choices?.[0]?.message ?? {};
      const contenido = String(m.content ?? "").replace(/【[^】]*】/g, "");
      if (!contenido.trim()) { console.warn("mis-compras búsqueda vacía", model); continue; }
      const deHerramientas = (m.executed_tools ?? []).flatMap((t: any) => (t?.search_results?.results ?? []).map((x: any) => x?.url));
      const urls = [...contenido.matchAll(/https?:\/\/[^\s)\]>"'*,|]+/g)].map(x => x[0].replace(/[.;:]+$/, ""));
      const fuentes = [...new Set([...urls, ...deHerramientas].filter((u: unknown) => typeof u === "string" && u.startsWith("http")))].slice(0, 6) as string[];
      return { texto: contenido || "Sin resultados.", fuentes };
    } catch (e) { console.warn("mis-compras búsqueda", model, String(e)); }
  }
  // Último recurso: Google de verdad vía Gemini (clave compartida con poco cupo, por eso va al final).
  const clave = env.GEMINI_API_KEY_BS67 || env.GEMINI_API_KEY;
  if (clave) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELO}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": clave, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: pedido }] }], tools: [{ google_search: {} }] }),
        signal: AbortSignal.timeout(25000),
      });
      const d = await r.json().catch(() => null);
      if (r.ok) {
        const c = d?.candidates?.[0];
        const contenido = (c?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
        const fuentes = (c?.groundingMetadata?.groundingChunks ?? []).map((g: any) => g?.web?.uri).filter(Boolean).slice(0, 6);
        if (contenido.trim()) return { texto: contenido, fuentes };
      } else console.warn("mis-compras búsqueda gemini", r.status, JSON.stringify(d).slice(0, 300));
    } catch (e) { console.warn("mis-compras búsqueda gemini", String(e)); }
  }
  return { texto:"El buscador no respondió ahora. Decile que no pudiste buscar y que pruebe de nuevo en un rato.", fuentes: [] as string[] };
}

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
  let cual = 0;
  let ultimoError = 0;
  // Pide al primer modelo que ande, empezando por el último que funcionó.
  const pedirAlguno = async (msgs: unknown[], eleccion = "auto") => {
    for (; cual < MODELOS.length; cual++) {
      try {
        const r = await pedir(MODELOS[cual], msgs, eleccion);
        const d = await r.json().catch(() => null);
        if (r.ok) return d;
        ultimoError = r.status;
        console.warn("mis-compras IA", MODELOS[cual], r.status, JSON.stringify(d).slice(0, 250));
      } catch (e) { console.warn("mis-compras IA", MODELOS[cual], String(e)); }
    }
    return null;
  };
  const acciones: any[] = [];
  const busquedas: { consulta: string; fuentes: string[] }[] = [];
  let respuesta = "";
  let llamoHerramientas = false;
  let buscadas = 0;
  // Hasta 3 vueltas: el modelo puede buscar en internet, leer los resultados y volver a buscar antes de responder.
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const data = await pedirAlguno(messages);
    if (!data) {
      if (vuelta === 0) return { error: ultimoError === 429 ? "ocupado" : "ia" };
      break;
    }
    const m = data?.choices?.[0]?.message ?? {};
    respuesta = String(m.content ?? "").trim();
    const llamadas = m.tool_calls ?? [];
    if (!llamadas.length) break;
    llamoHerramientas = true;
    const resultados = await Promise.all(llamadas.map(async (t: any) => {
      let args: any = {};
      try { args = JSON.parse(t.function.arguments || "{}"); } catch {}
      if (t.function.name === "buscar_en_internet") {
        // Cada búsqueda tarda ~15 s: una por pregunta alcanza y la respuesta sale rápido.
        if (buscadas++) return "Ya buscaste: respondé con lo que encontraste.";
        const b = await buscarEnInternet(texto(args.consulta, 300));
        busquedas.push({ consulta: texto(args.consulta, 300), fuentes: b.fuentes });
        return b.texto;
      }
      acciones.push({ ...args, accion: t.function.name });
      return "Le mostré el botón para que lo confirme. Avisale que tiene el botón para guardarlo.";
    }));
    messages.push({ role: "assistant", content: m.content ?? "", tool_calls: llamadas } as any);
    llamadas.forEach((t: any, i: number) => messages.push({ role: "tool", tool_call_id: t.id, content: resultados[i] } as any));
    respuesta = "";
  }
  // Cuando usa herramientas el modelo a veces termina sin escribir nada: le pido la respuesta aparte, ya sin herramientas.
  if (!respuesta && llamoHerramientas) {
    messages.push({ role: "user", content: "Ahora respondeme con texto, usando lo que encontraste." });
    cual = Math.min(cual, MODELOS.length - 1);
    const d2 = await pedirAlguno(messages, "none");
    respuesta = String(d2?.choices?.[0]?.message?.content ?? "").trim();
  }
  return { texto: respuesta, acciones, busquedas };
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
