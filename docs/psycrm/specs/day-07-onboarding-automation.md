# Día 7: automatización del pipeline de onboarding

## Objetivo
Que el pipeline **Onboarding** avance solo según lo que pasa con el cliente: alta → documentos enviados → documentos firmados → primera cita → cliente activo. Cada movimiento, automático o manual, queda auditado y en el timeline. Además, `send_email` en los workflows pasa a enviar de verdad.

## Estado actual (lo que hay que cambiar)
- Los triggers existentes son `contact_created`, `inbound_message`, `appointment_booked`, `opportunity_created`, `trigger_link_clicked`, `survey_submitted` y `proposal_signed`. Las únicas acciones son `send_sms`, `send_email`, `add_tag` y `wait` (`server/lib/automation-vocab.ts`).
- **`send_email` y `send_sms` solo escriben un evento de timeline** (`workflow-runner.ts`, `executeAction`).
- `WorkflowEvent` no trae un payload, así que un workflow no puede filtrar por "qué etapa" o "qué paquete".
- El despacho va por la cola `pg-boss` (es durable), pero **`wait` usa `setTimeout` en memoria**: un reinicio del contenedor pierde las esperas pendientes.

---

## 1. Vocabulario nuevo

**Triggers:**

| Trigger | Se emite en | Payload | `trigger_config` (filtro opcional) |
|---|---|---|---|
| `documents_completed` | día 6, request completado | `{ requestId, packetId }` | `{ packetId? }` |
| `document_signed` | día 6, cada documento | `{ requestId, templateFamilyId }` | `{ templateFamilyId? }` |
| `appointment_checked_in` | día 4 | `{ appointmentId, calendarId }` | `{ calendarId? }` |
| `session_note_signed` | día 3 | `{ noteId, sessionType, isFirst }` | `{ firstOnly?: boolean }` |
| `pipeline_stage_changed` | día 2 + `move_to_stage` | `{ opportunityId, pipelineId, fromStageId, toStageId, origin: 'operator'\|'workflow' }` | `{ pipelineId?, toStageId? }` |
| `appointment_booked` (existe) | — | se agrega `{ appointmentId, calendarId }` | `{ calendarId? }` |

**Acciones:**

| Acción | Config | Efecto |
|---|---|---|
| `move_to_stage` | `{ pipelineId, stageId, createIfMissing: true, onlyForward: true }` | Busca la oportunidad **abierta** del contacto en ese pipeline. Si no existe y `createIfMissing`, la crea (`name` = nombre del contacto, `source: 'workflow'`). La mueve con la misma función que el PATCH manual (audit + timeline). Con `onlyForward`, no mueve hacia atrás (compara `position`): queda `skipped` con el detalle "already further along" |
| `send_document_packet` | `{ packetId }` | Llama al mismo servicio que `POST /documents/requests` con el contacto como firmante `client`. Queda `skipped` si el contacto no tiene email, si ya tiene un request abierto o completado de ese paquete, o si el paquete es `adolescent` (requiere tutor y lo envía el operador) |
| `create_task` | `{ title, body?, dueInDays? }` | Crea `contact_tasks` con merge fields en el título |
| `send_email` (real) | `{ subject, body }` existente | Usa `resolveEmailSender`. Si no hay proveedor, queda `failed` con el detalle "Email provider not configured" (antes se registraba como si hubiera salido bien). Se mantiene el evento de timeline con `status: 'sent'\|'failed'` y el `externalId` |
| `send_sms` | — | Sin cambios (sigue solo en el log); queda fuera de uso hasta tener un proveedor de SMS con BAA. La UI lo oculta |

## 2. Cambios en el motor

