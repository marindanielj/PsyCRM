# PsyCRM: plan del MVP

> Objetivo: que la psicóloga pueda atender a sus primeros clientes **la semana que viene** con:
> (1) onboarding con documentos firmados electrónicamente, (2) notas de sesión DAP con estado mental,
> bloqueadas a las 72 h y auditadas, y (3) un log de auditoría de la actividad del CRM.

---

## 0. Punto de partida: qué reutilizamos del código de OpenLevel

| Necesidad del MVP | Qué ya existe | Lo que falta |
|---|---|---|
| Expediente del cliente | `contacts`, campos personalizados, tags, archivado (soft-delete), `timeline_events` | Campos clínicos (fecha de nacimiento, contacto de emergencia, etc.) como campos personalizados |
| Documentos para firmar | `proposals` y `public-proposals.ts`: página pública + firma con nombre escrito + `signed_at` + trigger `proposal_signed` | Plantillas de documentos (no cotizaciones), paquete de varios documentos, evidencia legal de la firma (IP, hash, copia inmutable) |
| Formularios de admisión | `forms`, `form_submissions` y el render público de `page-html.ts` (text/email/textarea/select) | Checkbox, fecha, radio y "acepto"; vínculo a un contacto existente mediante un token |
| Pipeline de onboarding | `pipelines`, `pipeline_stages`, `opportunities` (kanban) | Avance automático por eventos. **Hoy un cambio de etapa no genera timeline ni dispara workflows** |
| Automatizaciones | `workflows` + runner (`add_tag`, `wait`, `send_sms`, `send_email`) | **`send_email` solo se registra en el log y no envía nada** (`workflow-runner.ts`). Hay que conectarlo al adaptador real (`lib/sending/`). Faltan las acciones `send_document_packet` y `move_stage` |
| Citas / check-in | `calendars`, `appointments` (estados scheduled/confirmed/completed/cancelled/no_show) y reserva pública | Estado `checked_in` + `checked_in_at` |
| Notas | `contact_notes` (texto libre, editable y borrable para siempre) | **No sirve para notas clínicas.** Hace falta una tabla nueva |
| Auditoría | `timeline_events` (actividad visible, no inmutable) | Tabla `audit_log` de solo inserción (append-only) |
| Seguridad | Argon2id, sesión HMAC de 8 h, rate limit al login, aislamiento por `location_id` | MFA, cierre de sesión por inactividad, quitar módulos que envían PHI a terceros |

---

## 1. Decisiones de arquitectura del MVP

1. **Un solo tenant (una `location`)** para la práctica, con un solo usuario. Mantener el modelo multi-tenant tal cual (no estorba).
2. **Ocultar módulos que no aplican** (Social, Blog, Afiliados, Comunidades, Funnels, Reputación, Campañas, Assistant/IA, Chatwoot) con una lista de `enabledModules` en `locations.settings` que lee `AppShell.tsx`. No se borra código; se oculta.
3. **Apagar todo lo que envíe PHI a terceros sin BAA**: el agente de IA (Anthropic), Chatwoot, Beeper y las redes sociales. Queda apagado **por defecto** y se reactiva integración por integración, con BAA, mediante `ENABLED_INTEGRATIONS` (y los módulos por práctica con `enabledModules`): ver [`INTEGRACIONES.md`](INTEGRACIONES.md).
4. **Nuevo dominio clínico en tablas nuevas.** No se modifica `contact_notes` ni `proposals`, para no romper los tests existentes y para separar la data clínica (PHI sensible) del resto.
5. **Doble capa de enforcement** para el bloqueo de 72 h y la inmutabilidad del audit: validación en el repo/route **y** triggers en Postgres. Aunque haya un bug en la app, la base de datos rechaza el cambio.

---

## 2. Feature A: pipeline de onboarding con documentos firmados

### 2.1 Modelo de datos (nuevo en `db/schema.sql`)

