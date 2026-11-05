# Día 4: notas de sesión (UI, reporte, riesgo visible y check-in)

## Objetivo
Que la terapeuta pueda, desde la cita del día: **check-in → crear la nota con el wizard guiado → firmar → ver o imprimir el reporte**. El riesgo del cliente queda visible en su expediente y en el inicio. La UI va en inglés.

## Alcance
**Incluye:** el wizard de 5 pasos, el autoguardado, la vista reporte con impresión y PDF, la lista de notas del cliente, los anexos, la bandera de riesgo, los widgets del inicio y el check-in de citas.
**No incluye:** el PDF del lado del servidor (post-MVP) ni la i18n (expansión C4).

---

## 1. Rutas del SPA
| Ruta | Pantalla |
|---|---|
| `/contacts/:id` → pestaña **Session notes** | Lista de notas del cliente |
| `/contacts/:id/notes/new?appointmentId=` | Wizard (nueva) |
| `/contacts/:id/notes/:noteId` | **Reporte** (siempre de solo lectura) |
| `/contacts/:id/notes/:noteId/edit` | Wizard (editar). Si la nota está bloqueada, redirige al reporte con un aviso |

Componentes nuevos en `src/features/session-notes/`: `NotesTab.tsx`, `NoteWizard.tsx`, `steps/{ContextStep,MseStep,RiskStep,DapStep,ReviewStep}.tsx`, `NoteReport.tsx`, `AddendumDialog.tsx`, `LockBadge.tsx`, `RiskBadge.tsx`, `ChipGroup.tsx`, `note-print.css`.

## 2. Lista de notas (pestaña del contacto)
- Botón **New session note**. Si hay una cita de hoy con check-in sin nota, el botón dice **Note for today's session** y la precarga.
- Tabla con: Date, Type, Modality, **Risk** (`RiskBadge`), Status (`Draft` / `Signed` / `Signed late`) y **Lock** (`LockBadge`: "Editable · 2d 14h left", "Locks in 3h" en ámbar si quedan menos de 24 h, "Locked 🔒").
- Al hacer clic se abre el **reporte**, nunca el formulario.
- Toggle "Show deleted" (solo metadata y motivo).

## 3. Wizard (crear y editar)

Layout: stepper arriba (1 Context · 2 Mental status · 3 Risk · 4 DAP · 5 Review & sign), el contenido en el centro y una barra fija abajo con **Back**, **Next**, el indicador "Saved 10s ago" y el `LockBadge`.

**Autoguardado:**
- `POST` al primer cambio (crea el borrador); luego `PATCH { autosave: true }` con debounce de 2 s y como máximo cada 10 s.
- Sin conexión: se muestra "Not saved – retrying" y **no** se guarda en `localStorage` (PHI). Si el usuario intenta salir con cambios sin guardar, aparece `beforeunload`.
- Al editar una nota firmada, el paso Review pide **Reason for change** (obligatorio) antes de volver a firmar.

### Paso 1: Context
Client (fijo), Linked appointment (dropdown de citas recientes sin nota; precargado si viene de una), Session date (default hoy, AST), Start time, Duration (default según el calendario, 50), Modality (radio), Session type (radio).

