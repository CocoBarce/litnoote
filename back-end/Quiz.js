import OpenAI from "openai";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.join(__dirname, ".env") });

const MAX_INPUT_CHARACTERS = 20000;
const MAX_COMPLETION_TOKENS = 1400;
const REQUESTS_PER_MINUTE = 6;
const REQUESTS_PER_DAY = 60;
const quotaState = new Map();
const activeRequests = new Map();

function consumeQuota(identity) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const key = `${identity.user}:${identity.ip || "unknown"}`;
  const state = quotaState.get(key) || { minute: [], day, daily: 0 };
  state.minute = state.minute.filter(timestamp => now - timestamp < 60000);
  if (state.day !== day) {
    state.day = day;
    state.daily = 0;
  }
  if (state.minute.length >= REQUESTS_PER_MINUTE) {
    return { ok: false, message: "Demasiadas solicitudes. Esperá un minuto." };
  }
  if (state.daily >= REQUESTS_PER_DAY) {
    return { ok: false, message: "Alcanzaste el límite diario de generación." };
  }
  state.minute.push(now);
  state.daily += 1;
  quotaState.set(key, state);
  return { ok: true };
}

function extractKeywords(input) {
  const stopwords = new Set([
    "para", "como", "pero", "porque", "desde", "hasta", "entre", "sobre",
    "este", "esta", "estos", "estas", "tambien", "donde", "cuando", "quien",
    "cual", "unos", "unas", "del", "las", "los", "una", "que", "con", "por",
    "sus", "fue", "son", "se", "en", "de", "la", "el", "y"
  ]);
  const words = String(input || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z0-9]{4,}/g) || [];
  const counts = new Map();
  words.forEach(word => {
    if (!stopwords.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 12);
}

const FALLBACK_TEMPLATES = [
  (sentence, answer) => `¿Qué significa o define mejor "${answer}"?`,
  (sentence, answer) => `¿Cuál de estas opciones es un ejemplo de "${answer}"?`,
  (sentence, answer) => `Según el texto, ¿para qué sirve o se aplica "${answer}"?`,
  (sentence, answer) => `¿Qué relación tiene "${answer}" con el tema principal del texto?`,
  (sentence, _answer) => `¿Cuál de estas afirmaciones sobre el siguiente fragmento es correcta? "${sentence.slice(0, 100)}${sentence.length > 100 ? "…" : ""}"`,
];

function buildFallbackTrivia(input, count = 5, advanced = false) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?])\s+/).filter(sentence => sentence.length > 25);
  const keywords = extractKeywords(text);
  const generic = ["contexto", "proceso", "sociedad", "cambio", "historia", "concepto"];
  const trivia = Array.from({ length: count }, (_, index) => {
    const sentence = sentences[index % Math.max(sentences.length, 1)] || text;
    const answer = keywords[index % Math.max(keywords.length, 1)] || "contenido";
    const distractors = [...keywords, ...generic].filter(word => word !== answer).slice(0, 3);
    while (distractors.length < 3) distractors.push(generic[distractors.length]);
    const options = [
      { texto: answer, correcta: true },
      ...distractors.map(texto => ({ texto, correcta: false }))
    ].sort(() => Math.random() - 0.5);
    const template = FALLBACK_TEMPLATES[index % FALLBACK_TEMPLATES.length];
    return {
      pregunta: template(sentence, answer),
      ...(advanced ? { tema: answer } : {}),
      opciones: options
    };
  });
  return JSON.stringify({ trivia });
}

function normalizeTrivia(content, count, advanced) {
  const cleaned = String(content || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed.trivia) || parsed.trivia.length === 0) {
    throw new Error("La respuesta no contiene preguntas");
  }
  const trivia = parsed.trivia.slice(0, count).map((question, index) => {
    if (!question || typeof question.pregunta !== "string" || !Array.isArray(question.opciones)) {
      throw new Error(`Pregunta inválida en la posición ${index + 1}`);
    }
    const opciones = question.opciones.slice(0, 4).map(option => ({
      texto: String(option?.texto || ""),
      correcta: Boolean(option?.correcta)
    }));
    if (opciones.length < 2 || !opciones.some(option => option.correcta)) {
      throw new Error(`Opciones inválidas en la posición ${index + 1}`);
    }
    return {
      pregunta: question.pregunta,
      ...(advanced ? { tema: String(question.tema || "Tema general") } : {}),
      opciones
    };
  });
  return JSON.stringify({ trivia });
}

