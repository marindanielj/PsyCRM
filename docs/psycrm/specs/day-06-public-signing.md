# Día 6: firma pública de documentos

## Objetivo
La terapeuta envía un paquete a un cliente (y a su tutor si es adolescente). Cada firmante recibe un link único, verifica su identidad, llena y firma cada documento desde el celular o la computadora, y recibe su copia. Cada firma queda como un **registro inmutable con evidencia** (snapshot, hash, IP, hora y consentimiento electrónico), asociado al cliente en el CRM.

Las páginas públicas y los emails van en **español**. La UI de la terapeuta, en inglés.

## Alcance
**Incluye:** las solicitudes y los firmantes, la verificación por OTP, la página pública, la captura de firma, el snapshot inmutable, la copia para el firmante, el traspaso de respuestas al contacto y la UI de envío y seguimiento.
**No incluye:** el avance del pipeline (día 7), el PDF del lado del servidor (post-MVP) ni la versión en inglés (C1).

---

## 1. Esquema

```sql
CREATE TABLE IF NOT EXISTS document_requests (
  id           text PRIMARY KEY,
  location_id  text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  contact_id   text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  packet_id    text REFERENCES document_packets(id) ON DELETE SET NULL,
  packet_name  text NOT NULL,                 -- snapshot
  template_ids text[] NOT NULL,               -- versiones EXACTAS congeladas al enviar
  status       text NOT NULL DEFAULT 'sent'
               CHECK (status IN ('sent','in_progress','completed','expired','voided')),
  sent_by      text NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '14 days',
  completed_at timestamptz,
  voided_at timestamptz, void_reason text
);

CREATE TABLE IF NOT EXISTS document_signers (
  id            text PRIMARY KEY,
  location_id   text NOT NULL,
  request_id    text NOT NULL REFERENCES document_requests(id) ON DELETE RESTRICT,
  role          text NOT NULL CHECK (role IN ('client','guardian','minor')),
  name          text NOT NULL,
  email         text NOT NULL,                -- a dónde se envían el link y el OTP
  token_hash    text NOT NULL UNIQUE,         -- sha256(token); el token en claro nunca se guarda
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','viewed','in_progress','completed')),
  otp_hash      text, otp_expires_at timestamptz, otp_attempts int NOT NULL DEFAULT 0,
  verified_at   timestamptz, first_viewed_at timestamptz, completed_at timestamptz,
  draft_values  jsonb NOT NULL DEFAULT '{}'   -- progreso parcial: { templateId: { key: value } }
);

CREATE TABLE IF NOT EXISTS signed_documents (
  id               text PRIMARY KEY,
  location_id      text NOT NULL,
  contact_id       text NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  request_id       text NOT NULL REFERENCES document_requests(id) ON DELETE RESTRICT,
  signer_id        text NOT NULL REFERENCES document_signers(id) ON DELETE RESTRICT,
  signer_role      text NOT NULL,
  template_id      text NOT NULL REFERENCES document_templates(id) ON DELETE RESTRICT,
  template_title   text NOT NULL, template_version int NOT NULL, locale text NOT NULL,
  field_values     jsonb NOT NULL,
  rendered_html    text NOT NULL,             -- snapshot EXACTO (mode 'signed'), incluye la firma
  content_sha256   text NOT NULL,             -- sha256(rendered_html)
  signer_name      text NOT NULL,             -- nombre escrito
  signature_png    text,                      -- data URL (≤ 100 KB); NULL si la plantilla no requiere dibujada
  esign_consent    boolean NOT NULL CHECK (esign_consent),   -- siempre true
  signer_ip        text NOT NULL, signer_user_agent text NOT NULL,
  verified_via     text NOT NULL,             -- 'email_otp'
  signed_at        timestamptz NOT NULL DEFAULT now()
);
-- inmutable (reject_mutation del día 2)
```
Índices: `signed_documents(location_id, contact_id, signed_at DESC)`, `document_requests(location_id, contact_id, sent_at DESC)`.

## 2. Envío (operador)

`POST /api/loc/:loc/documents/requests`:
```json
{ "contactId": "...", "packetId": "...", "excludeFamilyIds": [],
  "signers": [ { "role": "client", "name": "Ana Rivera", "email": "ana@…" } ] }
```
- Resuelve la versión **activa** de cada familia; si alguna falta, responde 422 `template_not_active`.
- Para un paquete `adolescent`: exige un firmante `guardian`. El `minor` es opcional (si se omite, las plantillas de rol `minor` se excluyen y queda una advertencia en el audit). Los datos del tutor se precargan desde `custom.guardian_*`.
- Valida que cada plantilla del paquete tenga al menos un firmante de sus `signer_roles`.
- Genera un token por firmante (`crypto.randomBytes(32).toString('base64url')`) y guarda solo `sha256`.
- Envía el email con `resolveEmailSender` (`server/lib/sending/resolve.ts`). Si no hay proveedor configurado, el request se crea igual y la UI muestra **Copy link** con el aviso "Email not configured".
- Audit: `packet.sent` (incluye la lista de template ids y versiones, y los roles de los firmantes; no incluye emails). Timeline: `documents_sent`.