### Paso 2: Mental status
- **Mood (client's words)**: texto corto ("I feel stuck").
- **Mood rating 1–10**: slider con número visible.
- Una tarjeta por cada dominio MSE con `ChipGroup` (multi-select desde `clinical-vocab.MSE_DOMAINS`) + "Add note" (texto libre opcional).
- Atajo **"Within normal limits"**: marca valores normales en los dominios que todavía estén vacíos (well_groomed, cooperative, normal, congruent/full, logical/goal_directed, unremarkable, no_disturbance, oriented_x4, good/good). Es explícito (un botón) y nunca viene precargado.

### Paso 3: Risk assessment (obligatorio)
- Encabezado: "Required every session". Debajo, como referencia y nunca como valor: "Last session (Oct 12): **Low**".
- **Harm to self**: Suicidal ideation (radio, sin default) · Self-harm (radio, sin default).
- **Harm to others**: Homicidal / violent ideation (radio, sin default).
- Risk factors (chips) · Protective factors (chips).
- **Overall risk level** (radio con color): Low · Moderate · High · Imminent.
- **Actions taken** (chips de `RISK_ACTIONS`).
- **Clinical rationale** (textarea).
- **Validación en vivo** con `validateRiskForSign` (importado de `clinical-vocab`):
  - los campos faltantes se marcan en rojo y el stepper muestra ⚠ en "Risk";
  - si el nivel es ≥ Moderate o alguna dimensión no es "denied", el rationale y las acciones son obligatorios y aparece el panel **Crisis resources**: 988 Suicide & Crisis Lifeline, Línea PAS (ASSMCA) 1-800-981-0023 y 911. *Verificar los números antes de salir a producción.*
- Se puede pasar a DAP con el riesgo incompleto (se queda en borrador), pero **Sign** está deshabilitado hasta completarlo.

### Paso 4: DAP
Tres textareas grandes con autosize:
- **Data** con dos sub-campos: *Subjective (client report)* y *Objective (clinician observations)*.
- **Assessment**: arriba muestra en solo lectura el resumen de MSE y riesgo ("Mood 4/10, affect restricted, risk: Low; denied SI/HI").
- **Plan**.

Cada área tiene **Guiding questions** colapsables:
- **D**: ¿Qué temas trajo el cliente? ¿Eventos desde la última sesión? ¿Qué observaste?
- **A**: ¿Cómo se relaciona con las metas de tratamiento? ¿Progreso, estancamiento o retroceso? ¿Cambios de riesgo?
- **P**: Tareas, intervenciones de la próxima sesión, frecuencia, referidos, coordinación.

Interventions used (chips de `INTERVENTIONS`) y Diagnosis codes (texto libre separado por comas, opcional).

### Paso 5: Review & sign
- Renderiza `NoteReport` (el mismo componente de la vista) en modo preview.
- Una lista de verificación muestra lo que falta: riesgo y, como advertencia no bloqueante, DAP vacío.
- Botón **Sign note**: confirmación "Sign as {name}. You can edit for {remaining}; after that the note locks permanently." → `POST /sign` → redirige al reporte.

## 4. Reporte (`NoteReport.tsx` + `note-print.css`)

Estructura (también es la versión impresa):
1. **Membrete**: nombre de la práctica, terapeuta, licencia, dirección y teléfono (de `locations.settings.practice`). Banda: **CONFIDENTIAL – Protected Health Information**.
2. **Client**: nombre, fecha de nacimiento, ID del cliente (los primeros 8 caracteres del id). **Session**: fecha, hora, duración, modalidad y tipo.
3. **Mental status**: tabla de dominio → valores (etiquetas legibles) + nota; ánimo reportado y rating.
4. **Risk assessment**: **siempre** presente, con un recuadro con borde del color del nivel. SI, self-harm, HI, factores, protectores, nivel, acciones y rationale.
5. **D / A / P** con encabezados.
6. Interventions y diagnosis.
7. **Signature**: "Electronically signed by {name}, {license}, on {signed_at AST}". Si aplica: "(signed after lock window)". Si se editó: "Last amended {date} – reason: …".
8. **Addenda**: cada uno con autor y fecha.
9. Pie: `Note ID · Printed {now} by {user} · Page X of Y`.

Botones (no se imprimen): **Print / Save as PDF** (`window.print()` + `POST /printed`), **Edit** (solo si no está bloqueada), **Add addendum**, **Delete** (solo si no está bloqueada; diálogo con motivo obligatorio) y **History** (lista de revisiones con su snapshot; solo lectura).

CSS de impresión:
- `@page { size: letter; margin: 0.75in }`; oculta el shell y los botones; tipografía serif de 11 pt;
- `break-inside: avoid` en las secciones; header y footer repetidos con `position: fixed` (o en tabla);
- el contador de páginas con `counter(page)` funciona en Chrome con `@page` margin boxes. Si falla, se deja solo el pie fijo.

## 5. Riesgo visible fuera de la nota
- **`RiskBadge`** en el encabezado del contacto: nivel de la última nota firmada (verde Low, ámbar Moderate, rojo High/Imminent) + fecha. Sin notas: "No risk assessment yet". Fuente: `GET /session-notes/risk/summary`, o un campo `latestRisk` en `GET /contacts/:id`.
- La lista de contactos tiene una columna Risk opcional.
- **Inicio (`/calendars`)**, panel lateral "Today":
  1. citas de hoy con su estado y el botón Check-in;
  2. **Elevated risk clients** (≥ Moderate);
  3. **Notes locking soon** (borradores que se bloquean en menos de 24 h);
  4. **Sessions without a note** (citas con check-in o completadas, de los últimos 3 días, sin nota).

## 6. Check-in de citas
- **Esquema:** `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;`. Agregar `'checked_in'` a `APPOINTMENT_STATUS` en `server/routes/calendars.ts`. Mantener `scheduled → confirmed → checked_in → completed` (no se valida el orden estricto, solo se registra).
- `POST /api/loc/:loc/calendars/appointments/:id/check-in`: pone `status='checked_in'` y `checked_in_at=now()`, escribe el audit `appointment.checked_in` y el timeline, y despacha `appointment_checked_in` (consumido el día 7).
- **UI:** botón **Check in** en la cita (MonthView, detalle de la cita y panel Today). Después del check-in el botón cambia a **Start session note** (abre el wizard con `appointmentId`). También están **No-show** y **Cancel** con los estados existentes.
- Cuando se firma una nota vinculada a una cita `checked_in`, la cita pasa automáticamente a `completed`.

---

## Criterios de aceptación
1. Desde una cita: Check in → Start session note → wizard con la cita y la fecha precargadas.
2. No se puede firmar sin completar el riesgo; los campos faltantes se señalan.
3. Con riesgo ≥ Moderate aparecen los recursos de crisis y se exigen el rationale y las acciones.
4. Clic en una nota de la lista abre el reporte (sin campos editables). "Print" produce un PDF legible en una o más páginas con membrete, la sección de riesgo y la firma.
5. Una nota bloqueada no muestra Edit ni Delete, y entrar a `/edit` redirige al reporte con el aviso "This note is locked".
6. El anexo aparece en el reporte y en la impresión.
7. La bandera de riesgo del contacto se actualiza al firmar una nota nueva.
8. Recargar la página a mitad del wizard conserva todo (por el autoguardado del servidor).
9. La pantalla funciona en una tablet (iPad, 1024 px) y es usable en un teléfono.

## Tests
- Hay pocos tests de componentes en el repo. Hoy se agregan tests de lógica pura: `validateRiskForSign` (ya del día 3), `formatLockRemaining(ms)` y `mseSummary(mse)`.
- Verificación visual con `npm run shoot` (`scripts/shoot.mjs`): capturas del wizard en cada paso y del reporte en modo impresión (`page.emulateMedia({ media: 'print' })`), y un PDF generado con Puppeteer (`page.pdf`) para revisarlo.

## Archivos
`src/features/session-notes/*` (nuevo), `src/features/contacts/ContactDetail.tsx`, `src/features/contacts/ContactsPage.tsx`, `src/features/calendars/{CalendarsPage,MonthView,NewAppointmentDialog}.tsx`, `src/features/calendars/TodayPanel.tsx` (nuevo), `src/App.tsx`, `src/lib/api.ts`, `server/routes/calendars.ts`, `server/repos/appointments-repo.ts`, `db/schema.sql`.