```sql
-- Plantillas versionadas: Consentimiento informado, Política de cancelación,
-- Aviso de privacidad HIPAA (NPP), Consentimiento de telesalud, Política de pagos,
-- Cuestionario de admisión (intake).
document_templates (
  id, location_id, title, kind,            -- 'agreement' | 'intake_form'
  body_md,                                 -- texto legal (markdown) o NULL si es formulario
  fields jsonb,                            -- campos a llenar (para intake o datos dentro del acuerdo)
  requires_signature boolean,
  version int, status ('draft'|'active'|'retired'),
  created_at, updated_at
)
-- Al editar una plantilla 'active' se crea una versión nueva; la vieja se conserva.

-- Paquete: un conjunto ordenado de plantillas ("Onboarding adulto", "Onboarding menor")
document_packets (id, location_id, name, template_ids text[], created_at)

-- Un envío a un cliente: un link único con token
document_requests (
  id, location_id, contact_id, packet_id,
  token_hash,                              -- se guarda solo el hash del token del link
  status ('sent'|'viewed'|'in_progress'|'completed'|'expired'|'voided'),
  sent_at, viewed_at, completed_at, expires_at
)

-- Un documento firmado o completado: INMUTABLE
signed_documents (
  id, location_id, contact_id, request_id, template_id, template_version,
  rendered_html,                           -- snapshot exacto de lo que el cliente vio
  field_values jsonb,                      -- respuestas
  content_sha256,                          -- hash de rendered_html + field_values
  signer_name, signature_image,            -- nombre escrito + firma dibujada (PNG), ver Decisiones §6
  consent_esign boolean,                   -- "acepto hacer negocios electrónicamente"
  signer_ip, signer_user_agent, signed_at
)
-- Trigger: BEFORE UPDATE OR DELETE ON signed_documents -> RAISE EXCEPTION
```

### 2.2 Flujo

1. Ella crea un contacto (o este llega por la reserva pública, `public-booking.ts`, que ya crea contacto + cita).
2. En el perfil del contacto pulsa **"Enviar paquete de onboarding"**: se crea un `document_request`, se genera el link `/{loc}/docs/{token}` y:
   - se envía por email con el adaptador real (**Amazon SES**, con BAA; hay que escribir `lib/sending/ses-adapter.ts` sobre la interfaz de `lib/sending/provider.ts`, como el de Brevo), **sin PHI en el cuerpo**: solo "Tiene documentos pendientes" + el link;
   - o se copia el link para mandarlo por WhatsApp o SMS.
3. **Página pública** (render server-side, el mismo patrón de `proposal-page.ts` y `form-page.ts`):
   - paso 0: verificar identidad con la fecha de nacimiento o un código de 6 dígitos por email (barato y evita que un link reenviado exponga datos);
   - un paso por documento: leer, llenar los campos, marcar "He leído y acepto", escribir el nombre (y opcionalmente dibujar la firma en un `<canvas>`) y firmar;
   - barra de progreso y posibilidad de continuar más tarde (`in_progress`).
4. Al firmar cada documento se crea un `signed_documents` + `audit_log` + `timeline_events`. Al terminar el paquete, el request pasa a `completed` y se dispara el trigger `documents_completed`.
5. El cliente recibe una copia en PDF o un link de descarga (lo exige ESIGN/UETA: el firmante debe poder conservar una copia).
6. En el perfil del contacto, la pestaña **"Documentos"** muestra la lista con su estado, la vista de solo lectura y la impresión o PDF.

### 2.3 Pipeline de onboarding (sobre `pipelines` / `opportunities`)

Pipeline sembrado al crear la práctica, **"Onboarding"**:

`Nuevo contacto → Documentos enviados → Documentos firmados → Primera cita agendada → Cliente activo` (+ `No continuó`)