1. **`WorkflowEvent.payload?: Record<string, unknown>`**. `dispatchWorkflowEvent` filtra los workflows con `matchesTriggerConfig(workflow.trigger_config, event.payload)` (nuevo, puro, en `automation-vocab.ts`): cada key del config debe coincidir con la del payload, y un config vacío deja pasar todo.
2. **Payload disponible para las acciones**: `executeAction` recibe `event.payload`, y las merge fields admiten `{{event.*}}` (opcional).
3. **Prevención de bucles**: `move_to_stage` despacha `pipeline_stage_changed` con `origin: 'workflow'` y `depth = (event.depth ?? 0) + 1`. El dispatcher descarta eventos con `depth > 3` y escribe el audit `workflow.loop_prevented`.
4. **Idempotencia**: el job de pg-boss puede reintentar. Cada acción con efectos (`move_to_stage`, `send_document_packet`, `create_task`, `send_email`) usa una clave `run_id:position`; si ya está en `workflow_runs.steps` como `done`, no se repite.
5. **Esperas durables** (solo si el seed las usa; el MVP no las necesita): reemplazar `defaultSchedule` por `boss.sendAfter(WORKFLOW_RESUME_QUEUE, { runId, position }, null, seconds)`. Queda **pendiente para A1 (recordatorios)**. Hoy solo se documenta y la UI advierte "Waits longer than a few hours may be lost on restart" mientras no esté hecho.
6. **Auditoría** (del día 2): `workflow.run_started`, `workflow.step_executed` y `workflow.run_finished`, con actor `workflow`.

## 3. Workflows sembrados (`db/seed-practice.ts`, idempotente por nombre)

Usan los IDs guardados en `locations.settings.onboarding` (día 1) y el paquete "Onboarding – Adulto" (día 5). Se crean en estado **`live`** solo si el paquete tiene todas sus plantillas activas; si no, en `draft`, con una nota en la UI.

| # | Nombre | Trigger (filtro) | Acciones |
|---|---|---|---|
| W1 | Onboarding: new client | `contact_created` | `move_to_stage(new)` → `send_document_packet(adult)` → `move_to_stage(sent)` |
| W2 | Onboarding: documents signed | `documents_completed` | `move_to_stage(signed)` → `create_task("Schedule first appointment with {{contact.first_name}}", dueInDays: 2)` |
| W3 | Onboarding: first appointment | `appointment_booked` | `move_to_stage(booked)` |
| W4 | Onboarding: active client | `session_note_signed` (`firstOnly: true`) | `move_to_stage(active)` |
| W5 | Onboarding: manual packet sent | `pipeline_stage_changed` (`toStageId: sent`, origin `operator`) | *(sin acciones de envío: el operador mueve a "Documents sent" después de enviar a mano; sirve como registro)*. **Opcional**, se puede omitir |

**Notas:**
- **W1 y contactos creados a mano.** `contact_created` también se dispara cuando la terapeuta agrega un contacto. Si no quiere que el envío sea automático en ese caso, W1 puede limitarse con `trigger_config: { source: 'booking' }` (requiere pasar `source` en el payload de `contact_created`). **Default recomendado: automático.** El diálogo "Add contact" agrega el checkbox "Send onboarding packet now" (marcado por defecto), que pasa `payload.skipOnboarding` para que W1 lo respete.
- **Adolescentes:** W1 no envía el paquete adolescente. Si el contacto es **menor de 18** (calculado de `date_of_birth`), W1 marca `send_document_packet` como `skipped` y crea la tarea "Send adolescent onboarding packet (guardian required)". Si el contacto **no tiene fecha de nacimiento**, también se salta y se crea la tarea "Add date of birth to send the onboarding packet" (nunca se envía el paquete adulto por defecto).
- **Movimiento manual:** la terapeuta puede mover tarjetas cuando quiera (p. ej. a "Did not continue"); queda auditado (día 2). `onlyForward` evita que un workflow "regrese" a alguien que ella movió más adelante.

