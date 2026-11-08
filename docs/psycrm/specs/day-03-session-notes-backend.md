# Día 3: notas de sesión (backend)

## Objetivo
El modelo de datos, las reglas y la API de las notas DAP con estado mental (MSE) y **evaluación de riesgo obligatoria**. Las garantías clave (bloqueo a las 72 h desde la creación, sin borrado físico, revisiones y anexos inmutables) se aplican **en Postgres**, no solo en la app.

## Alcance
**Incluye:** tablas, CHECKs, triggers, el vocabulario clínico compartido, el repo, las rutas, la auditoría y los tests.
**No incluye:** la UI y el reporte (día 4), ni el trigger de workflow `session_note_signed` (se emite hoy, pero se consume el día 7).

---

## 1. Vocabulario clínico compartido: `server/lib/clinical-vocab.ts`
Lo importan el servidor (validación con Zod) y el web (chips), igual que `automation-vocab.ts`.

```ts
export const MODALITIES = ['in_person','telehealth_video','phone'] as const
export const SESSION_TYPES = ['intake','individual','couple','family','crisis','collateral'] as const
export const MSE_DOMAINS = {
  appearance:       ['well_groomed','casual','disheveled','inappropriate_dress','poor_hygiene'],
  behavior:         ['cooperative','engaged','guarded','withdrawn','agitated','restless','psychomotor_retardation','poor_eye_contact'],
  speech:           ['normal','pressured','slow','soft','loud','monotone','tangential_speech'],
  mood_observed:    ['euthymic','depressed','anxious','irritable','euphoric','angry','tearful'],
  affect:           ['congruent','incongruent','full','restricted','blunted','flat','labile'],
  thought_process:  ['logical','goal_directed','circumstantial','tangential','flight_of_ideas','loose_associations'],
  thought_content:  ['unremarkable','worries','ruminations','obsessions','delusions','hopelessness','guilt'],
  perception:       ['no_disturbance','auditory_hallucinations','visual_hallucinations','depersonalization'],
  cognition:        ['oriented_x4','disoriented','impaired_attention','impaired_memory'],
  insight:          ['good','fair','poor'],
  judgment:         ['good','fair','poor'],
} as const
export const RISK_SUICIDAL     = ['denied','passive','active_no_plan','active_plan','active_plan_intent'] as const
export const RISK_SELF_HARM    = ['denied','history','urges','recent','current'] as const
export const RISK_HARM_OTHERS  = ['denied','ideation','ideation_plan','intent'] as const
export const RISK_LEVELS       = ['low','moderate','high','imminent'] as const
export const RISK_FACTORS      = ['prior_attempt','access_to_means','substance_use','isolation','recent_loss',
  'chronic_pain_illness','impulsivity','hopelessness','family_history','legal_financial_stress','abuse_history'] as const
export const PROTECTIVE_FACTORS = ['social_support','children_dependents','religious_beliefs','engaged_in_treatment',
  'future_plans','coping_skills','pets','employment_school'] as const
export const RISK_ACTIONS = ['none','safety_plan_created','safety_plan_reviewed','means_restriction_counseling',
  'increased_session_frequency','emergency_contact_notified','crisis_line_provided','er_referral','duty_to_warn',
  'consultation'] as const
export const INTERVENTIONS = ['cbt','dbt_skills','act','mindfulness','psychoeducation','motivational_interviewing',
  'emdr','supportive','behavioral_activation','exposure','problem_solving','relaxation_training'] as const
export const LABELS: Record<string,string>   // etiquetas en inglés para la UI y el reporte
```
`MSE` = `{ [domain]: { values: string[]; note?: string } }` + `mood_reported: string` (el ánimo en palabras del cliente).

## 2. Esquema