- Nuevas **acciones** de workflow: `send_document_packet`, `move_to_stage`, `create_task`.
- Nuevos **triggers**: `documents_completed`, `document_viewed`, `appointment_checked_in`, `pipeline_stage_changed`.
- Workflow sembrado: *contact_created → crear oportunidad en "Nuevo contacto" → send_document_packet → move_to_stage "Documentos enviados"*. Con `documents_completed`, mover a "Documentos firmados" y crear la tarea "Agendar primera cita". Con `appointment_booked`, mover a "Primera cita agendada".
- **Arreglar**: `PATCH /opportunities/:id` con `stageId` debe escribir `timeline_events` + `audit_log` (`pipeline.stage_changed` con from/to) y despachar `pipeline_stage_changed`. Esto cubre el requisito de que el log registre *"cuando un cliente llega a un nodo del pipeline"*. Cada `workflow_run` iniciado o terminado también se registra en el audit.

### 2.4 Check-in (lo mínimo)

- Agregar `checked_in` a `APPOINTMENT_STATUS` y la columna `appointments.checked_in_at`.
- Botón **"Check-in"** en la cita del día, que dispara `appointment_checked_in`. Desde la cita, botón **"Crear nota de sesión"** con la cita ya vinculada.
- Post-MVP: autocheck-in del cliente por link o QR.

---

## 3. Feature B: notas de sesión (DAP + estado mental)

### 3.1 Modelo de datos

```sql
session_notes (
  id, location_id, contact_id, appointment_id NULL,
  session_date date, start_time, duration_min,
  modality ('in_person'|'telehealth_video'|'phone'),
  session_type ('intake'|'individual'|'couple'|'family'|'crisis'),
  -- DAP
  data_subjective text,        -- D: lo que el cliente reporta (citas textuales)
  data_objective text,         -- D: lo que la terapeuta observa
  assessment text,             -- A: interpretación clínica, progreso hacia las metas
  plan text,                   -- P: tareas, próxima sesión, referidos
  -- Estado mental / emocional (MSE estructurado)
  mse jsonb,                   -- ver 3.2
  mood_rating smallint,        -- 1–10 autorreportado
  -- Evaluación de riesgo: OBLIGATORIA en toda nota (ver 3.2, paso 3).
  -- Columnas explícitas (no jsonb) para poder exigirlas con CHECK y consultarlas.
  risk_suicidal       text,    -- 'denied'|'passive'|'active_no_plan'|'active_plan'|'active_plan_intent'
  risk_self_harm      text,    -- 'denied'|'history'|'urges'|'recent'|'current'
  risk_harm_others    text,    -- 'denied'|'ideation'|'ideation_plan'|'intent'
  risk_level          text,    -- 'low'|'moderate'|'high'|'imminent' (juicio clínico global)
  risk_factors        text[],  -- acceso a medios, intento previo, aislamiento, consumo...
  protective_factors  text[],  -- red de apoyo, hijos, fe, tratamiento, planes a futuro...
  risk_actions        text[],  -- 'none'|'safety_plan_created'|'safety_plan_reviewed'|'means_restriction'
                               -- |'increased_frequency'|'emergency_contact'|'crisis_line'|'er_referral'|'duty_to_warn'
  risk_notes          text,    -- justificación clínica del nivel asignado
  interventions text[],        -- TCC, DBT, mindfulness, psicoeducación...
  diagnosis_codes text[],      -- opcional (ICD-10 / DSM-5-TR)
  status ('draft'|'signed'),
  signed_at, signed_by,
  created_by, created_at, updated_at,
  locks_at timestamptz NOT NULL DEFAULT now() + interval '72 hours', -- un trigger impide modificarla
                               -- (no puede ser GENERATED: timestamptz + interval no es IMMUTABLE en Postgres)
  deleted_at                   -- soft delete, solo dentro de las 72 h
)

session_note_revisions (      -- snapshot completo en cada guardado (append-only)
  id, note_id, revision int, snapshot jsonb, changed_by, changed_at, change_reason
)

session_note_addenda (        -- después de las 72 h: anexos en vez de editar (append-only)
  id, note_id, body, author, created_at
)
```

