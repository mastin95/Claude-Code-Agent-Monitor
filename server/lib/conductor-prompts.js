/**
 * @file Spanish instructions for the conductor lead, the programming collaborator and the
 *   pitch duel (each agent proposes the project before Martin mixes ideas and picks a lead).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
function leadPrompt(text) {
  return `Eres el jefe de proyecto. Martin ha pedido: ${text}
Planifica en pocas líneas y reparte el trabajo de programación al colaborador con la herramienta dashboard_handoff (to: codex).
Revisa lo que devuelva. Pide OK a Martin con dashboard_ask_user solo para decisiones que cambien el resultado o no se puedan deshacer.
Trabaja en la cwd del proyecto. Al terminar, resume en 3 líneas.
Expresa las ideas clave en líneas breves cuando corresponda:
[enfoque] Cómo vas a resolver el encargo.
[giro] Qué cambia respecto al plan y por qué.
[riesgo] Qué podría fallar o requiere una decisión de Martin.
[mejora] Qué mejora concreta propones.`;
}
function collaboratorPrompt(ask) {
  return `Encargo del jefe: ${ask}\nTrabaja en la cwd del proyecto. Al terminar, resume lo hecho, las comprobaciones y cualquier bloqueo.`;
}
const PITCH_DEPTH = {
  quick: "Hazlo rápido: 3 o 4 tarjetas y 1 maqueta.",
  normal: "Entre 5 y 7 tarjetas y 2 o 3 maquetas.",
  deep: "Ve a tope: hasta 8 tarjetas muy trabajadas y 3 maquetas cuidadas.",
};
function pitchPrompt(idea, depth = "normal") {
  return `Martin quiere crear esto: ${idea}

Antes de elegir quién dirige, tú y otro agente presentáis cada uno vuestra propuesta por separado. Martin verá las dos lado a lado y se quedará con las tarjetas que más le gusten de cada una, así que cada tarjeta debe tener sentido por sí sola.
Puedes leer la carpeta actual para entender el contexto, pero NO cambies ningún archivo ni ejecutes nada que modifique el sistema: solo propones.
${PITCH_DEPTH[depth] || PITCH_DEPTH.normal}
A Martin le gusta lo visual: estilo cómic o manga, colores vivos con contraste, letra gorda y poco texto. Frases cortas, en español.

Responde SOLO con un bloque \`\`\`json con este formato exacto:
{
  "name": "Nombre corto y con gancho de tu propuesta",
  "tagline": "Una frase que la resuma",
  "cards": [
    { "kind": "estilo", "title": "…", "body": "Cómo se ve y se siente", "swatches": ["#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB"] },
    { "kind": "pantallas", "title": "…", "body": "…", "screens": [ { "label": "Nombre de la pantalla", "html": "<div style=\\"…\\">…</div>" } ] },
    { "kind": "funciones", "title": "…", "items": ["Función breve", "…"] },
    { "kind": "plan", "title": "…", "steps": ["Fase 1: …", "Fase 2: …"] },
    { "kind": "tecnica", "title": "…", "body": "Con qué lo construirías y por qué, en 2 líneas" },
    { "kind": "toque", "title": "…", "body": "Tu idea especial, la que no se le ocurriría a otro" }
  ]
}
Tipos de tarjeta válidos: estilo, pantallas, funciones, plan, tecnica, toque, otra. Puedes repetir tipos.
Las maquetas ("html") son imágenes de cómo se vería cada pantalla: HTML con estilos en línea (style="…"), sin <script>, sin imágenes ni fuentes externas (usa emojis, formas CSS o SVG en línea), pensadas para 360 px de ancho y como mucho 640 px de alto. Que sean vistosas y usen los colores de tu estilo.`;
}
function describeCard(card) {
  const lines = [card.title, card.body].filter(Boolean);
  if (card.swatches?.length) lines.push(`Colores: ${card.swatches.join(", ")}`);
  if (card.items?.length) lines.push(...card.items.map((item) => `- ${item}`));
  if (card.steps?.length) lines.push(...card.steps.map((step, i) => `${i + 1}. ${step}`));
  for (const screen of card.screens || [])
    lines.push(
      `Maqueta «${screen.label}» (HTML de referencia):\n\`\`\`html\n${screen.html}\n\`\`\``
    );
  return lines.join("\n");
}
/** The order the chosen lead receives once Martin has mixed cards from both pitches. */
function mixOrderText({ idea, picks, note }) {
  const blocks = picks.map(
    ({ agent, pitchName, card }) =>
      `### ${card.kind.toUpperCase()} · de ${agent === "claude" ? "Claude" : "Codex"} («${pitchName}»)\n${describeCard(card)}`
  );
  return `${idea}

Claude y Codex presentaron cada uno una propuesta y Martin ha mezclado estas ideas. Constrúyelo con ellas:

${blocks.join("\n\n")}
${note ? `\nNota de Martin: ${note}\n` : ""}
Si dos ideas chocan (por ejemplo un estilo de una propuesta y las pantallas de la otra), adáptalas para que todo case y explícalo en una línea [giro].`;
}
module.exports = { leadPrompt, collaboratorPrompt, pitchPrompt, mixOrderText };
