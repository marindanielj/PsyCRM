# Día 5: plantillas y paquetes de documentos

## Objetivo
Que la terapeuta pueda **crear, versionar y agrupar en paquetes** los documentos que el cliente debe leer, llenar y firmar. Las plantillas van en **español**, y el modelo queda preparado para tener versiones en inglés (expansión C1).

## Alcance
**Incluye:** el esquema de plantillas y paquetes, el render compartido (markdown + campos + merge fields), el editor (UI en inglés), la vista previa y las plantillas semilla en español.
**No incluye:** el envío ni la firma (día 6).

---

## 1. Esquema

```sql
CREATE TABLE IF NOT EXISTS document_templates (
  id                   text PRIMARY KEY,
  location_id          text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  family_id            text NOT NULL,      -- agrupa todas las versiones del "mismo" documento
  translation_group_id text NOT NULL,      -- agrupa el mismo documento en distintos idiomas (C1)
  locale               text NOT NULL DEFAULT 'es' CHECK (locale IN ('es','en')),
  version              int  NOT NULL DEFAULT 1,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  kind                 text NOT NULL CHECK (kind IN ('agreement','intake_form')),
  title                text NOT NULL,
  body_md              text NOT NULL DEFAULT '',   -- texto (markdown restringido)
  fields               jsonb NOT NULL DEFAULT '[]',
  signature            jsonb NOT NULL DEFAULT '{"required":true,"drawn":true}',
  signer_roles         text[] NOT NULL DEFAULT '{client}',  -- 'client' | 'guardian' | 'minor'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE (location_id, family_id, version)
);
-- solo una versión activa por familia
CREATE UNIQUE INDEX IF NOT EXISTS document_templates_one_active
  ON document_templates(location_id, family_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS document_packets (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  description  text,
  family_ids   text[] NOT NULL,   -- orden de presentación; al enviar se usa la versión ACTIVA de cada familia
  audience     text NOT NULL DEFAULT 'adult' CHECK (audience IN ('adult','adolescent')),   -- adult: 18+ · adolescent: menores de 18
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

**Trigger de inmutabilidad:** una plantilla con `status IN ('active','retired')` no puede cambiar `body_md`, `fields`, `signature`, `signer_roles`, `title` ni `kind`; solo puede pasar de `status` `active` a `retired`. Editar una plantilla activa crea **una versión nueva** (borrador con `version+1` y el mismo `family_id`). Al activarla, la anterior pasa a `retired`. Así cada documento firmado apunta a una versión exacta que nunca cambia.

## 2. Campos (`fields` jsonb)

```ts
type FieldType = 'text'|'textarea'|'email'|'phone'|'date'|'number'|'select'|'radio'
               | 'checkbox'|'checkbox_group'|'yes_no'|'initials'|'heading'|'paragraph'