**Restricciones de riesgo (CHECK en Postgres + validación Zod en la API):**
- Una nota con `status='signed'` **debe** tener `risk_suicidal`, `risk_self_harm`, `risk_harm_others` y `risk_level` no nulos. Un borrador puede guardarse incompleto; firmarlo, no.
- No existe la opción "no evaluado": el riesgo negado se registra como `'denied'` (respuesta explícita).
- Si `risk_level` es `moderate`, `high` o `imminent`, entonces `risk_notes` y al menos un `risk_actions` distinto de `'none'` son obligatorios.
- Si alguna dimensión es distinta de `'denied'`, `risk_level` no puede ser `low` sin justificación en `risk_notes`.

**Triggers de Postgres:**
- `BEFORE UPDATE OR DELETE ON session_notes`: si `now() > OLD.locks_at`, se lanza `RAISE EXCEPTION 'note locked'`. No hay `DELETE` físico nunca: borrar = `deleted_at`, solo permitido antes del bloqueo.
- `BEFORE UPDATE OR DELETE` en `session_note_revisions`, `session_note_addenda` y `audit_log`: siempre se rechaza.

### 3.2 Formulario guiado (crear y editar)

Wizard de 5 pasos con autoguardado (borrador) cada ~10 s:

1. **Contexto**: cliente, cita (precargada si se abre desde la cita), fecha, duración, modalidad, tipo.
2. **Estado mental y emocional**: campos de selección rápida con chips (multi-select) y texto libre opcional:
   - Apariencia · Conducta/actitud · Habla · **Ánimo** (en palabras del cliente) · **Afecto** (congruente, restringido, plano, lábil...) · Proceso del pensamiento · Contenido del pensamiento · Percepción · Orientación/cognición · Insight · Juicio
   - **Ánimo 1–10** (slider).
3. **Evaluación de riesgo (obligatoria, en toda sesión)**: paso propio que no se puede saltar. El botón "Firmar" queda deshabilitado mientras falte algo.
   - **Daño a sí mismo**: ideación suicida (niega / pasiva / activa sin plan / activa con plan / con plan e intención) y autolesión (niega / historial / impulsos / reciente / actual).
   - **Daño a otros**: ideación homicida o de violencia (niega / ideación / con plan / con intención).
   - **Factores de riesgo y protectores** (chips) y **nivel de riesgo global** (bajo / moderado / alto / inminente) según su juicio clínico.
   - **Acciones tomadas** (plan de seguridad creado o revisado, restricción de medios, más frecuencia de sesiones, contacto de emergencia, línea de crisis 988, referido a sala de emergencias, deber de advertir).
   - **Nunca se precarga** con las respuestas de la sesión anterior: cada sesión se contesta activamente. Así una nota copiada no aparenta una evaluación que no se hizo. Sí se muestra, como referencia, "Nivel en la sesión anterior: Bajo (12/oct)".
   - Si el nivel es ≥ moderado o alguna dimensión no es "niega": se exige la justificación y al menos una acción, se muestra un recordatorio del protocolo de crisis y, al firmar, se crea una tarea de seguimiento.
4. **DAP**: tres áreas de texto, cada una con preguntas guía colapsables ("¿Qué reportó el cliente?", "¿Qué observaste?", "¿Cómo se relaciona con las metas?", "¿Qué sigue?") y la lista de intervenciones usadas. La "A" muestra el resumen de riesgo del paso 3 para que la evaluación clínica lo integre.
5. **Revisar y firmar**: vista previa en formato reporte, luego "Firmar nota" (`status=signed`). Firmar **no** bloquea: lo que bloquea es el reloj de 72 h. Mientras faltan horas se muestra "Editable por 2 d 14 h más".

**Riesgo visible fuera de la nota (MVP):**
- **Bandera en el expediente** del cliente con el nivel de su última nota firmada (verde / ámbar / rojo) y la fecha.
- **Lista "Clientes con riesgo ≥ moderado"** en el panel de inicio.
- **Auditoría**: cada cambio de `risk_level` entre sesiones se registra como `risk.level_changed` (de → a).

### 3.3 Ver = reporte (imprimir / PDF)

