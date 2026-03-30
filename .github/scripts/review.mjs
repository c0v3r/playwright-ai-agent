const GH_TOKEN   = process.env.GITHUB_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const [owner, repo] = process.env.REPO.split('/');
const prNumber   = process.env.PR_NUMBER;
const commitId   = process.env.HEAD_SHA;

const ghHeaders = {
  Authorization:  `Bearer ${GH_TOKEN}`,
  Accept:         'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
};

// ── 1. Obtener archivos cambiados ──────────────────────────────────────────
const filesRes = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
  { headers: ghHeaders }
);
const files = await filesRes.json();

const tsFiles = files.filter(f =>
  (f.filename.endsWith('.ts') || f.filename.endsWith('.tsx')) && f.patch
);

if (tsFiles.length === 0) {
  console.log('No hay archivos TypeScript en este PR. Nada que revisar.');
  process.exit(0);
}

const codeContext = tsFiles
  .map(f => `=== FILE: ${f.filename} ===\n${f.patch}`)
  .join('\n\n');

// ── 2. Prompt ──────────────────────────────────────────────────────────────
const prompt = `
Sos un Senior QA Architect con expertise en Playwright y TypeScript.
Analizá el siguiente diff y detectá TODAS las violaciones a estas reglas.

## REGLAS

### Playwright
- PROHIBIDO: waitForTimeout(), sleep(), setTimeout() como workaround de timing
- USAR en su lugar: waitForSelector, waitForResponse, waitForLoadState, expect().toBeVisible()
- PROHIBIDO: selectores CSS/XPath frágiles (.btn-primary, #submit, //div[@class])
- USAR en su lugar: getByRole(), getByTestId(), getByLabel(), getByText()
- PROHIBIDO: URLs y credenciales hard-coded en tests
- REQUERIDO: setup/teardown en beforeEach/afterEach, nunca inline en el test
- REQUERIDO: cada test debe ser 100% independiente, sin estado compartido

### TypeScript
- PROHIBIDO: el tipo 'any' (usar unknown, tipos específicos o generics)
- PROHIBIDO: variables de una sola letra salvo i/j/k en loops
- REQUERIDO: camelCase en variables y funciones
- REQUERIDO: PascalCase en clases e interfaces
- PROHIBIDO: magic numbers y magic strings sueltos (extraer a constantes nombradas)
- PROHIBIDO: console.log() en código de tests
- REQUERIDO: tipado explícito en parámetros y retorno de funciones públicas
- REQUERIDO: funciones con una única responsabilidad (máx ~20 líneas)

### Arquitectura (Page Object Model)
- PROHIBIDO: interacciones con la UI directamente en archivos *.spec.ts
- REQUERIDO: toda interacción en Page Objects (*Page.ts, *PO.ts)
- REQUERIDO: los specs solo deben tener lógica de negocio y assertions
- PROHIBIDO: selectores duplicados entre distintos tests

### Assertions
- PROHIBIDO: assertions triviales tipo expect(true).toBe(true)
- REQUERIDO: assertions semánticas de Playwright (toBeVisible, toHaveText, toHaveURL...)
- REQUERIDO: mensaje descriptivo en assertions críticas

## FORMATO DE RESPUESTA
Respondé ÚNICAMENTE con JSON válido, sin markdown ni texto extra:

{
  "summary": "Resumen del PR en 2-3 oraciones",
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "comments": [
    {
      "path": "ruta/del/archivo.ts",
      "line": <número de línea exacto donde está el problema en el archivo>,
      "severity": "error" | "warning" | "suggestion",
      "rule": "nombre de la regla violada",
      "body": "**Problema:** descripción\\n\\n**Por qué importa:** impacto\\n\\n**Cómo corregirlo:**\\n\`\`\`typescript\\ncódigo correcto\\n\`\`\`"
    }
  ]
}

Solo comentá líneas que aparezcan con '+' en el diff.
Si un archivo no tiene violaciones, no lo incluyas en comments.

## DIFF:
${codeContext}
`;

// ── 3. Llamar a Gemini ─────────────────────────────────────────────────────
const geminiRes = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_KEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    }),
  }
);

const geminiData = await geminiRes.json();

if (!geminiRes.ok) {
  console.error('Error en Gemini API:', JSON.stringify(geminiData, null, 2));
  process.exit(1);
}

const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
let review;
try {
  review = JSON.parse(rawText);
} catch {
  const match = rawText.match(/\{[\s\S]*\}/);
  if (match) {
    review = JSON.parse(match[0]);
  } else {
    console.error('No se pudo parsear la respuesta de Gemini:\n', rawText);
    process.exit(1);
  }
}

console.log(`Veredicto: ${review.verdict}`);
console.log(`Comentarios generados: ${review.comments?.length ?? 0}`);

// ── 4. Mapear líneas → posición en el diff ─────────────────────────────────
const buildPositionMap = (patch) => {
  const map = {};
  let position = 0;
  let currentLine = 0;
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      currentLine = parseInt(hunk[1]) - 1;
      position++;
      continue;
    }
    if (!line.startsWith('-')) currentLine++;
    position++;
    if (line.startsWith('+')) map[currentLine] = position;
  }
  return map;
};

const positionMaps = {};
for (const f of tsFiles) {
  positionMaps[f.filename] = buildPositionMap(f.patch);
}

// ── 5. Validar comentarios ─────────────────────────────────────────────────
const validComments = (review.comments ?? [])
  .map(c => {
    const pos = positionMaps[c.path]?.[c.line];
    if (!pos) {
      console.warn(`Omitido: ${c.path}:${c.line} no está en el diff`);
      return null;
    }
    return { path: c.path, position: pos, body: c.body };
  })
  .filter(Boolean);

// ── 6. Postear review en GitHub ────────────────────────────────────────────
const severity = review.comments?.some(c => c.severity === 'error')
  ? 'errores encontrados'
  : 'solo advertencias / sugerencias';

const reviewPayload = {
  commit_id: commitId,
  body: [
    '## AI Senior QA Architect',
    '',
    review.summary,
    '',
    `> **Veredicto:** \`${review.verdict}\` — ${severity}`,
    '',
    '---',
    '*Powered by Gemini 2.0 Flash · [ai-senior-reviewer workflow]*',
  ].join('\n'),
  event:
    review.verdict === 'APPROVE'         ? 'APPROVE'         :
    review.verdict === 'REQUEST_CHANGES' ? 'REQUEST_CHANGES' : 'COMMENT',
  comments: validComments,
};

const postRes = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
  { method: 'POST', headers: ghHeaders, body: JSON.stringify(reviewPayload) }
);

const postData = await postRes.json();
if (!postRes.ok) {
  console.error('Error al postear el review:', JSON.stringify(postData, null, 2));
  process.exit(1);
}

console.log('Review posteado exitosamente.');
console.log(`URL: ${postData.html_url}`);