```sql
CREATE TABLE IF NOT EXISTS session_notes (
  id              text PRIMARY KEY,
  location_id     text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  contact_id      text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,   -- contactos se archivan, no se borran
  appointment_id  text REFERENCES appointments(id) ON DELETE SET NULL,
  session_date    date NOT NULL,
  start_time      time,
  duration_min    int CHECK (duration_min BETWEEN 1 AND 600),
  modality        text NOT NULL DEFAULT 'in_person',
  session_type    text NOT NULL DEFAULT 'individual',
  data_subjective text, data_objective text, assessment text, plan text,
  mse             jsonb NOT NULL DEFAULT '{}',
  mood_rating     smallint CHECK (mood_rating BETWEEN 1 AND 10),
  risk_suicidal       text, risk_self_harm text, risk_harm_others text, risk_level text,
  risk_factors        text[] NOT NULL DEFAULT '{}',
  protective_factors  text[] NOT NULL DEFAULT '{}',
  risk_actions        text[] NOT NULL DEFAULT '{}',
  risk_notes          text,
  interventions   text[] NOT NULL DEFAULT '{}',
  diagnosis_codes text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  signed_at timestamptz, signed_by text, signed_late boolean NOT NULL DEFAULT false,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  locks_at        timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  deleted_at timestamptz, deleted_by text, delete_reason text,

  -- Riesgo: obligatorio para firmar
  CONSTRAINT risk_required_to_sign CHECK (status = 'draft' OR (
    risk_suicidal IS NOT NULL AND risk_self_harm IS NOT NULL AND
    risk_harm_others IS NOT NULL AND risk_level IS NOT NULL)),
  -- Riesgo elevado: justificación y al menos una acción real
  CONSTRAINT risk_elevated_documented CHECK (status = 'draft' OR risk_level = 'low' OR (
    coalesce(length(trim(risk_notes)),0) > 0 AND
    cardinality(array_remove(risk_actions, 'none')) > 0)),
  -- Riesgo bajo con alguna dimensión positiva: justificación obligatoria
  CONSTRAINT risk_low_justified CHECK (status = 'draft' OR risk_level <> 'low' OR (
    risk_suicidal = 'denied' AND risk_self_harm IN ('denied','history') AND risk_harm_others = 'denied')
    OR coalesce(length(trim(risk_notes)),0) > 0),
  CONSTRAINT signed_fields CHECK (status = 'draft' OR (signed_at IS NOT NULL AND signed_by IS NOT NULL)),
  CONSTRAINT delete_reason_required CHECK (deleted_at IS NULL OR coalesce(length(trim(delete_reason)),0) > 0)
);
CREATE INDEX IF NOT EXISTS session_notes_by_contact
  ON session_notes(location_id, contact_id, session_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS session_notes_locking
  ON session_notes(location_id, locks_at) WHERE status = 'draft' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS session_note_revisions (
  id text PRIMARY KEY, location_id text NOT NULL, note_id text NOT NULL REFERENCES session_notes(id) ON DELETE RESTRICT,
  revision int NOT NULL, kind text NOT NULL CHECK (kind IN ('create','update','autosave','sign','delete')),
  snapshot jsonb NOT NULL, changed_by text NOT NULL, changed_at timestamptz NOT NULL DEFAULT now(),
  change_reason text, UNIQUE (note_id, revision)
);
CREATE TABLE IF NOT EXISTS session_note_addenda (
  id text PRIMARY KEY, location_id text NOT NULL, note_id text NOT NULL REFERENCES session_notes(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (length(trim(body)) > 0), author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Las columnas de riesgo usan `text` con validación de enum en Zod. Opcional: un CHECK `IN (...)` por columna, generado desde `clinical-vocab` (mejor que no diverjan: el test del vocab compara ambos).

### Trigger de bloqueo
```sql
CREATE OR REPLACE FUNCTION session_note_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'session_note_no_delete' USING ERRCODE = 'P0001';
  END IF;
  -- columnas que nunca cambian
  NEW.id := OLD.id; NEW.location_id := OLD.location_id; NEW.contact_id := OLD.contact_id;
  NEW.created_at := OLD.created_at; NEW.created_by := OLD.created_by; NEW.locks_at := OLD.locks_at;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'session_note_deleted' USING ERRCODE = 'P0001';
  END IF;
  IF now() >= OLD.locks_at THEN
    -- Única excepción: firma tardía de un borrador (solo cambian status/signed_*).
    IF OLD.status = 'draft' AND NEW.status = 'signed'
       AND (to_jsonb(NEW) - ARRAY['status','signed_at','signed_by','signed_late','updated_at'])
         = (to_jsonb(OLD) - ARRAY['status','signed_at','signed_by','signed_late','updated_at']) THEN
      NEW.signed_late := true;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'session_note_locked' USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS session_note_guard ON session_notes;