- La ruta `/contacts/:id/session-notes/:noteId` **siempre** abre en modo reporte (solo lectura). "Editar" aparece solo si `now() < locks_at`.
- Reporte con CSS `@media print`: membrete de la práctica, "CONFIDENCIAL – Información de salud protegida", datos del cliente (nombre, fecha de nacimiento, ID), datos de la sesión, MSE en tabla, **sección de evaluación de riesgo siempre presente** (cada dimensión, factores, nivel, acciones y justificación), D/A/P, firma digital ("Firmado electrónicamente por ___, Lic. #___, fecha y hora"), anexos y un pie con el hash/ID de la nota.
- **MVP**: el botón "Imprimir / Guardar PDF" usa `window.print()` (sin dependencias).
- **Post-MVP**: PDF generado en el servidor con `puppeteer-core` (ya está en devDependencies) para exportar el expediente completo de un cliente en un solo PDF.

### 3.4 Reglas (resumen)

| Acción | < 72 h desde la creación | ≥ 72 h |
|---|---|---|
| Ver / imprimir | ✅ (se audita `note.viewed`) | ✅ (se audita) |
| Editar | ✅ (revisión + audit con diff) | ❌ (API 409 + trigger de BD) |
| Borrar | ✅ soft delete con motivo obligatorio (audit) | ❌ |
| Anexo (addendum) | ✅ | ✅ (append-only, audit) |

> **Nota HIPAA.** La regla de 72 h es una política de la práctica (buena práctica de los EHR), no un número que fije HIPAA. Lo que sí exige HIPAA (§164.526) es que el cliente pueda pedir **enmiendas**: por eso el *addendum* es necesario. También conviene distinguir **notas de progreso** (estas notas DAP, que forman parte del expediente) de las **"psychotherapy notes"** (§164.501), que tienen protección adicional y no se comparten. Para el MVP, todo es nota de progreso.

---

## 4. Feature C: log de auditoría

### 4.1 Tabla

```sql
audit_log (
  id bigserial, location_id, occurred_at timestamptz DEFAULT now(),
  actor_type ('operator'|'client'|'system'|'workflow'), actor_id,
  action text,               -- 'contact.created', 'note.updated', 'pipeline.stage_changed'...
  entity_type, entity_id, contact_id,
  details jsonb,             -- diff {field: [antes, después]} o metadata; nunca la nota completa
  ip, user_agent,
  prev_hash, row_hash        -- cadena de hashes: detecta si alguien alteró filas viejas
)
-- Trigger: rechaza UPDATE/DELETE. Índices: (location_id, occurred_at desc), (contact_id), (entity_type, entity_id).
```

### 4.2 Qué se audita (MVP)

- **Acceso**: `auth.login`, `auth.login_failed`, `auth.logout`.
- **Clientes**: `contact.created`, `contact.updated` (diff), `contact.archived`, `contact.restored`, `contact.viewed`.
- **Notas**: `note.created`, `note.updated` (diff por campo), `note.signed`, `note.viewed`, `note.printed`, `note.deleted`, `note.addendum_added`, `note.edit_rejected_locked`, `risk.level_changed`.
- **Documentos**: `packet.sent`, `document.viewed`, `document.signed`, `packet.completed`, `document.downloaded`.
- **Pipeline y automatizaciones**: `opportunity.created`, `pipeline.stage_changed` (from/to), `workflow.run_started`, `workflow.step_executed`, `workflow.run_finished`.
- **Citas**: `appointment.booked`, `appointment.checked_in`, `appointment.status_changed`.

### 4.3 Implementación

- `server/lib/audit.ts` con `audit(c, {...})`, que toma el actor de la sesión y la IP/UA del request (reutiliza la lógica de IP de `routes/auth.ts`).
- Las llamadas van **en la misma transacción** que el cambio cuando es posible.
- UI: **Configuración → Auditoría**, una tabla filtrable por fecha, cliente, acción y actor, con exportación a CSV. En el perfil del cliente, una pestaña "Auditoría".

---

## 5. Seguridad mínima antes de meter PHI real (no negociable)

