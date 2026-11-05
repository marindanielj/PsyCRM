# Día 2: log de auditoría

## Objetivo
Un registro **append-only y con evidencia de manipulación** de toda actividad relevante: quién hizo qué, cuándo, desde dónde y sobre qué cliente. Cubre la creación y los cambios de clientes, los logins, las citas, los cambios de etapa del pipeline y las ejecuciones de workflows. Las notas (día 3) y los documentos (días 5 y 6) usan la misma infraestructura.

## Alcance
**Incluye:** la tabla con sus triggers, `lib/audit.ts`, transacciones en la interfaz `Database`, la instrumentación de los módulos existentes, el arreglo del cambio de etapa, la API de consulta y exportación, y la UI.
**No incluye:** alertas de acceso inusual (post-MVP).

---

## 1. Esquema

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('operator','client','system','workflow')),
  actor_id     text,                     -- operator id | signer id | workflow id | NULL
  actor_label  text,                     -- snapshot legible: "Dra. X", "Cliente (firmante)", "Workflow: Onboarding"
  action       text NOT NULL,            -- 'contact.created', 'note.updated', ...
  entity_type  text NOT NULL,            -- 'contact','session_note','opportunity','appointment','workflow_run','auth',...
  entity_id    text,
  contact_id   text,                     -- SIN FK: el log sobrevive a cualquier borrado
  details      jsonb NOT NULL DEFAULT '{}',
  ip           text,
  user_agent   text,
  prev_hash    text,
  row_hash     text NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_time    ON audit_log(location_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_by_contact ON audit_log(location_id, contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_by_entity  ON audit_log(location_id, entity_type, entity_id);
```

### Cadena de hashes (trigger BEFORE INSERT)
```sql
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger AS $$
DECLARE last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || NEW.location_id));
  SELECT row_hash INTO last_hash FROM audit_log
    WHERE location_id = NEW.location_id ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := last_hash;
  NEW.occurred_at := now();               -- no se acepta un timestamp del cliente
  NEW.row_hash := encode(sha256(convert_to(
     coalesce(last_hash,'') || '|' || NEW.location_id || '|' || NEW.occurred_at::text || '|' ||
     NEW.actor_type || '|' || coalesce(NEW.actor_id,'') || '|' || NEW.action || '|' ||
     NEW.entity_type || '|' || coalesce(NEW.entity_id,'') || '|' || coalesce(NEW.contact_id,'') || '|' ||
     NEW.details::text, 'UTF8')), 'hex');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_chain ON audit_log;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
```

### Inmutabilidad
```sql
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
```
`reject_mutation()` es genérica y se reutiliza en los días 3 y 6. Además: el `location_id` usa `ON DELETE RESTRICT` (no se puede borrar una location con historial) y `TRUNCATE` se revoca al rol de la app en producción (`REVOKE TRUNCATE ON audit_log FROM app_user`).

## 2. Transacciones en `Database`

La interfaz actual (`server/db/database.ts`) solo tiene `query`. Se agrega:
```ts
export interface Database {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>
}
```
- `PgDatabase`: `pool.connect()` → `BEGIN` → `fn(new ClientDatabase(client))` → `COMMIT`, o `ROLLBACK` si hay error; luego `release()`.
- `PgliteDatabase`: `this.pg.transaction(tx => fn(new PgliteTxDatabase(tx)))`.
- `FakeDatabase`: `fn(this)` (sin semántica transaccional, suficiente para los tests de ruta).

**Regla:** una mutación y su fila de auditoría van en la **misma transacción**. Si el audit falla, la mutación se revierte.

## 3. `server/lib/audit.ts`

```ts
export interface AuditActor { type: 'operator'|'client'|'system'|'workflow'; id?: string|null; label?: string|null }
export interface AuditEntry {
  action: AuditAction; entityType: string; entityId?: string|null; contactId?: string|null;
  details?: Record<string, unknown>; actor: AuditActor; ip?: string|null; userAgent?: string|null
}
export async function audit(db: Database, locationId: string, e: AuditEntry): Promise<void>
export function auditContext(c: Context<AppEnv>): Pick<AuditEntry,'actor'|'ip'|'userAgent'>
   // actor = operador de la sesión (id + nombre cacheado), ip = la misma lógica que clientIp de routes/auth.ts
   // (se mueve a lib/client-ip.ts y se comparte), userAgent = el header
