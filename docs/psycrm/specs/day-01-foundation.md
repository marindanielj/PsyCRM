# Día 1: base (deploy, módulos, sesión, seed de la práctica)

## Objetivo
Una instancia de PsyCRM **en producción y apta para PHI**, con un solo usuario y solo los módulos que necesita la práctica. Al terminar el día se puede iniciar sesión en `https://<dominio>` y ver Contacts, Calendars, Opportunities (pipeline "Onboarding"), Tasks y Settings, y nada más.

## Alcance
**Incluye:** hosting con BAA, imagen única (API + SPA), oculta módulos en la UI y los bloquea en el servidor, apaga integraciones con PHI, timeout de sesión por inactividad, cabeceras de seguridad y seed de la práctica.
**No incluye:** MFA (semana 2), auditoría (día 2) ni features clínicas.

---

## 1. Hosting (decisión: Google Cloud)

| Pieza | Servicio | Notas |
|---|---|---|
| BAA | Google Cloud BAA (se acepta en la consola, sin costo) | Cloud Run, Cloud SQL y Secret Manager están cubiertos por el BAA |
| App | **Cloud Run**, `us-east1`, `min-instances=1`, CPU siempre asignada | `pg-boss` necesita un proceso vivo |
| BD | **Cloud SQL Postgres 16**, `db-f1-micro` o `db-g1-small` | Cifrado en reposo (por defecto), backups diarios con retención de 30 días y **PITR** activado |
| Secretos | Secret Manager | `DATABASE_URL`, `SESSION_SECRET` (≥ 32 caracteres), `CHATWOOT_WEBHOOK_SECRET` (requerido por `config.ts` aunque no se use), credenciales de email |
| Dominio | Mapeo de dominio de Cloud Run (TLS administrado) | p. ej. `app.<practica>.com` |

Costo estimado: unos USD 20–40 al mes. Una alternativa equivalente es AWS (App Runner + RDS, con BAA vía AWS Artifact). **Prohibido**: usar PGlite en memoria en producción.

### Imagen única
- `Dockerfile` multi-stage: `npm ci` → `npm run build` (genera `dist/`) → imagen runtime `node:22-slim` con `server/`, `db/` y `dist/`.
- `server/index.ts`: servir `dist/` con `serveStatic` de `@hono/node-server/serve-static` **después** de todas las rutas `/api`, con fallback SPA a `dist/index.html` para rutas que no empiezan con `/api`.
- Arranque: `node --import tsx server/index.ts` (o compilar con `tsc`). Un paso previo en el job de deploy corre `npm run migrate`.

## 2. Módulos activos

### Config
```ts
// server/lib/modules.ts
export const ALL_MODULES = ['assistant','conversations','contacts','tags','opportunities','tasks',
  'calendars','calls','marketing','templates','social','automations','reporting','sites','forms',
  'surveys','payments','proposals','reputation','memberships','communities','blog','trigger_links',
  'affiliates','documents','session_notes','audit'] as const
export const PSYCRM_DEFAULT_MODULES = ['contacts','tags','opportunities','tasks','calendars',
  'automations','reporting','documents','session_notes','audit']
export function enabledModules(settings: unknown): Module[]   // lee locations.settings.enabledModules; si falta, usa el default
```

### Servidor
- Middleware `moduleGate(module)` en `server/middleware/module-gate.ts`: si el módulo no está habilitado para la `location`, responde **404**. Se aplica a cada `app.route('/api/loc/:loc/<x>', …)` en `server/index.ts`.
- **Integraciones que envían PHI a terceros:** el assistant/agente IA, `webhooks-chatwoot`, Beeper, `webhooks-voice`, social y federation **no se montan** si `PSYCRM_MODE=true` (nueva variable en `config.ts`, `true` en prod). Tampoco se registra `registerAgentReplyWorker`.

### Web
- `GET /api/locations` incluye `enabledModules` en cada location.
- `src/features/shell/AppShell.tsx`: cada ítem de navegación tiene una `module` key y se filtra por `enabledModules`. Las rutas de `App.tsx` de módulos apagados redirigen a `/contacts`.
- La ruta índice `/` deja de apuntar a `/assistant` y apunta a **`/calendars`** (la agenda del día es la pantalla principal de la terapeuta).
- Settings: solo **Pipelines**, **Custom Fields**, **Sending** (email) y, desde el día 2, **Audit log**.

## 3. Sesión: timeout por inactividad

Hoy el token dura 8 h absolutas (`server/lib/session.ts`). Cambios:

- `SessionToken` agrega `last` (última actividad, en ms). Reglas:
  - `IDLE_TTL_MS = 30 min`: si `now - last > IDLE_TTL_MS`, la sesión es inválida.
  - `ABSOLUTE_TTL_MS = 8 h`: si `now - iat > 8 h`, la sesión es inválida (igual que hoy).
- `operatorAuth`: si la sesión es válida y `now - last > 60 s`, reemite la cookie con `last = now` (sliding window). Hay que mantener `httpOnly`, `secure` y `sameSite=Lax`.
- Web: un hook `useIdleTimer` en `ProtectedLayout`:
  - a los 25 min sin actividad (mouse, teclado, touch) muestra el modal "You'll be signed out in 5:00 – Stay signed in";
  - a los 30 min llama a `POST /api/auth/logout` y redirige a `/login`;
  - al hacer logout limpia el estado en memoria (el SPA no debe guardar PHI en `localStorage`).