1. **Hosting con BAA** (Business Associate Agreement): decisión: **AWS** (RDS PostgreSQL + ECS Fargate detrás de un balanceador, en una cuenta dedicada dentro de su organización de AWS), con el BAA aceptado en AWS Artifact. Requisitos: cifrado en reposo, HTTPS y backups diarios con prueba de restauración.
2. **Email**: no poner PHI en el cuerpo, solo links. Con SES el BAA de AWS ya cubre el envío.
3. **Sesión**: cierre por inactividad de 15–30 min (hoy la sesión es de 8 h absolutas). **MFA con TOTP** en la semana 2 a más tardar.
4. **Quitar las integraciones de IA y mensajería** (sección 1, punto 3) hasta tener un BAA.
5. **Política documentada** (una página): quién accede, retención de expedientes (según la ley del estado o país donde ejerce), qué hacer ante una brecha.

---

## 6. Plan de ejecución (≈ 7–8 días de desarrollo)

Orden según el riesgo: **las notas antes que el onboarding**, porque se necesitan desde la primera sesión y los documentos se pueden enviar a mano el primer día si hace falta.

| Día | Entregable | Archivos principales |
|---|---|---|
| 1 | Deploy en hosting con BAA, módulos ocultos, IA y Chatwoot apagados, timeout de inactividad, seed de la práctica (pipeline "Onboarding" y campos personalizados clínicos) | `db/schema.sql`, `db/seed.ts`, `AppShell.tsx`, `lib/session.ts` |
| 2 | `audit_log` + `lib/audit.ts` + instrumentación de auth, contactos, citas y pipeline (incluido el arreglo de stage-change → timeline/dispatch) + UI de auditoría | `routes/auth.ts`, `routes/contacts.ts`, `routes/opportunities.ts`, `routes/calendars.ts` |
| 3 | `session_notes`, revisiones y anexos + triggers de BD + repo + rutas CRUD con regla de 72 h + tests | `repos/session-notes-repo.ts`, `routes/session-notes.ts` |
| 4 | Wizard de nota (contexto + MSE + **riesgo obligatorio** + DAP) + bandera de riesgo en el expediente + vista reporte imprimible + check-in en citas | `src/features/session-notes/*`, `NewAppointmentDialog.tsx` |
| 5 | Plantillas de documentos, paquetes y editor simple (markdown + campos) | `repos/document-*`, `src/features/documents/*` |
| 6 | Página pública de firma (verificación, pasos, firma, hash, snapshot) + email con link + copia para el cliente | `lib/document-page.ts`, `routes/public-documents.ts`, `lib/sending/*` |
| 7 | Workflows: triggers y acciones nuevas, `send_email` real, workflow de onboarding sembrado | `lib/automation-vocab.ts`, `jobs/workflow-runner.ts` |
| 8 | Prueba completa con data ficticia (cliente nuevo → firma → cita → check-in → nota → bloqueo a las 72 h simulado → auditoría), ajustes de UX y textos en español | — |

**Recorte de emergencia**: si el día 6 no está listo, la primera semana se envían los documentos como PDF por un canal seguro y se suben al expediente. Las notas y el audit **sí** tienen que estar listos.

### Decisiones tomadas (2026-11-05)
1. **Jurisdicción: Puerto Rico.** Zona horaria `America/Puerto_Rico` (AST, sin horario de verano). Líneas de crisis: 988 y Línea PAS (ASSMCA). La retención de expedientes y el consentimiento de menores se rigen por la ley local (Ley 408-2000 de Salud Mental, reglamentos de la Junta Examinadora de Psicólogos). **Hay que validarlo con un asesor legal antes de usar las plantillas.**
2. **Las 72 h cuentan desde la creación de la nota.**
3. **Firma:** nombre escrito + checkbox "acepto firmar electrónicamente" (requisito legal de la Ley de Transacciones Electrónicas de PR, basada en UETA, y de ESIGN) **+ firma dibujada** en pantalla, obligatoria por defecto y configurable por plantilla. La dibujada da más confianza al cliente y más peso como evidencia, y cuesta poco (un `<canvas>`). El nombre escrito sigue siendo la firma legal si alguien no puede dibujar.
4. **Interfaz de la terapeuta en inglés. Documentos y páginas para clientes en español.** El modelo de datos queda preparado para varios idiomas (`locale` y `translation_group_id` en las plantillas).
5. **Adolescentes: posibles. Adulto = 18 años o más** (para efectos de terapia, decide por sí mismo). Menor = menos de 18. Hay un paquete "Onboarding adolescente" con consentimiento del tutor + asentimiento del menor (varios firmantes por envío). **El paquete se elige según la fecha de nacimiento**, que pasa a ser un dato obligatorio al crear el cliente.