**Email (español, sin PHI):**
> **Asunto:** {{practice.name}}: documentos pendientes
> Hola {{signer.first_name}}: {{practice.name}} le envió documentos para completar antes de su primera cita. Use este enlace seguro (válido por 14 días): {{link}}. Si no esperaba este mensaje, ignórelo.

Ni el nombre de los documentos ni la palabra "psicoterapia" van en el asunto.

Otras acciones del operador: `POST /requests/:id/resend` (rota el token del firmante y reenvía), `POST /requests/:id/void` (`{ reason }`), `GET /requests?contactId=` y `GET /requests/:id` (estado por firmante y por documento).

## 3. Página pública: `/d/:token`
Rutas en `server/routes/public-documents.ts` montadas en `/api/public/documents`, más un alias corto `/d/:token`. Todo se renderiza en el servidor (patrón de `form-page.ts`), con JS inline mínimo, mobile-first y en español.

### Flujo
1. **`GET /d/:token`**: busca el firmante por `sha256(token)`.
   - Si no existe, está vencido o anulado, muestra la página "Este enlace no es válido o expiró. Comuníquese con {{practice.name}}".
   - Si existe, muestra la pantalla **Verificación**: "Enviaremos un código de 6 dígitos a a***@gmail.com" → botón **Enviar código**.
2. **`POST /api/public/documents/:token/otp`**: genera el código, guarda `otp_hash` (sha256 + sal) con vencimiento de 10 min y lo envía por email. Rate limit: 3 envíos por cada 15 min por firmante y 10 por hora por IP (`SlidingWindowRateLimiter`).
3. **`POST /…/:token/verify` `{ code }`**: máximo 5 intentos (luego el firmante queda bloqueado y hay que pedir un reenvío al operador). Si el código es correcto:
   - pone `verified_at`, cambia `status → viewed` la primera vez y escribe el audit `document.viewed` (actor `client`);
   - entrega la cookie `ds_<signerId>`: HMAC con `SESSION_SECRET`, 60 min, `httpOnly`, `secure`, `sameSite=Strict`, `path=/d/`.
4. **Wizard de documentos** (`GET /d/:token?doc=N`): barra de progreso ("Documento 2 de 6"), título, texto renderizado (`renderDocumentHtml` en `mode: 'fill'`) y los campos del rol de este firmante.
   - Cada documento termina con el **bloque de firma**:
     - ☐ "He leído y entiendo este documento y acepto sus términos."
     - ☐ "Acepto firmar electrónicamente y que mi firma electrónica tiene la misma validez que mi firma manuscrita." (consentimiento ESIGN y Ley de Transacciones Electrónicas de PR)
     - **Nombre completo** (texto; debe coincidir sin importar mayúsculas ni acentos con `signer.name`; si no coincide, se advierte pero no se bloquea)
     - **Firma** (`<canvas>` con pointer events, botón "Borrar", y un trazo mínimo para considerarla válida), si `signature.drawn`
     - Botón **Firmar y continuar**.
   - **Guardar y continuar después**: `POST /…/:token/draft` guarda `draft_values` y pasa el firmante a `in_progress`.
5. **`POST /…/:token/sign/:templateId`** `{ values, signerName, signaturePng, agreeTerms, esignConsent }`:
   - valida la sesión del firmante, que la plantilla pertenezca al request y a su rol, que no esté firmada ya (idempotente: si ya lo está, devuelve la existente), los campos requeridos y `showIf`, y el PNG (`data:image/png;base64`, ≤ 100 KB);
   - renderiza `mode: 'signed'` (texto + respuestas + bloque: "Firmado electrónicamente por {nombre} el {fecha AST} · IP {ip} · Verificado por código enviado a a***@…" + imagen de la firma + "Documento {id} · SHA-256 {hash corto}");
   - calcula `content_sha256` del HTML final;
   - en una sola transacción: inserta en `signed_documents` + audit `document.signed` + timeline `document_signed`;
   - si era el último documento del firmante: `signer.status = completed` + audit `signer.completed`;
   - si todos los firmantes terminaron: `request.status = completed` + audit `packet.completed` + timeline + **`dispatch('documents_completed')`** (día 7) + el traspaso de los `mapsTo` al contacto (§4).
6. **Pantalla final**: "¡Gracias! Recibirá una copia por correo." Botón **Descargar mis documentos** (abre `/d/:token/copy`, válido mientras dure la sesión del firmante).