export function diff(before: object, after: object, fields: string[]): Record<string,[unknown,unknown]>
```
- `AuditAction` es un union string que se mantiene en `server/lib/audit-vocab.ts`, igual que `automation-vocab.ts`.
- **`details` nunca lleva el texto clínico completo**: solo nombres de campo cambiados, estados o IDs. El contenido vive en las revisiones (día 3). Para contactos, el diff de nombre, email y teléfono sí es aceptable.

## 4. Qué se instrumenta hoy

| Lugar | Acciones |
|---|---|
| `routes/auth.ts` | `auth.login` (actor = operador), `auth.login_failed` (actor `system`, `details.email`), `auth.logout`, `auth.session_expired` (cuando `operatorAuth` rechaza por idle, best-effort) |
| `routes/contacts.ts` | `contact.created`, `contact.updated` (diff), `contact.archived`, `contact.restored`, `contact.viewed` (GET /:id), `contact.tag_added`/`removed`, `contact.custom_fields_updated` (keys cambiadas) |
| `routes/public-booking.ts` | `appointment.booked` (actor `client`), `contact.created` si el upsert creó uno |
| `routes/calendars.ts` | `appointment.created`, `appointment.rescheduled` (from/to), `appointment.status_changed` (from/to), `appointment.deleted` |
| `routes/opportunities.ts` | `opportunity.created`, `pipeline.stage_changed` (from/to stage id + nombres), `opportunity.status_changed`, `opportunity.deleted` |
| `jobs/workflow-runner.ts` | `workflow.run_started`, `workflow.step_executed` (type, status), `workflow.run_finished` (status). Actor `workflow` (id del workflow) |
| `routes/tasks.ts` | `task.created`, `task.completed` |
| `routes/audit.ts` | `audit.exported` (exportar el log también se audita) |

### Arreglo: el cambio de etapa no dejaba rastro
En `PATCH /opportunities/:id` con `stageId` (y en el drag-drop):
1. leer la etapa previa;
2. en la transacción: actualizar, escribir `audit('pipeline.stage_changed')` y escribir `timeline_events` tipo `stage_changed` con `{ pipeline, from, to }`;
3. **después** del commit, `deps.dispatch?.({ triggerType: 'pipeline_stage_changed', contactId, … })`. El trigger se agrega al vocabulario hoy y se usa el día 7.

Mismo tratamiento para `operator-tools.ts` (`move_opportunity`), aunque el assistant esté apagado.

## 5. API

Ruta `server/routes/audit.ts`, montada en `/api/loc/:loc/audit` (módulo `audit`):

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | Filtros: `from`, `to`, `contactId`, `action` (prefijo, p. ej. `note.`), `actorType`, `entityType`, `entityId`. Paginación por cursor (`before=<id>`, `limit ≤ 200`). Respuesta `{ entries, nextCursor }` |
| GET | `/export.csv` | Mismos filtros, sin límite de página (stream). Columnas: id, occurred_at (AST), actor, action, entity, contact, details (JSON), ip |
| GET | `/verify` | Recalcula la cadena de la location: `{ ok: true, count }` o `{ ok: false, brokenAtId }` |

## 6. UI (inglés)

- **Settings → Audit log** (`src/features/audit/AuditLogPage.tsx`):
  - filtros: rango de fechas (default últimos 7 días), cliente (autocomplete), categoría (`Auth`, `Contacts`, `Notes`, `Documents`, `Pipeline`, `Appointments`, `Workflows`) y actor;
  - tabla: When, Who, Action (etiqueta legible desde `audit-vocab`), Client (link), Details (expandible);
  - botones **Export CSV** y **Verify integrity**, que muestra un badge ✅ o ⚠️.
- **Contact detail → pestaña "Audit"**: la misma tabla filtrada por `contactId`.

---

## Criterios de aceptación
1. Crear, editar y archivar un contacto genera 3 filas con el actor correcto, la IP y el diff.
2. Mover una tarjeta del pipeline genera `pipeline.stage_changed` y un evento de timeline visible en el contacto.
3. Un `UPDATE audit_log …` o `DELETE FROM audit_log …` manual falla con `audit_log is append-only`.
4. `/audit/verify` devuelve `ok: true`. Si se altera una fila en una BD de prueba (desactivando el trigger), devuelve `brokenAtId`.
5. Si el `INSERT` en el audit falla (simulado), la mutación del contacto se revierte.
6. La exportación CSV abre bien en Excel y Numbers (UTF-8 con BOM) y queda auditada.

## Tests
- `server/test-utils/pglite.ts` (nuevo): `freshDb()` crea un PGlite, aplica `db/schema.sql` y devuelve un `PgliteDatabase`. Lo usan los tests de triggers de aquí en adelante.
- `server/db/audit-schema.test.ts` (PGlite): inmutabilidad, cadena (3 inserts → `prev_hash` encadenado), `occurred_at` forzado y `verify`.
- `server/lib/audit.test.ts`: `diff`, `auditContext` y que nunca se incluyan claves fuera de la lista blanca.
- Tests de ruta (FakeDatabase): contactos, oportunidades (stage change → audit + timeline + dispatch) y auth (login ok/fallido).
- `server/db/database.test.ts`: `transaction` hace rollback en error (PGlite).

## Archivos
`db/schema.sql`, `server/db/database.ts`, `server/db/pglite-database.ts`, `server/db/fake-database.ts`, `server/lib/audit.ts` (nuevo), `server/lib/audit-vocab.ts` (nuevo), `server/lib/client-ip.ts` (nuevo), `server/routes/audit.ts` (nuevo), `server/routes/{auth,contacts,calendars,opportunities,tasks,public-booking}.ts`, `server/jobs/workflow-runner.ts`, `server/lib/automation-vocab.ts`, `server/test-utils/pglite.ts` (nuevo), `src/features/audit/*` (nuevo), `src/features/contacts/ContactDetail.tsx`, `src/features/settings/SettingsLayout.tsx`, `src/lib/api.ts`.

---

## Estado de implementación (día 2)

**Hecho y verificado** (typecheck limpio; suite completa en verde; recorrido en navegador con PGlite + seed):
- **Esquema** (`db/schema.sql`): `audit_log` con cadena de hashes por práctica, `occurred_at` fijado por la base, `UPDATE`/`DELETE`/`TRUNCATE` rechazados, `audit_log_verify()`. `reject_mutation()` queda reutilizable para los días 3 y 6.
- **Transacciones** (`Database.transaction`, en pg, PGlite y el doble de pruebas) y `audit()` en la **misma transacción** que el cambio. Probado contra una base real: si no se puede escribir el log, el cambio se revierte (cliente, cita, cambio de etapa).
- **Instrumentado:** login / login fallido / logout; clientes (crear, ver, archivar, restaurar, estado, etiquetas, campos personalizados, notas libres); tareas; citas del operador (crear, reprogramar con *desde→hacia* reales, cambio de estado); reserva pública (cliente + cita + línea de tiempo + auditoría en una transacción); tarjetas del pipeline (crear, editar, estado) y **cambio de etapa** (servicio `lib/pipeline-moves.ts`: auditoría + línea de tiempo del cliente + disparo de `pipeline_stage_changed` solo después de confirmar; mover a la misma etapa no escribe nada); ejecuciones de automatizaciones (inicio, cada paso con tipo y resultado, fin).
- **API** `/api/loc/:loc/audit`: listado con filtros y paginación por cursor, `/verify`, `/export.csv` (BOM UTF-8, protegido contra inyección de fórmulas, la exportación queda registrada). Solo lectura.
- **UI:** Settings → Audit log (filtros por fechas, categoría, cliente y quién; verificar integridad; exportar CSV) y el panel "Access & change history" en la ficha de cada cliente.
- **Fecha de nacimiento obligatoria** al crear un cliente y al reservar en la página pública (en modo PsyCRM), con `server/lib/age.ts` (18 o más = adulto, día de cumpleaños exacto, "hoy" en hora de Puerto Rico).

**Diferencias respecto a lo escrito arriba**
- **`chain_seq`:** la cadena se ordena por una columna propia asignada dentro del bloqueo, no por el `id` serial (el serial se toma antes del trigger y, con escrituras simultáneas, no coincide con el orden de la cadena).
- **Login fallido de un correo desconocido no se registra:** no hay práctica a la que asociarlo (la tabla exige `location_id`); solo lo cubre el límite de intentos. El de un usuario real se registra en cada una de sus prácticas.
- **Las automatizaciones registran en modo "mejor esfuerzo":** si falla escribir el log, la ejecución sigue (un fallo haría que la cola reintente y repita efectos reales, como un email). Los efectos clínicamente relevantes (cambio de etapa, citas) se auditan en su origen y sí hacen fallar la operación.
- **`clientIp` ahora toma la dirección que añadió nuestro balanceador (la última de `X-Forwarded-For`)**, no la primera, que la puede falsificar el cliente. También endurece el límite de intentos de login.
- **Los detalles nunca llevan valores clínicos:** `sanitizeDetails` descarta claves prohibidas y trunca texto; las fechas se guardan como texto ISO (un test con base real encontró que `pg` devuelve `Date` y se perdían).
- **`operator-tools.ts` (asistente de IA) no se instrumentó:** está apagado en modo PsyCRM. Si se reactiva, debe usar `moveOpportunityToStage`.
- `contact.viewed` se registra en **cada** apertura de la ficha (no hay deduplicación).
- `calendars` (editar configuración de reserva), borrado de tarjetas y alta/baja de etapas aún no se auditan.

**Para tener en cuenta**
- La página pública de reservas sigue en **inglés**; los textos para clientes en español (decisión 4) se tratan junto con el resto de páginas públicas (día 6).
- Las **notas libres del contacto** (`contact_notes`) siguen existiendo y se pueden editar y borrar para siempre: sirven para recordatorios, no para notas clínicas. Quedan auditadas (sin su texto), pero conviene **ocultarlas** cuando el módulo de notas de sesión (día 3-4) esté activo.
- **Concurrencia:** PGlite atiende una consulta a la vez, así que el bloqueo que evita bifurcar la cadena entre conexiones simultáneas solo se puede probar contra un Postgres real (pendiente para el día 8).