Los specs de cada día están en [`specs/`](specs/README.md). La infraestructura de AWS está en [`INFRA_AWS.md`](INFRA_AWS.md). Lo ya construido está en [`RESULTADOS_DIAS_1_2.md`](RESULTADOS_DIAS_1_2.md) y [`RESULTADOS_DIA_3.md`](RESULTADOS_DIA_3.md), [`RESULTADOS_DIA_4.md`](RESULTADOS_DIA_4.md), [`RESULTADOS_DIA_5.md`](RESULTADOS_DIA_5.md), [`RESULTADOS_DIA_6.md`](RESULTADOS_DIA_6.md), [`RESULTADOS_DIA_7.md`](RESULTADOS_DIA_7.md), [`RESULTADOS_INVITACION.md`](RESULTADOS_INVITACION.md) y [`RESULTADOS_DIA_8.md`](RESULTADOS_DIA_8.md). Operación en [`OPERACIONES.md`](OPERACIONES.md).

---

## 7. Recomendaciones post-MVP

### A. Construir con o sobre lo que ya existe

| # | Feature | Se apoya en | Valor |
|---|---|---|---|
| A1 | **Recordatorios de citas** por SMS/email (24 h y 2 h antes) + confirmación | `workflows` + `wait` + `lib/sending` (Twilio/Brevo) | Menos ausencias (no-shows), el problema #1 de las prácticas privadas |
| A2 | **Instrumentos estandarizados** (PHQ-9, GAD-7, PCL-5, ORS/SRS) con puntuación automática y gráfica de tendencia por cliente | `surveys` + `survey_submissions` + `reporting` | Cuidado basado en medición; muchas aseguradoras lo valoran |
| A3 | **Autoagendamiento** con cuestionario de cribado previo | Reserva pública (`public-booking.ts`) + `forms` | Llena la agenda sin llamadas |
| A4 | **Facturación y superbills** (CPT 90791/90834/90837, ICD-10, NPI) para que el cliente pida reembolso a su seguro | `invoices`, `products`, `payments` (Stripe/Square) | Cobro y reembolso sin un sistema aparte |
| A5 | **Cobro con tarjeta guardada** y política de cancelación tardía | `subscriptions`, `payments`, `coupons` | Cobra las cancelaciones tardías automáticamente |
| A6 | **Dashboard clínico**: casos activos, notas sin firmar o por bloquearse, ausencias, ingresos, documentos pendientes | `reporting-repo.ts` | Visión diaria de la práctica |
| A7 | **Plantillas de cartas** (asistencia, referido, alta) con merge fields | `templates` + `merge-fields.ts` | Ahorra tiempo administrativo |
| A8 | **Borrador de nota DAP con IA** a partir de viñetas, siempre con aprobación humana. Solo con BAA y zero-data-retention | `assistant`, `agent-engine` (patrón de borrador que se aprueba antes de enviar) | Reduce el tiempo de documentación |
| A9 | **App móvil** (OpenConnector): agenda del día, check-in y lectura rápida del expediente | `openconnector/` | Uso entre sesiones |
| A10 | **Biblioteca psicoeducativa** (hojas de trabajo, audios de relajación) asignable por cliente | `courses` / `lessons` / `enrollments` | Tareas entre sesiones |
| A11 | **Lista de espera** como pipeline, con aviso automático cuando se libera un horario | `pipelines` + `workflows` | No pierde clientes potenciales |
| A12 | **Constructor de páginas por bloques** (portada, servicios, tarifas, planes, preguntas frecuentes, horario, formulario) para crear y cambiar páginas públicas sin programar. Nace de la página pública actual; el formulario destina a la bandeja de solicitudes por defecto. Los constructores viejos (`sites`, `forms`, `surveys`) no se pueden encender tal cual: ver [`specs/future-page-builder.md`](specs/future-page-builder.md) | Página pública (`/p/`), bandeja de solicitudes, constructor de campos de Documentos | Páginas nuevas y cambios de la terapeuta sin un programador; base para la marca propia por terapeuta y el inglés |

