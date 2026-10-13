# Muro: especificación

Muro es una pestaña nueva del dashboard que enseña el trabajo de Claude y Codex solo con gráficos: dos muñecos, un kanban de post-its ilustrados y gráficas de uso.

- **Diseño de referencia:** [`design/muro/muro.html`](./muro.html). Ábrelo en el navegador. Es un prototipo con datos de ejemplo dentro del menú real de la app; el botón "Notas de diseño" muestra u oculta las notas numeradas que explican cada pieza.
- **Reparto:** Claude diseña y revisa que cada PR se vea como el prototipo. Codex escribe el código a partir de los issues del fork. Martin aprueba cada cambio.
- **Colores fijos de los agentes en las gráficas (modo oscuro):** Claude `#D46F3A`, Codex `#2BA394`.

## 1. Qué es un post-it

Cada post-it es una **sesión** de la app con `provider` igual a `claude` o `codex`. Las sesiones de Cursor no salen en el Muro. La columna sale del estado que ya guarda la app; no hacen falta tablas nuevas.

| Columna         | Regla con datos reales                                                     | Papel del post-it                                 |
| --------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| Trabajando      | `status === "active"` y `!isSessionAwaitingInput(session)`                 | Color del agente: Claude `#FFCFB0`, Codex `#AEE8DE` |
| Esperando mi OK | `isSessionAwaitingInput(session)` (`client/src/lib/types.ts`)               | Amarillo `#F6E7A6`                                |
| Hecho           | `status === "completed"` y `ended_at` dentro del periodo elegido            | Color del agente                                  |

- **Título:** `session.name`; si está vacío, `card_prompt_preview` recortado a unas 40 letras. Letra Caveat.
- **Etiqueta** (esquina superior izquierda):
  - Trabajando: "Limpiando" (Claude) o "Construyendo" (Codex).
  - Esperando: el motivo de `awaiting_reason` (`notification` = "Pide permiso", `interrupted` = "Interrumpida", `stop` = "Te toca", `session_start` = "Recién abierta"). Fondo rojo cuando `AWAITING_REASON_CONFIG[reason].urgent` es cierto.
  - Hecho: "Hecho HH:MM" con la hora de `ended_at`.
- **Pie:** nombre del agente, duración (`ended_at` o ahora, menos `started_at`) y tokens de la sesión.
- **Barra de progreso:** solo si la sesión trae lista de tareas (`include_task_progress`). Si no, no se pinta. No se inventa progreso.
- **Nada se arrastra.** Los post-its cambian de columna solos cuando cambia el estado, con la transición FLIP del prototipo (`flip()`), y al pasar a Hecho sueltan confeti (`celebrate()`).
- Las sesiones `error` o `abandoned` no salen en el kanban, pero sí cuentan en tokens y tiempo.
- Cada sesión es una tarea; los subagentes no cuentan como tareas aparte.
- Columnas vacías: "Nadie trabajando ahora", "Nada pendiente de tu OK", "Aún no hay nada hecho".

En Claude Code una sesión sigue `active` hasta que se cierra y, tras cada respuesta, queda esperando con motivo `stop`. Por eso "Esperando mi OK" será la columna más llena.

## 2. Muñecos

Un solo componente SVG, `<Mascot agent mode size reducedMotion />`, que porta la función `mascot()` del prototipo y anima solo con CSS (keyframes del prototipo: `breathe`, `blinkEye`, `sweep`, `dust`, `wiggle`, `hammer`, `spark`, `thump`, `brick`, `zz`, `hop`). Sigue el patrón de `client/src/components/Tabby/CatAvatar.tsx`.

| `mode`  | Claude                                             | Codex                                                |
| ------- | -------------------------------------------------- | ---------------------------------------------------- |
| `sweep` / `build` (trabajando) | Barre con escoba, sale polvo, se balancea | Martillea, saltan chispas, cae un ladrillo nuevo |
| `wait`  | Boca recta y "zz" flotando                          | Boca recta y "zz" flotando                            |
| `done`  | Saluda y sostiene un pincel; saltito al pasar el ratón | Saluda y sostiene una llave inglesa; saltito al pasar el ratón |
| siempre | Respira y parpadea                                   | Respira y parpadea                                    |

- **Escenario** (arriba del Muro): una tarjeta por agente con el muñeco grande (unos 104 px), un bocadillo con lo que hace ahora ("Limpiando: …", o "Esperando trabajo…" si no tiene sesión trabajando) y sus números de hoy. Tocar una tarjeta filtra todo el Muro por ese agente; tocarla otra vez quita el filtro.
- Con `prefers-reduced-motion` se paran todas las animaciones y el muñeco queda quieto.

## 3. Al pinchar un post-it

El post-it crece hasta una ficha grande del mismo color (animación de `openBig()` en el prototipo). Esc, la X o pinchar fuera la cierran y vuelve a su sitio con la animación inversa. El foco vuelve al post-it.