## 4. UI (inglés)
- `AddStepDialog.tsx` agrega **Move to pipeline stage** (selector de pipeline y etapa, y checkboxes "Create card if missing" y "Only move forward"), **Send document packet** (selector de paquete) y **Create task**.
- `NewWorkflowDialog.tsx`: muestra los triggers nuevos con su filtro (selector de paquete, de etapa, de calendario y el checkbox "First signed note only").
- `RunsRail.tsx`: el detalle de cada paso muestra `skipped` o `failed` con su motivo (ya existe; se verifica con los tipos nuevos).
- **Opportunities (kanban)**: cada tarjeta muestra "Moved by workflow · 2h ago" o "Moved by Dra. X", tomado del último evento `pipeline.stage_changed`.

---

## Criterios de aceptación
1. Crear un contacto con email lo pone en "New contact", le envía el paquete adulto y lo mueve a "Documents sent". El kanban lo refleja y el audit muestra los 3 pasos con actor `workflow`.
2. Al completar los documentos en la página pública, la tarjeta pasa a "Documents signed" y se crea la tarea "Schedule first appointment…".
3. Agendar una cita mueve la tarjeta a "First appointment booked". Firmar la primera nota la mueve a "Active client"; firmar la segunda no hace nada (`firstOnly`).
4. Si la terapeuta mueve a alguien a "Active client" a mano y luego se dispara W3, la tarjeta no retrocede (paso `skipped`).
5. Un contacto de 17 años (o sin fecha de nacimiento) no recibe el paquete adulto y aparece la tarea para enviar el paquete adolescente.
6. `send_email` sin proveedor configurado aparece como `failed`, no como `done`.
7. Un reintento del job de pg-boss no duplica el paquete enviado ni la tarea.
8. Un workflow que se dispara a sí mismo (`pipeline_stage_changed` → `move_to_stage`) se detiene en la profundidad 3 con el audit `workflow.loop_prevented`.

## Tests
- `server/lib/automation-vocab.test.ts`: `matchesTriggerConfig`, y que cada trigger y acción nuevos tengan su label.
- `server/jobs/workflow-runner.test.ts`: cada acción nueva (done, skipped y failed), `onlyForward`, idempotencia por `run_id:position` y `send_email` con un sender falso.
- `server/jobs/workflow-dispatcher.test.ts`: filtro por payload y corte de profundidad.
- Integración con PGlite (`server/jobs/onboarding-flow.test.ts`): el seed de la práctica y W1–W4 recorriendo el pipeline completo con eventos simulados.

## Archivos
`server/lib/automation-vocab.ts`, `server/jobs/workflow-dispatcher.ts`, `server/jobs/workflow-runner.ts`, `server/jobs/boss.ts` (payload y depth), `server/lib/onboarding.ts` (nuevo: el servicio `moveContactToStage` compartido entre la ruta y la acción), `server/routes/opportunities.ts`, `server/routes/documents.ts` (servicio de envío reutilizable), `server/routes/contacts.ts` (`skipOnboarding`), `server/routes/public-booking.ts` (payload), `db/seed-practice.ts`, `src/features/automations/{AddStepDialog,NewWorkflowDialog,RunsRail,automation-meta}.tsx`, `src/features/contacts/AddContactDialog.tsx`, `src/features/opportunities/OpportunityCard.tsx`.

---

## Estado de implementación (día 7)

**Hecho y verificado** (typecheck limpio; 212 archivos / 1874 pruebas en verde; recorrido en navegador: se agrega un contacto con el checkbox "Send onboarding packet now" → el paquete sale por correo, la tarjeta aparece en "Documents sent" con "Moved by workflow · just now" y la corrida muestra sus tres pasos; ver [`../RESULTADOS_DIA_7.md`](../RESULTADOS_DIA_7.md)).