interface TemplateField {
  key: string            // slug estable dentro de la plantilla
  type: FieldType
  label: string          // en el idioma de la plantilla (es)
  help?: string
  required?: boolean
  options?: { value: string; label: string }[]
  showIf?: { key: string; equals: string | boolean }   // condicional simple (p. ej. "¿Toma medicamentos?" → lista)
  mapsTo?: ContactFieldTarget   // copia la respuesta al contacto al completar (día 6)
  signerRole?: 'client'|'guardian'|'minor'              // quién llena este campo (default: el primero de signer_roles)
}
type ContactFieldTarget = 'first_name'|'last_name'|'email'|'phone'|`custom:${string}`  // p. ej. custom:date_of_birth
```
- `initials` sirve para "Iniciales: ___" junto a cláusulas clave (cancelación, límites de confidencialidad).
- Validación con Zod en `server/lib/document-vocab.ts`: keys únicas, `options` requeridas en select/radio/checkbox_group, y `showIf` debe apuntar a una key anterior.

## 3. Render compartido: `server/lib/document-render.ts` (puro)

```ts
renderDocumentHtml(template, ctx: { practice, contact, today, locale, values?, mode: 'preview'|'fill'|'signed' }): string
```
- **Markdown restringido**: encabezados, párrafos, listas, negrita, cursiva y separadores. **Nada de HTML crudo** (se escapa todo). Se puede usar un parser mínimo propio o `marked` con sanitización; lo preferido es uno propio de ~80 líneas, sin dependencias nuevas.
- **Merge fields**, extendiendo `server/lib/merge-fields.ts`:
  - `{{client.full_name}}`, `{{client.first_name}}`, `{{client.date_of_birth}}`;
  - `{{practice.name}}`, `{{practice.therapist}}`, `{{practice.license}}`, `{{practice.address}}`, `{{practice.phone}}`;
  - `{{fees.session}}`, `{{fees.intake}}`, `{{fees.late_cancel}}`, `{{policy.cancel_hours}}` (de `locations.settings.practice.fees` y `policy`);
  - `{{today}}` en formato largo español ("5 de noviembre de 2026", zona AST).
  - Un merge field desconocido se renderiza como `[[campo desconocido]]`, y en preview queda resaltado.
- Los campos se renderizan con la misma estética de `page-html.ts`. `renderField` se extiende para los tipos nuevos.
- En `mode: 'signed'` se muestran las respuestas en solo lectura y el bloque de firma (día 6).
- Lo usan la vista previa del editor (hoy), la página pública (día 6) y el snapshot inmutable (día 6).

## 4. API: `/api/loc/:loc/documents` (módulo `documents`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/templates` | La última versión de cada familia + `activeVersion` |
| GET | `/templates/:id` | Detalle |
| GET | `/templates/families/:familyId` | Historial de versiones |
| POST | `/templates` | Crear un borrador (v1, nuevo `family_id` y `translation_group_id`) |
| PATCH | `/templates/:id` | Editar (solo borradores; 409 `template_immutable` si no) |
| POST | `/templates/:id/new-version` | Clonar una activa a un borrador `v+1` |
| POST | `/templates/:id/activate` | Activar (la anterior pasa a `retired`) |
| POST | `/templates/:id/retire` | Retirar |
| POST | `/templates/:id/preview` | `{ contactId? }` → `{ html }` con merge fields del contacto o de un cliente ficticio |
| GET/POST/PATCH | `/packets`, `/packets/:id` | CRUD de paquetes. No se puede activar un paquete si alguna de sus familias no tiene versión activa (validación al enviar el día 6, y advertencia en la UI) |

Auditoría: `template.created`, `template.updated`, `template.version_created`, `template.activated`, `template.retired`, `packet.created`, `packet.updated`.

## 5. UI (inglés): `src/features/documents/`
- **Documents** (navegación principal) con pestañas **Templates** y **Packets**, y desde el día 6 también **Sent**.
- **Templates list**: título, tipo, idioma (badge ES), versión activa y estado.
- **Template editor**, en dos columnas:
  - izquierda: título, tipo, signer roles, "Require drawn signature", el editor markdown (textarea monoespaciado con una barra de ayuda para insertar merge fields) y el **field builder**: lista ordenable (drag) con un panel de propiedades por campo (type, label, required, options, showIf, mapsTo);
  - derecha: **preview en vivo** (iframe con el HTML de `/preview`), con un selector "Preview as: sample client / {contact}";
  - acciones: Save draft, Activate, New version (si está activa) y Version history.
- **Packet editor**: nombre, audiencia (Adult/Adolescent), lista ordenable de plantillas (solo familias con versión activa o con advertencia) y vista previa del paquete completo.
- **Settings → Practice**: se agregan los honorarios y políticas (`fees.session`, `fees.intake`, `fees.late_cancel`, `policy.cancel_hours`) que usan los merge fields.

## 6. Plantillas semilla (español): `db/seed-documents.ts`

Se crean como **borradores**. **Deben ser revisadas y adaptadas por la terapeuta o un asesor legal antes de activarlas.** El texto incluye una advertencia visible en el editor: "Template – legal review required".