CREATE TRIGGER session_note_guard BEFORE UPDATE OR DELETE ON session_notes
  FOR EACH ROW EXECUTE FUNCTION session_note_guard();

-- Revisiones y anexos: append-only (reject_mutation() del día 2)
DROP TRIGGER IF EXISTS session_note_revisions_immutable ON session_note_revisions;
CREATE TRIGGER session_note_revisions_immutable BEFORE UPDATE OR DELETE ON session_note_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
DROP TRIGGER IF EXISTS session_note_addenda_immutable ON session_note_addenda;
CREATE TRIGGER session_note_addenda_immutable BEFORE UPDATE OR DELETE ON session_note_addenda
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
```
`locks_at` se asigna por DEFAULT en el `INSERT`. El repo **no** lo envía, y si lo enviara, el trigger de UPDATE lo restaura. Para que un `INSERT` no pueda fijar un `locks_at` arbitrario, se agrega un trigger `BEFORE INSERT` que hace `NEW.created_at := now(); NEW.locks_at := now() + interval '72 hours'`.

### Reglas de producto (sobre las de la BD)
| Situación | Regla |
|---|---|
| Editar una nota **firmada** dentro de las 72 h | Se permite y requiere `changeReason`. La firma se renueva (`signed_at = now()`) y queda una revisión `update` |
| Borrador que llega a 72 h | Se bloquea su contenido. Solo se puede **firmar tarde** si el riesgo está completo (`signed_late = true`, audit `note.signed_late`). Si no, la única vía es un anexo |
| Borrar | Solo es soft delete (`deleted_at`, `delete_reason`) y solo antes de `locks_at` |
| Anexo | Siempre, incluso sobre notas bloqueadas o firmadas. Nunca sobre notas borradas |

## 3. Repo: `server/repos/session-notes-repo.ts`

```ts
class SessionNotesRepo extends LocationScopedRepo {
  listByContact(contactId, { includeDeleted = false }): Promise<SessionNoteSummary[]>
  get(id): Promise<SessionNote | undefined>               // incluye addenda[], revisionCount
  create(input, actor): Promise<SessionNote>              // tx: insert + revision(create) + audit(note.created)
  update(id, patch, actor, { autosave, changeReason }): Promise<SessionNote>
  sign(id, actor): Promise<SessionNote>                   // tx: status=signed + revision(sign) + audit(note.signed | note.signed_late)
  softDelete(id, reason, actor): Promise<void>            // tx: set deleted_* + revision(delete) + audit(note.deleted)
  addAddendum(id, body, actor): Promise<Addendum>         // tx: insert + audit(note.addendum_added)
  listRevisions(id) / getRevision(id, rev)
  latestRiskByContact(): Promise<{ contact_id, risk_level, session_date, note_id }[]>
     // DISTINCT ON (contact_id) entre las notas firmadas y no borradas, ordenadas por session_date DESC, created_at DESC
  lockingSoon(hours = 24): Promise<SessionNoteSummary[]>  // borradores con locks_at < now()+24h
}
```

**Autosave:** `update(..., { autosave: true })` actualiza la fila, pero solo crea una revisión `autosave` y un audit `note.autosaved` si la última revisión del mismo usuario tiene más de 5 min. Un guardado explícito siempre crea una revisión `update` y un audit `note.updated` con `details.fields = [campos cambiados]` (sin contenido).

**Cambio de riesgo:** al firmar, si `risk_level` difiere de la última nota firmada del cliente, se escribe el audit `risk.level_changed` con `{ from, to, previousNoteId }`.

## 4. Rutas: `server/routes/session-notes.ts` → `/api/loc/:loc/session-notes` (módulo `session_notes`)

| Método | Ruta | Cuerpo / query | Respuesta |
|---|---|---|---|
| GET | `/?contactId=` | `includeDeleted` | `{ notes: Summary[] }` (sin campos DAP) |
| GET | `/:id` | — | `{ note, addenda, lock: { locked, locksAt, msRemaining } }` + audit `note.viewed` |
| POST | `/` | `{ contactId, appointmentId?, sessionDate, ... }` | 201 `{ note }` |
| PATCH | `/:id` | campos parciales + `autosave?` + `changeReason?` | `{ note }` · 409 `note_locked` · 409 `note_deleted` · 422 `change_reason_required` |
| POST | `/:id/sign` | — | `{ note }` · 422 `{ error: 'risk_incomplete', missing: [...] }` |
| DELETE | `/:id` | `{ reason }` | 204 · 409 `note_locked` |
| POST | `/:id/addenda` | `{ body }` | 201 `{ addendum }` |
| GET | `/:id/revisions` · `/:id/revisions/:rev` | — | metadata · snapshot (audit `note.revision_viewed`) |
| POST | `/:id/printed` | — | 204, audit `note.printed` |
| GET | `/risk/summary` | — | `{ elevated: [{ contact, riskLevel, sessionDate, noteId }] }` (moderate o más) |
| GET | `/locking-soon` | — | borradores que se bloquean en menos de 24 h |

- Validación con Zod usando los enums de `clinical-vocab`. `mse` se valida dominio por dominio y se rechazan claves desconocidas.
- **El servidor valida el riesgo antes de firmar** con la misma lógica que los CHECK (`validateRiskForSign(note)` en `clinical-vocab.ts`). Así se devuelve un 422 con la lista `missing`, en vez de dejar que la BD lance un error genérico.
- Errores de Postgres: `session_note_locked` se traduce a 409 `note_locked`, igual para `deleted`; la violación de un CHECK `risk_*` se traduce a 422. Se agregan a `server/lib/db-errors.ts`. Cada rechazo por bloqueo escribe el audit `note.edit_rejected_locked`.
- Tras `sign`: `dispatch({ triggerType: 'session_note_signed', contactId })` y un evento de timeline `session_note_signed` (sin contenido clínico, solo fecha y tipo).
- **El timeline del contacto nunca muestra contenido clínico**, solo "Session note signed – Oct 12".

## 5. Tipos en `src/lib/api.ts`
`SessionNote`, `SessionNoteSummary`, `Addendum`, `NoteLock` y los métodos `api.sessionNotes.{list,get,create,update,sign,remove,addAddendum,revisions,printed,riskSummary,lockingSoon}`.

---

## Criterios de aceptación
1. Se crea un borrador sin riesgo; firmarlo devuelve 422 con `missing: ['risk_suicidal', …]`.
2. Con `risk_level='high'` y sin acciones, firmar devuelve 422. Con nota y una acción, firma.
3. Con `risk_level='low'` y `risk_suicidal='passive'` sin justificación, firmar devuelve 422.
4. A una nota con `locks_at` en el pasado (forzado en el test con `SET session_replication_role = replica`), `PATCH` devuelve 409 y queda el audit `note.edit_rejected_locked`. El `UPDATE` directo por SQL también falla.
5. `DELETE FROM session_notes` falla siempre. El soft delete funciona antes del bloqueo y falla después.
6. Un borrador bloqueado con riesgo completo se puede firmar tarde (`signed_late = true`). Si se cambia cualquier otro campo, falla.
7. Los anexos se crean sobre notas bloqueadas, y `UPDATE` o `DELETE` sobre ellos falla.
8. Cada create, update o sign deja una revisión con el snapshot completo, y el audit lleva solo los nombres de los campos.
9. `INSERT` con `locks_at` o `created_at` arbitrarios se ignoran (los fija el trigger).

## Tests
- `server/db/session-notes-schema.test.ts` (PGlite): todos los criterios de BD (4–7, 9) más los CHECK de riesgo.
- `server/repos/session-notes-repo.test.ts`: la transacción incluye revisión y audit; throttling del autosave; `risk.level_changed`.
- `server/routes/session-notes.test.ts`: validación Zod, mapeo de errores 409/422, tenancy (no se puede leer una nota de otra location), `note.viewed` auditado.
- `server/lib/clinical-vocab.test.ts`: `validateRiskForSign` (tabla de casos).

## Archivos
`db/schema.sql`, `server/lib/clinical-vocab.ts` (nuevo), `server/repos/session-notes-repo.ts` (nuevo), `server/routes/session-notes.ts` (nuevo), `server/index.ts`, `server/lib/db-errors.ts`, `server/lib/audit-vocab.ts`, `server/lib/automation-vocab.ts` (trigger `session_note_signed`), `src/lib/api.ts`.

---

## Estado de implementación (día 3)

**Hecho y verificado** (typecheck limpio; pruebas contra una base real PGlite; ver el resumen en [`../RESULTADOS_DIA_3.md`](../RESULTADOS_DIA_3.md)):
- **Esquema** (`db/schema.sql`): `session_notes`, `session_note_revisions`, `session_note_addenda` y sus triggers. El bloqueo a las 72 h, el riesgo obligatorio, la ausencia de borrado físico, las revisiones y los anexos inmutables los impone la base de datos.
- **Vocabulario clínico** (`server/lib/clinical-vocab.ts`): enums, dominios del examen mental, etiquetas en inglés y `validateRiskForSign`, con una prueba que obliga a que las listas de las restricciones SQL coincidan exactamente con el vocabulario.
- **Repositorio y rutas** (`server/repos/session-notes-repo.ts`, `server/routes/session-notes.ts`, módulo `session_notes`): crear, editar, firmar, borrar (suave), anexos, revisiones, impresión, lista de riesgo elevado y de notas por bloquearse. Cada escritura es una sola transacción: cambio + revisión + auditoría.
- **Disparador** `session_note_signed` (en `automation-vocab.ts`) tras confirmar la firma, y un evento sin contenido clínico en la línea de tiempo del cliente.
- **Cliente web** (`src/lib/api.ts`): tipos y `api.sessionNotes.*`; `ApiError` ahora conserva el cuerpo de la respuesta (para el 422 `risk_incomplete` con `missing`).

**Diferencias respecto a lo escrito arriba**
- **Las revisiones las escribe un trigger, no el repositorio.** Cualquier cambio a una nota, venga de donde venga, deja una copia completa; y **un cambio sin persona atribuida se rechaza** (`session_note_actor_required`). La persona se indica con `SELECT set_config('psycrm.actor', …, true)` dentro de la transacción (también `psycrm.change_kind` y `psycrm.change_reason`).
- **`appointment_id` es `ON DELETE RESTRICT`**, no `SET NULL`: un `SET NULL` intentaría modificar una nota que puede estar congelada, y una cita ligada a una nota clínica no debe desaparecer.
- **Un borrador sin firmar puede firmarse tarde** (`signed_late`), pero solo si lo único que cambia es la firma y el riesgo está completo.
- **Una nota firmada se puede editar dentro de la ventana** solo con motivo (`changeReason`); la firma se renueva y no se puede dejar sin evaluación de riesgo. **Nunca vuelve a borrador** (`session_note_unsign`).
- **`GET /:id` de una nota borrada responde 410 sin contenido**; su historia sigue disponible (y auditada) por `/revisions`.
- **El motivo de un borrado y los textos nunca van al log de auditoría**: solo nombres de campos, ids y estados (`risk.level_changed` lleva de→a, que es metadato). El autosave se audita solo cuando el trigger de verdad creó una revisión (una por autor cada 5 min).
- **Un intento de editar o borrar una nota bloqueada queda registrado** (`note.edit_rejected_locked`) en la misma transacción que lo rechaza.
- **La fecha de la sesión no puede ser futura** (hora de Puerto Rico) → 422 `session_date_in_future`.
- **Las columnas `date`/`time` se devuelven como texto.** Un test con base real mostró que `pg` entrega `date` como un `Date` a medianoche local, y la fecha del evento de línea de tiempo salía como `"Thu Nov 05"`.

**Pendiente / sin verificar**
- **Concurrencia real:** `SELECT … FOR UPDATE` serializa ediciones simultáneas de una misma nota, pero PGlite atiende una consulta a la vez; solo se prueba contra un Postgres real (día 8).
- **Conexiones agrupadas (PgBouncer, RDS Proxy):** el actor se pasa con `set_config(…, true)` (local a la transacción), que es compatible con el modo transacción; conviene probarlo si se añade un *proxy*.
- **El payload del disparador** `session_note_signed` (`isFirst`, `sessionType`) se calcula pero `WorkflowEvent` aún no lo transporta (día 7).
- **Retención:** una nota "borrada" conserva su contenido en la fila y en las revisiones (a propósito: es el expediente). Falta una política de retención y una exportación del expediente (post-MVP).
- **La interfaz** (formulario en 5 pasos, reporte, bandera de riesgo) es el día 4. El espejo web del vocabulario clínico se crea entonces.