### Copia para el firmante
- Email (sin PHI): "Sus documentos firmados están disponibles: {{link}}". Usa el mismo token y requiere OTP otra vez si la sesión venció. El link funciona 30 días después de completar.
- `GET /d/:token/copy` (con sesión): página imprimible con todos los `rendered_html` del firmante y el botón "Imprimir / Guardar como PDF". Audit `document.downloaded`.

## 4. Traspaso de respuestas al contacto
Al completar el request, para cada campo con `mapsTo`:
- `first_name`, `last_name`, `email` y `phone` se actualizan **solo si el contacto no tiene ese valor**. Si ya lo tiene y difiere, se guarda en `custom.intake_conflicts` y aparece un aviso en el perfil: "Intake answers differ from record – review".
- `custom:<key>` sobrescribe el campo personalizado (p. ej. `date_of_birth`, `emergency_contact_*`).
- Audit `contact.updated_from_intake` con las keys.

## 5. UI del operador (inglés)
- **Contact → pestaña Documents**:
  - botón **Send onboarding packet**, que abre un diálogo: elegir paquete, ver la lista de documentos con checkboxes para excluir, y los firmantes (precargados desde el contacto o el tutor, editables). Botón **Send**, que muestra el resultado con **Copy link** por firmante;
  - una tarjeta por request: estado, enviado el, vence el, y el progreso por firmante y documento (✓ firmado con fecha, 👁 visto, ○ pendiente). Acciones: Resend, Void y Copy link;
  - **Signed documents**: lista. Al abrir uno se muestra el `rendered_html` en un iframe sandbox (solo lectura), con un botón Print (audit `document.viewed_by_operator`).
- **Documents → pestaña Sent**: todos los requests con filtros por estado. Los que están por vencer aparecen arriba.
- Si un request vence sin completarse (job diario o al consultarlo), pasa a `expired` y se crea la tarea "Follow up: onboarding documents expired for {client}".

## 6. Seguridad de la página pública
- `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex` y CSP con nonce para el script inline.
- El token nunca aparece en logs (se registra el `signer_id`).
- Toda la PHI del firmante (respuestas y documentos) solo se sirve tras el OTP. La pantalla de verificación no muestra ningún dato aparte del email enmascarado y el nombre de la práctica.
- Nunca se revela si un token existe más allá de "inválido o expirado" (misma respuesta y mismo tiempo).

---

## Criterios de aceptación
1. Enviar el paquete adulto a un contacto: llega un email sin PHI y el link abre la verificación.
2. Un OTP incorrecto 5 veces bloquea; uno correcto da acceso; tras 60 min de inactividad pide OTP de nuevo.
3. Completar los 6 documentos en un teléfono (iPhone SE, 375 px) con firma dibujada: cada uno crea un `signed_documents` con hash, y el request pasa a `completed`.
4. "Guardar y continuar después" conserva las respuestas al volver con el mismo link.
5. El paquete adolescente con tutor + menor: cada uno recibe su link y solo ve sus documentos. El request se completa cuando ambos terminan.
6. `UPDATE signed_documents` falla en la BD. Recalcular `sha256(rendered_html)` coincide con `content_sha256`.
7. Las respuestas del intake con `mapsTo` aparecen en el contacto (fecha de nacimiento, contacto de emergencia).
8. Todos los eventos (`packet.sent`, `document.viewed`, `document.signed`, `packet.completed`, `document.downloaded`) aparecen en el audit con actor `client` para las acciones públicas.
9. Un request anulado o vencido muestra la página de link inválido.

## Tests
- `server/lib/document-tokens.test.ts`: generación y hash, OTP (vencimiento, intentos) y cookie del firmante (firma y vencimiento).
- `server/routes/public-documents.test.ts`: verificación, sign idempotente, rol incorrecto (403), campos requeridos (422), PNG demasiado grande (413), request completado → dispatch llamado una vez.
- `server/routes/documents-requests.test.ts`: validación de firmantes por audiencia, plantilla no activa (422), email no configurado (crea igual).
- `server/db/signed-documents-schema.test.ts` (PGlite): inmutabilidad y `esign_consent` siempre true.
- Captura con `npm run shoot` de cada pantalla pública en móvil.

## Archivos
`db/schema.sql`, `server/lib/document-tokens.ts` (nuevo), `server/lib/document-page.ts` (nuevo, shell público y pasos), `server/lib/document-render.ts`, `server/repos/document-requests-repo.ts` (nuevo), `server/repos/signed-documents-repo.ts` (nuevo), `server/routes/documents.ts`, `server/routes/public-documents.ts` (nuevo), `server/index.ts`, `server/lib/sending/*`, `src/features/documents/{SendPacketDialog,RequestCard,SignedDocumentViewer,SentPage}.tsx` (nuevo), `src/features/contacts/ContactDetail.tsx`, `src/lib/api.ts`.