| Familia | Tipo | Firmantes | Contenido clave |
|---|---|---|---|
| Consentimiento informado para servicios de psicoterapia | agreement | client | Naturaleza del servicio, beneficios y riesgos, duración de las sesiones, **límites de la confidencialidad** (riesgo a sí mismo o a otros, abuso de menores, envejecientes o incapacitados, orden judicial), derecho a terminar, contacto en emergencias (988, Línea PAS, 911). Iniciales junto a los límites de confidencialidad |
| Aviso de prácticas de privacidad (HIPAA) | agreement | client | Usos y divulgaciones, derechos del paciente (acceso, enmienda, registro de divulgaciones, restricciones, copia), quejas (OCR). **Acuse de recibo** firmado |
| Política de cancelación y ausencias | agreement | client | Aviso de `{{policy.cancel_hours}}` horas, cargo de `{{fees.late_cancel}}`, ausencias repetidas. Iniciales |
| Política de honorarios y pagos | agreement | client | `{{fees.intake}}`, `{{fees.session}}`, métodos de pago, recibos para reembolso, saldos |
| Consentimiento para telepsicología | agreement | client | Plataforma, privacidad del entorno, plan de contingencia si se cae la conexión, ubicación física del cliente al inicio de cada sesión, emergencias |
| Consentimiento de comunicaciones electrónicas | agreement | client | Riesgos de email y SMS, qué se comunica por esos medios (solo logística), preferencia de contacto (`checkbox_group`) |
| Cuestionario de admisión | intake_form | client | Datos personales (`mapsTo` nombre y fecha de nacimiento), contacto de emergencia (`mapsTo` custom), motivo de consulta, historial de salud mental y tratamientos previos, medicamentos (`showIf`), salud física, consumo de sustancias, historial familiar, red de apoyo, metas para la terapia |
| Consentimiento del padre, madre o tutor (menor) | agreement | guardian | Autoridad legal del tutor, alcance de la información que se comparte con el tutor vs. la confidencialidad del adolescente, cancelación y pagos a cargo del tutor. *Validar con la Ley 408-2000* |
| Asentimiento del menor | agreement | minor | Lenguaje sencillo: qué es la terapia, qué se queda privado y qué no |

**Paquetes semilla:**
- **Onboarding – Adulto**: Consentimiento informado → Aviso de privacidad → Cancelación → Honorarios → Comunicaciones electrónicas → Cuestionario de admisión (+ Telepsicología si aplica: se puede agregar o quitar al enviar).
- **Onboarding – Adolescente**: Consentimiento del tutor → Asentimiento del menor → Aviso de privacidad (tutor) → Cancelación (tutor) → Honorarios (tutor) → Cuestionario de admisión (lo llena el tutor, con una sección para el menor).

---

## Criterios de aceptación
1. Crear una plantilla con 5 tipos de campo y merge fields; la vista previa los renderiza con datos de un contacto real.
2. Activar la v1, intentar editarla y recibir 409; "New version" crea la v2 en borrador; al activar la v2, la v1 queda `retired`.
3. Un `UPDATE` directo del `body_md` de una plantilla activa falla en la BD.
4. Un paquete ordena plantillas y la vista previa muestra todas en secuencia.
5. El seed crea 9 plantillas en borrador y 2 paquetes; correrlo dos veces no duplica nada.
6. Un HTML inyectado en `body_md` (`<script>`) se muestra como texto escapado.

## Tests
- `server/lib/document-render.test.ts`: markdown (encabezados, listas, escape), merge fields (conocidos, desconocidos, fecha en español AST) y render de cada tipo de campo.
- `server/lib/document-vocab.test.ts`: validación de `fields`.
- `server/db/document-templates-schema.test.ts` (PGlite): inmutabilidad y una sola versión activa por familia.
- `server/routes/documents.test.ts`: flujo de versionado y tenancy.

## Archivos
`db/schema.sql`, `db/seed-documents.ts` (nuevo), `server/lib/document-vocab.ts` (nuevo), `server/lib/document-render.ts` (nuevo), `server/lib/merge-fields.ts`, `server/lib/page-html.ts`, `server/repos/document-templates-repo.ts` (nuevo), `server/repos/document-packets-repo.ts` (nuevo), `server/routes/documents.ts` (nuevo), `server/index.ts`, `src/features/documents/*` (nuevo), `src/features/settings/*` (Practice: honorarios), `src/features/shell/AppShell.tsx`, `src/App.tsx`, `src/lib/api.ts`.