### B. Crear desde cero

| # | Feature | Valor |
|---|---|---|
| B1 | **Plan de tratamiento** (problemas → metas → objetivos medibles → intervenciones → fecha de revisión), vinculado a la "A" de cada nota DAP | Es el eje clínico y lo exigen las aseguradoras |
| B2 | **Plan de seguridad (Stanley-Brown)** como documento estructurado, versionado y compartible con el cliente, enlazado desde la evaluación de riesgo de la nota. Opcional: escalas validadas (C-SSRS) dentro del paso de riesgo. La bandera y la evaluación obligatoria ya entran en el MVP | Gestión del riesgo suicida |
| B3 | **Autorizaciones de divulgación (ROI)** con vigencia y revocación + **registro de divulgaciones** (HIPAA §164.528) | Cumplimiento al compartir información con médicos, escuelas o tribunales |
| B4 | **Portal seguro del cliente** (documentos, citas, pagos, mensajes). Según D-46, como producto **separado** de OpenLevel | Autoservicio y menos carga administrativa |
| B5 | **Telesalud** con integración de video con BAA (Zoom for Healthcare, Doxy.me) y link automático en la cita | Sesiones remotas |
| B6 | **Reclamaciones a seguros** (837P vía clearinghouse como Office Ally o Claim.MD) + verificación de elegibilidad | Si decide aceptar seguros |
| B7 | **Resumen de alta / cierre de episodio** y reapertura | Ciclo de vida clínico completo |
| B8 | **Exportación del expediente completo** (PDF firmado) para solicitudes del cliente o de un tribunal | Derecho de acceso (HIPAA §164.524) |
| B9 | **Multiusuario con roles** (terapeuta, asistente administrativo sin acceso a notas, supervisor con co-firma de internos) | Crecimiento de la práctica |
| B10 | **Cifrado a nivel de campo** de notas y MSE (claves en KMS) + MFA obligatorio + alertas de acceso inusual | Defensa en profundidad para PHI |

### C. Expansión futura: todo bilingüe (español / inglés)

| # | Fase | Alcance |
|---|---|---|
| C1 | **Documentos y formularios del onboarding** (primera prioridad) | Cada plantilla con versión ES y EN (`translation_group_id`). El cliente elige el idioma en la página de firma; se guarda qué idioma firmó |
| C2 | Páginas públicas y emails al cliente | Reserva, recordatorios, verificación por OTP y copias firmadas en el idioma preferido del cliente (`contacts.preferred_locale`). La página pública y sus bloques (A12) se vuelven bilingües aquí |
| C3 | Interfaz de la terapeuta | i18n del SPA (`react-i18next` o similar), con selector de idioma por usuario |
| C4 | Reportes clínicos | Etiquetas del reporte de notas, MSE y riesgo en ES/EN (lo que se escribe en la nota queda en el idioma original) |

**Semana 2 (ya definida en los specs, día 8 §6):** MFA → esperas durables en workflows → **reconsentimiento al cumplir 18** → versiones en inglés del onboarding (C1) → PDF del expediente → **sincronización de calendario por `.ics`** (feed de salida con título genérico y lectura de ocupado/libre; ver [`INTEGRACIONES.md`](INTEGRACIONES.md) §3.1).

**Prioridad sugerida después del MVP:** A1 → C1 → B1 → A2 → A4/A5 → B2 → B3 → A6 → el resto. **A12** (constructor de páginas) entra cuando se necesite una segunda página pública o el inglés (C2); hasta entonces la página pública actual alcanza.