## 4. Cabeceras de seguridad
- `secureHeaders()` de `hono/secure-headers` en toda la app:
  - CSP `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'`;
  - las páginas públicas renderizadas con script inline (form, proposal y, desde el día 6, documents) necesitan un nonce o un hash, así que hay que revisar `page-html.ts`;
  - `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (evita filtrar tokens de URL) y `Strict-Transport-Security`.
- `Cache-Control: no-store` en todas las respuestas `/api/loc/*`.
- Revisar con grep que ningún `console.log` imprima cuerpos de request o filas de BD.

## 5. Seed de la práctica (producción)

Nuevo script `db/seed-practice.ts` (`npm run seed:practice`), idempotente. Lee de env: `PRACTICE_NAME`, `OWNER_EMAIL`, `OWNER_NAME`, `OWNER_PASSWORD` (solo la primera vez).

Crea:
1. **Location** con el nombre de la práctica; `settings`:
   - `enabledModules`: el default;
   - `timezone: 'America/Puerto_Rico'`;
   - `practice`: nombre, licencia, dirección, teléfono y email. Se usa en reportes y documentos, y se puede editar en Settings → Practice (pantalla simple: un formulario sobre `locations.settings.practice`).
2. **Operator** dueño, vinculado en `operator_locations`.
3. **Pipeline "Onboarding"** con las etapas, en orden: `New contact`, `Documents sent`, `Documents signed`, `First appointment booked`, `Active client`, `Did not continue`. Se guardan los IDs de las etapas en `locations.settings.onboarding = { pipelineId, stages: { new, sent, signed, booked, active, lost } }` para que los días 6 y 7 los referencien sin buscar por nombre.
4. **Calendar** "Individual session": `duration_min: 50`, `timezone: 'America/Puerto_Rico'`, `buffer_min: 10`, `booking_enabled: false` (se activa post-MVP).
5. **Custom fields** del contacto (`custom_fields`):

| key | label | type |
|---|---|---|
| `date_of_birth` | Date of birth | date |
| `preferred_name` | Preferred name | text |
| `pronouns` | Pronouns | text |
| `emergency_contact_name` | Emergency contact | text |
| `emergency_contact_phone` | Emergency contact phone | phone |
| `emergency_contact_relation` | Relationship | text |
| `is_minor` | Minor (under 21 in PR) | checkbox |
| `guardian_name` | Guardian name | text |
| `guardian_email` | Guardian email | email |
| `guardian_phone` | Guardian phone | phone |
| `referral_source` | Referral source | text |
| `preferred_locale` | Preferred language | select (`es`, `en`) |

> Nota: la mayoría de edad en PR es 21 años. Las reglas de consentimiento para menores en salud mental tienen excepciones (Ley 408-2000). **Hay que validarlo con un asesor legal.**

Además: cambiar el default `calendars.timezone` en `schema.sql` **no** hace falta (el seed lo fija). El `db/seed.ts` de demo sigue igual para `dev:local`.

---

## Criterios de aceptación
1. `https://<dominio>` sirve el SPA; `/health` responde 200; el certificado TLS es válido.
2. La navegación muestra solo Calendars, Contacts, Opportunities, Tasks, Tags, Automations, Dashboard y Settings.
3. `GET /api/loc/:loc/campaigns` (u otro módulo apagado) devuelve 404. `POST /api/public/chatwoot/...` devuelve 404 en `PSYCRM_MODE`.
4. Tras 30 min de inactividad, cualquier llamada a la API devuelve 401 y el SPA vuelve a `/login`. Con actividad continua la sesión dura hasta 8 h y luego expira.
5. El pipeline "Onboarding" existe con 6 etapas; el calendario está en AST.
6. Los backups de Cloud SQL están activos (verificado en la consola) y el BAA está aceptado (captura de pantalla guardada fuera del repo).
7. Las respuestas de `/api/loc/*` tienen `Cache-Control: no-store` y las cabeceras de seguridad.

## Tests
- `server/lib/session.test.ts`: casos de idle expirado, absoluto expirado y reemisión con `last` actualizado.
- `server/middleware/module-gate.test.ts`: 404 en módulo apagado, pasa en módulo habilitado.
- `server/lib/modules.test.ts`: default si falta la config; ignora keys desconocidas.
- `db/seed-practice.ts`: correrlo dos veces contra PGlite no duplica nada.

## Archivos
`Dockerfile` (nuevo), `server/index.ts`, `server/lib/config.ts`, `server/lib/session.ts`, `server/middleware/auth.ts`, `server/lib/modules.ts` (nuevo), `server/middleware/module-gate.ts` (nuevo), `server/routes/locations.ts`, `db/seed-practice.ts` (nuevo), `package.json` (script), `src/App.tsx`, `src/features/shell/AppShell.tsx`, `src/state/auth.tsx`, `src/features/settings/*` (Practice), `src/lib/api.ts`.