async function generateTrivia(socket, input, { count, advanced, eventName }, identity) {
  const source = String(input || "").trim();
  if (source.length < 20) {
    socket.emit("trivia-error", { mensaje: "Seleccioná un poco más de texto para crear el quiz." });
    return;
  }
  if (source.length > MAX_INPUT_CHARACTERS) {
    socket.emit("trivia-error", {
      mensaje: `El texto es demasiado largo. El máximo es ${MAX_INPUT_CHARACTERS.toLocaleString("es-AR")} caracteres.`
    });
    return;
  }
  const quota = consumeQuota(identity);
  if (!quota.ok) {
    socket.emit("trivia-error", { mensaje: quota.message });
    return;
  }
  const identityKey = `${identity.user}:${identity.ip || "unknown"}`;
  const active = activeRequests.get(identityKey) || 0;
  if (active >= 2) {
    socket.emit("trivia-error", { mensaje: "Ya hay generaciones en curso. Esperá a que terminen." });
    return;
  }
  activeRequests.set(identityKey, active + 1);

  try {
    const apiKey = process.env.OPENAI_API_KEY || process.env.API;
    if (!apiKey) throw new Error("API key ausente");
    const openai = new OpenAI({ apiKey, timeout: 20000, maxRetries: 1 });
    const diversityRule = `REGLAS DE VARIEDAD (obligatorias):
- Cada pregunta debe ser de un tipo distinto. Tipos disponibles: DEFINICIÓN ("¿Qué es/significa X?"), EJEMPLO ("¿Cuál es un ejemplo de X?"), APLICACIÓN ("¿Para qué sirve / en qué situación se usa X?"), RELACIÓN ("¿Cómo se relaciona X con Y?"), AFIRMACIÓN ("¿Cuál de estas afirmaciones sobre el texto es correcta?").
- No repitas el mismo tipo en la misma trivia.
- Las opciones incorrectas deben ser plausibles, no obvias.
- Cubrí ideas distintas del texto, no el mismo concepto en todas las preguntas.`;

    const prompt = advanced
      ? `${source}

${diversityRule}

Generá una trivia avanzada de ${count} preguntas con 4 opciones. Cada pregunta debe incluir "tema" (el concepto principal que evalúa).
Respondé únicamente JSON:
{"trivia":[{"pregunta":"string","tema":"string","opciones":[{"texto":"string","correcta":true},{"texto":"string","correcta":false},{"texto":"string","correcta":false},{"texto":"string","correcta":false}]}]}`
      : `${source}

${diversityRule}

Generá una trivia de ${count} preguntas con 4 opciones.
Respondé únicamente JSON:
{"trivia":[{"pregunta":"string","opciones":[{"texto":"string","correcta":true},{"texto":"string","correcta":false},{"texto":"string","correcta":false},{"texto":"string","correcta":false}]}]}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_completion_tokens: MAX_COMPLETION_TOKENS
    });
    socket.emit(eventName, {
      trivia: normalizeTrivia(response.choices[0]?.message?.content, count, advanced),
      fallback: false
    });
  } catch (error) {
    console.error("La IA no pudo generar la trivia; usando respaldo local:", error.message);
    socket.emit(eventName, {
      trivia: buildFallbackTrivia(source, count, advanced),
      fallback: true
    });
  } finally {
    const remaining = Math.max(0, (activeRequests.get(identityKey) || 1) - 1);
    if (remaining === 0) activeRequests.delete(identityKey);
    else activeRequests.set(identityKey, remaining);
  }
}

export function funcionn(socket, input, identity) {
  generateTrivia(socket, input, { count: 5, advanced: false, eventName: "trivia-generada" }, identity);
}

export function funcionAdvanced(socket, input, identity) {
  generateTrivia(socket, input, { count: 10, advanced: true, eventName: "trivia-avanzada-generada" }, identity);
}