| Bloque                                  | Fuente                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Muñeco, agente, estado y título          | La propia sesión                                                                                |
| "Lo que pediste"                         | `card_prompt_preview`                                                                           |
| Duración, tokens y número de archivos    | `GET /api/sessions/:id/stats` (`tokens`, rango de eventos) y `files_touched`                     |
| Herramientas usadas (veces)              | `tools_used` de ese endpoint, barras horizontales por número de usos                            |
| Archivos tocados                         | Campo nuevo `files_touched`: rutas únicas de `tool_input.file_path` en eventos `PreToolUse` de `Edit`, `Write` y `MultiEdit`, máximo 50 |
| "Ver sesión completa →"                  | Ruta existente `/sessions/:id`                                                                  |

La ficha se carga al abrirla, con esqueleto mientras llega y mensaje de error si falla.

## 4. Cabecera, cifras y gráficas

- **Cabecera:** título "Muro", pastilla "En vivo" (estado del WebSocket, como el Kanban) y selector Hoy / 7 días / 30 días, que cambia todo el Muro.
- **Cuatro cifras** con contador animado y una barrita bajo el número con el reparto Claude / Codex:
  - Tareas completadas.
  - Tokens usados.
  - Tiempo trabajado.
  - Racha (días seguidos con al menos una tarea completada).
- **Quién ha hecho qué:** donut de tareas completadas por agente. Pasar por la leyenda atenúa los post-its del otro agente; pinchar filtra.
- **Ritmo:** barras apiladas por agente; por hora con "Hoy", por día con "7 días", cada 3 días con "30 días". Tooltip con el reparto.
- **Últimas 5 semanas:** mapa de calor de tareas completadas por día, hoy remarcado. Tooltip con fecha y número.

### Endpoint nuevo: `GET /api/muro/summary`

Parámetros: `period` (`today` | `7d` | `30d`, por defecto `today`) y `tz_offset` (minutos, igual que `/api/analytics`). Respeta el mismo filtro de ámbito (`scoped-stats`, fuentes y proveedores) que `/api/analytics`.

```json
{
  "period": "today",
  "totals": {
    "claude": { "tasks_completed": 3, "tokens": 150000, "time_worked_ms": 3240000 },
    "codex": { "tasks_completed": 3, "tokens": 299000, "time_worked_ms": 6540000 }
  },
  "series": {
    "unit": "hour",
    "buckets": [{ "bucket": "2026-10-13T09", "claude": 1, "codex": 0 }]
  },
  "heatmap": [{ "date": "2026-10-13", "claude": 2, "codex": 4 }],
  "streak_days": 6
}
```

- **Tarea completada:** sesión `claude` o `codex` con `status = 'completed'` y `ended_at` dentro del periodo, en hora local según `tz_offset`.
- **Tokens:** suma de tokens efectivos (actuales + `baseline_*`; input, output, cache read y cache write) de las sesiones que empezaron en el periodo. `token_usage` no guarda fecha, así que se asigna al día de `started_at`.
- **Tiempo trabajado:** suma de `metadata.total_turn_duration_ms`; si falta, `ended_at` (o ahora) menos `started_at`.
- **Serie:** `unit` es `hour` para `today` y `day` para `7d` y `30d`. Incluye los huecos con ceros.
- **Mapa de calor:** los últimos 35 días, con ceros.
- **Racha:** días seguidos hasta hoy con al menos una tarea completada. Si hoy aún no hay ninguna, se cuenta desde ayer.

El Muro recarga el resumen y las sesiones al recibir `session_created`, `session_updated`, `agent_updated` o un refresco remoto por WebSocket, con 300 ms de espera, como `KanbanBoard.tsx`.

## 5. Integración en la app

- Ruta `muro` en `client/src/App.tsx`, dentro del `Layout`.
- Entrada en `NAV_KEYS` de `client/src/components/Sidebar.tsx`, justo después de `/kanban`, con el icono `StickyNote` de `lucide-react` y la clave `nav:muro`.
- Título de pestaña en `client/src/components/DocumentTitle.tsx`.
- Namespace i18n `muro` en los 5 idiomas (en, es, zh, vi, ko). Textos en español de este documento; el resto, traducidos.
- Código nuevo en `client/src/pages/Muro.tsx` y `client/src/components/muro/`; endpoint en `server/routes/muro.js`, montado en `server/index.js`, con su entrada en `openapi.yaml`.
- Tema oscuro único, con los tokens de `client/tailwind.config.js` (`surface-*`, `border`, `accent`). Letras: Inter y JetBrains Mono de la app, más Caveat solo para títulos de post-its y bocadillos.

## 6. Reglas del repositorio

Cada PR debe cumplir `CLAUDE.md` y `AGENTS.md`:

- Cabecera de autor en cada archivo nuevo o tocado (`bash .claude/skills/file-headers/scripts/check-headers.sh`).
- Toda clave i18n en los 5 idiomas (`bash .claude/skills/i18n-parity/scripts/i18n-audit.sh`).
- `npm run verify` en verde.
- Añadir el Muro a `client/src/pages/__tests__/screens.snapshot.test.tsx` y a `client/src/components/__tests__/Sidebar.test.tsx`, revisando el snapshot en vez de regenerarlo a ciegas.
- Sin cambios en los mensajes WebSocket existentes ni en el esquema de la base de datos.
- Documentación actualizada (`README-EN.md` y guías traducidas) al terminar el último issue.