**Diferencias respecto a lo escrito arriba**
- **Idempotencia por evento, no por `run_id:position`.** Al encolar, cada evento recibe un `eventId`; la corrida de un workflow tiene id determinista `run_<eventId>_<workflowId>`. Si pg-boss reintenta el job, encuentra su corrida: si terminó, la devuelve; si quedó a medias, **sigue después del último paso registrado**. Además cada acción con efectos se protege sola (el paquete no se reenvía si ya hay uno abierto o completado; la tarea no se duplica mientras siga abierta). Queda una ventana mínima: si el proceso muere entre enviar un correo y anotar el paso, `send_email` puede repetirse.
- **Un paso `failed` detiene la corrida** (estado `failed`): nada de lo que sigue aparenta que lo anterior salió bien. Un paso que lanza una excepción se registra como `failed` sin el texto del error.
- **Config nueva `requirePreviousDone`** (no estaba en el spec): un paso con ese flag se salta si el anterior no quedó `done`. Lo usa W1 para que el último `move_to_stage(sent)` **no** mueva a "Documents sent" a un menor o a alguien sin fecha de nacimiento, cuyo paquete se saltó.
- **`skipOnboarding`** se resuelve en el filtro del trigger (`{ skipOnboarding: false }` pasa salvo que el payload lo traiga en `true`); no hace falta el `source` de `contact_created`. `firstOnly` se mapea a `payload.isFirst`.
- **`contact_created` ahora se emite** desde "Add contact" del operador y desde la reserva pública cuando el cliente es nuevo (antes solo lo emitían formularios, encuestas y embudos, que no están activos en PsyCRM).
- **`send_document_packet` crea las tareas** del §3 (menor de 18 o sin fecha de nacimiento) **dentro de la acción**, no en el workflow; también crea "Add an email to send the onboarding packet" cuando falta el correo. Si el correo no sale, el paso queda `failed` con el motivo (la solicitud ya existe y se puede **reenviar** a mano; el workflow no enviará un segundo paquete).
- **El envío de paquete es un servicio compartido** (`server/lib/document-send.ts`): el botón del operador y la acción pasan por las mismas reglas de edad, versiones, auditoría y correo. `move_to_stage` usa `moveOpportunityToStage` (el mismo del tablero); el despacho de `pipeline_stage_changed` ahora lleva payload y profundidad.
- **Los workflows W1–W4 se siembran en `draft`** mientras las plantillas del paquete adulto no estén activas (lo normal en un despliegue nuevo, porque las semilla son borradores) y **no se encienden solos después**: la terapeuta los activa en Automations cuando sus documentos estén listos. No hay nota en la UI. W5 (opcional) no se creó. Volver a sembrar nunca toca un workflow que ya existe (se identifica por nombre).
- **Kanban:** `GET /opportunities` devuelve `lastMove` (quién y cuándo), leído del audit log; la tarjeta muestra "Moved by workflow · 2h ago" o "Moved by Dra. X".
- **El constructor** ofrece los tres pasos nuevos, los filtros por trigger (paquete, documento, pipeline/etapa, calendario, "First signed note only") y oculta `send_sms`. Un `send_sms` que ya exista en un workflow sigue funcionando (solo registra).
- `{{contact.first_name}}` y `{{event.*}}` funcionan en los textos.

**Pendiente / sin verificar**
- **Esperas durables** (`wait` sigue en memoria; la UI avisa "Waits longer than a few hours may be lost if the server restarts"). Sigue para el recordatorio A1 de la semana 2.
- **`send_email` real depende de un proveedor de correo con BAA.** Hoy solo existe el adaptador de Brevo (sin BAA); el de SES sigue pendiente (ver día 6). Sin proveedor, el paso falla con "Email provider not configured", como pide el spec.
- **`PUBLIC_BASE_URL` debe estar configurada en producción**: una automatización no puede adivinar el origen de los enlaces. Sin ella, `send_document_packet` falla con "PUBLIC_BASE_URL is not configured".
- El resumen de un paso "Move to pipeline stage" en el constructor no nombra la etapa (solo describe las opciones).
- La concurrencia real (dos eventos simultáneos sobre un mismo cliente) se prueba contra Postgres real en el día 8.
