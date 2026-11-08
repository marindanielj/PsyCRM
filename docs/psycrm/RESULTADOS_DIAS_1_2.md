# PsyCRM: resultados de los días 1 y 2

> Fecha: 2026-11-06 · Rama: `claude/gracious-mayer-p1aobu` · Specs de origen: [`day-01-foundation.md`](specs/day-01-foundation.md) y [`day-02-audit-log.md`](specs/day-02-audit-log.md) (cada uno termina con su sección "Estado de implementación").
>
> Este documento reúne **qué se construyó, cómo se verificó, qué se encontró, en qué se desvió de los specs y qué falta**, para que se pueda retomar sin leer la conversación.
>
> **Actualización (2026-11-06, después de los días 1 y 2):** la variable `PSYCRM_MODE` **se eliminó**. PsyCRM es ahora el único comportamiento del producto, y las integraciones con terceros se activan una por una con `ENABLED_INTEGRATIONS` (ver [`INTEGRACIONES.md`](INTEGRACIONES.md)). Este documento ya describe el estado actual; el §6 explica el cambio.

---

## 1. Resumen

| | Día 1: base | Día 2: log de auditoría |
|---|---|---|
| **Objetivo** | Una instancia de PsyCRM apta para datos de salud, con un solo usuario y solo los módulos de la práctica | Un registro permanente, a prueba de alteraciones, de quién hizo qué a la información de los clientes |
| **Estado** | Terminado y verificado, **excepto** el build de la imagen Docker y el despliegue en AWS (no se pudieron probar) | Terminado y verificado, **excepto** la concurrencia real entre conexiones (solo se prueba contra un Postgres real) |
| **Commits** | `f33ba2b`, `6db33f6`, `63ade70` (lockfile), `43cd09a` (doc) | `b8d38c6`, `bf396fc`, `3d51d17` |

**Verificación al cierre (2026-11-06):**

| Comprobación | Resultado |
|---|---|
| `npm run typecheck` | Limpio |
| `npx vitest run` (suite completa) | **195 archivos, 1708 tests, todos en verde** (tras quitar `PSYCRM_MODE`) |
| `npm run build` (app web) | Compila |
| Recorrido en navegador (Playwright + Chromium) con el servidor real `dev:local` + Vite: inicio de sesión, menú, pipeline con los 4 clientes demo, agenda con 3 citas, módulo apagado por URL | Sin errores en la consola ni en el proxy de Vite (salvo el 401 esperado de la consulta de sesión antes de iniciar sesión) |
| `npm ci` con el `package-lock.json` del repositorio, en carpeta limpia | Funciona (tras la corrección del §5.1) |
| Build de la imagen Docker | **No probado** (no hay Docker en el entorno de desarrollo) |
| Despliegue y servicios de AWS | **No probado** (la cuenta aún no existe) |

Alcance del cambio: **81 archivos** de código (4 791 líneas añadidas, 290 quitadas; 38 archivos nuevos, 43 modificados) más 11 de documentación.

---

## 2. Día 1: base

### 2.1 Qué hace ahora

**Comportamiento fijo.** No hay un modo que activar: esto es lo que hace el producto siempre.

| Aspecto | Qué hace |
|---|---|
| **Módulos** | Cada práctica tiene una lista `settings.enabledModules`. Por defecto: contacts, tags, opportunities, tasks, calendars, automations, reporting, documents, session_notes, audit. Un módulo apagado responde **404** en la API y desaparece del menú. Escribir su dirección a mano redirige al inicio |
| **Integraciones con terceros** | Todas **apagadas por defecto** y sin montar: Chatwoot, webhooks de voz y de pagos, páginas públicas de marketing, la federación con el hub, los tokens push y el agente de IA (sin cliente de IA ni worker). Cada una se enciende **por separado** con `ENABLED_INTEGRATIONS` cuando exista un BAA con el proveedor, y solo queda siempre montada la reserva pública. Detalle, lista de verificación y registro en [`INTEGRACIONES.md`](INTEGRACIONES.md) |
| **Sesión web** | Se cierra tras **30 min sin actividad** (ventana deslizante: la cookie se renueva como máximo cada 60 s) y a las **8 h** absolutas. A los 25 min aparece el aviso "Still there?" con cuenta regresiva. Mientras hay actividad, la web consulta la API cada 4 min para mantener viva la sesión. Cualquier 401 devuelve al login |
| **Sesiones por `Authorization: Bearer`** (app móvil) | Exentas del límite de inactividad (no pueden renovarse); solo aplica el límite absoluto |
| **Cabeceras** | CSP estricta (`default-src 'self'`…), HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` en `/api/*`, `X-Robots-Tag: noindex` en las páginas públicas. Las páginas públicas renderizadas en el servidor llevan las mismas cabeceras **sin CSP** hasta que usen nonces |
| **Base de datos** | En producción el servidor **se niega a arrancar** si `DATABASE_URL` no usa `sslmode=verify-full` (o `verify-ca`) |
| **Terceros** | La app ya no pide la fuente a Google Fonts (cada carga habría informado a Google de quién usa una app clínica). La tipografía cae a la del sistema |

**Menú.** Contacts, Tags, Opportunities, Tasks, Calendars, Automations, Dashboard y Settings. La página de inicio es **Calendars**.

**Settings.** Practice (nuevo), Audit log (día 2), Email & SMS, Pipelines, Custom Fields, Custom Values. Practice guarda en `locations.settings.practice` el nombre, el nombre del terapeuta tal como debe imprimirse, la licencia, el teléfono, el email, la dirección, los honorarios (sesión, intake, cancelación tardía) y las horas de aviso para cancelar. Alimentará el membrete de las notas impresas y los campos de combinación de los documentos.

**Configuración inicial (`npm run seed:practice`).** Idempotente. Crea la práctica, la dueña, el pipeline **Onboarding** con sus 6 etapas (`New contact`, `Documents sent`, `Documents signed`, `First appointment booked`, `Active client`, `Did not continue`; los IDs quedan en `settings.onboarding` para el día 7), el calendario "Individual session" (50 min, 10 min de colchón, hora de Puerto Rico, reservas apagadas) y 11 campos clínicos del contacto. Una segunda ejecución no duplica nada, no cambia la contraseña de la dueña y no pisa lo que la práctica haya editado (módulos, perfil).

**Imagen y despliegue.** `Dockerfile` en dos etapas para ARM64 (compila la web; el runtime incluye el certificado raíz de RDS, corre como usuario `node` y trae `HEALTHCHECK`). El servidor sirve la web compilada desde `STATIC_DIR` con respaldo a `index.html` para las rutas del cliente (`/assets/*` con caché larga; el resto `no-store`).

### 2.2 Variables de entorno

| Variable | Obligatoria | Para qué |
|---|---|---|
| `NODE_ENV` | sí en producción | `production` activa las comprobaciones de secretos y la cookie `Secure` |
| `PORT` | no (8790) | Puerto del servidor |
| `DATABASE_URL` | sí | Postgres. En producción: `…?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem` |
| `SESSION_SECRET` | sí en producción | ≥ 32 caracteres; firma las sesiones |
| `ENABLED_INTEGRATIONS` | no (vacía = ninguna) | Nombres separados por comas (`chatwoot`, `ai`, `public_pages`, `payments`, `voice`, `federation`, `push`). Un nombre desconocido detiene el arranque |
| `CHATWOOT_WEBHOOK_SECRET` | solo con `chatwoot` habilitada | ≥ 32 caracteres en producción |
| `PUBLIC_BASE_URL` | no | Origen público para los enlaces de los emails (días 6-7) |
| `STATIC_DIR` | no | Carpeta de la web compilada. El `Dockerfile` la fija en `/app/dist` |
| `PRACTICE_NAME`, `OWNER_EMAIL`, `OWNER_NAME`, `OWNER_PASSWORD` | solo para `seed:practice` | `OWNER_PASSWORD` (≥ 12 caracteres) solo se lee si la dueña aún no existe |

### 2.3 Comandos

```bash
npm ci                      # instalar (funciona con el lockfile corregido)
npm run typecheck
npx vitest run              # suite completa (~3,5 min)
npm run build               # compila la web a dist/
npm run migrate             # aplica db/schema.sql (idempotente)
npm run seed:practice       # crea la práctica (ver variables arriba)
npm run start               # arranca el servidor (tsx server/index.ts)
```

> **`npm run dev:local`** levanta la API en `:8790` con una base en memoria y una **práctica de demostración ficticia** (`db/seed-demo.ts`: 4 clientes repartidos por el pipeline, uno menor de edad, y 3 citas próximas). Sin integraciones habilitadas. Entrada: `demo@psycrm.test` / `psycrm-demo-pass`. La web se levanta aparte con `npm run dev` (`:5273`, reenvía `/api` a `:8790`); si solo corre la web aparece `ECONNREFUSED` en el proxy de Vite.

### 2.4 Archivos

**Nuevos (17):** `Dockerfile`, `.dockerignore`, `.gitignore` (el repositorio no tenía), `db/seed-practice.ts`, `server/lib/modules.ts`, `server/lib/practice-seed.ts`, `server/middleware/module-gate.ts`, `server/repos/practice-repo.ts`, `server/routes/practice.ts`, `src/features/auth/IdleTimeout.tsx`, `src/features/settings/PracticeSettingsPage.tsx`, `src/features/shell/RequireModule.tsx`, `src/lib/modules.ts` y sus tests.

**Modificados (principales):** `server/index.ts` (cabeceras, compuertas de módulos, montaje por integración, estáticos), `server/lib/config.ts`, `server/lib/session.ts` y `server/middleware/auth.ts` (inactividad), `server/routes/locations.ts` (`enabledModules`, `psycrm`), `src/App.tsx`, `src/features/shell/AppShell.tsx`, `src/features/settings/SettingsLayout.tsx`, `src/state/auth.tsx`, `src/lib/api.ts`, `index.html`, `package.json` (`seed:practice`, `start`).

---

## 3. Día 2: log de auditoría

### 3.1 Cómo está construido

**Tabla `audit_log`** (`db/schema.sql`). Las garantías las da **la base de datos**, no solo la aplicación:

- **Solo se agrega:** un `UPDATE`, `DELETE` o `TRUNCATE` falla con `audit_log is append-only`. Una práctica con historial no se puede borrar (`ON DELETE RESTRICT`). `contact_id` no tiene clave foránea a propósito: el log sobrevive al cliente.
- **Cadena de hashes:** un trigger encadena cada fila con la anterior de su práctica (hash SHA-256 del hash previo más el contenido), bajo un bloqueo (`pg_advisory_xact_lock`) para que escrituras simultáneas no bifurquen la cadena. La fecha la pone la base (`clock_timestamp()`); quien llama no puede retrasarla ni rellenar las columnas de la cadena.
- **Orden por `chain_seq`**, no por el `id` serial: el serial se toma antes del trigger y con concurrencia no coincide con el orden de la cadena.
- **`audit_log_verify(loc)`** recalcula la cadena y devuelve la primera fila rota (contenido alterado, enlace roto o hueco). La marca de tiempo se calcula en UTC con formato fijo, así el hash no depende de la zona horaria de la sesión.
- `reject_mutation()` queda como función genérica para las tablas inmutables de los días 3 y 6.

**Transacciones.** `Database.transaction(fn)` (en `pg`, PGlite y el doble de pruebas) y `audit(tx, …)`: el cambio y su fila de auditoría se confirman juntos o ninguno. Probado contra una base real: si la tabla de auditoría no se puede escribir, el cliente no se crea, la cita no cambia y la tarjeta no se mueve.

**`sanitizeDetails`.** Último filtro antes de escribir: descarta claves prohibidas a cualquier profundidad (`body`, `password`, `token`, `otp`, `code`, `signature_png`, los campos DAP, `risk_notes`, `mse`), recorta textos a 200 caracteres y convierte las fechas en texto ISO. Los detalles llevan **nombres de campos, ids, estados y desde→hacia**, nunca valores clínicos ni datos personales (por ejemplo, una actualización de campos personalizados registra la clave, no el valor).

### 3.2 Qué se registra

| Origen | Acciones |
|---|---|
| Sesión | `auth.login`, `auth.login_failed` (de una cuenta real), `auth.logout` |
| Clientes | `contact.created`, `contact.viewed` (cada apertura de la ficha), `contact.updated` (estado), `contact.archived`, `contact.restored`, `contact.tag_added/removed`, `contact.custom_fields_updated`, `contact.note_added/updated/deleted` (las notas libres, sin su texto) |
| Tareas | `task.created`, `task.completed` |
| Citas | `appointment.created`, `appointment.rescheduled` (hora anterior y nueva), `appointment.status_changed` (estado anterior y nuevo), `appointment.booked` (el cliente, desde la página pública) |
| Pipeline | `opportunity.created/updated/status_changed`, **`pipeline.stage_changed`** (etapa, origen operador o automatización) |
| Automatizaciones | `workflow.run_started`, `workflow.step_executed` (tipo y resultado), `workflow.run_finished` |
| El propio log | `audit.exported` |

El vocabulario ya incluye las acciones de los días 3-6 (notas de sesión, riesgo, documentos), con sus etiquetas.

**Cambio de etapa del pipeline** (`server/lib/pipeline-moves.ts`). Antes, mover una tarjeta no dejaba rastro ni disparaba automatizaciones. Ahora es un único servicio: el movimiento, la auditoría y la línea de tiempo del cliente se confirman juntos, y el disparador `pipeline_stage_changed` se emite **solo después** de confirmar. Mover a la etapa en la que ya está no escribe nada y no dispara nada (así una automatización no puede entrar en un bucle). Lo usará el día 7.

**Reserva pública.** Ahora es una sola transacción (cliente, cita, línea de tiempo y auditoría). Si se pierde la carrera por el mismo horario, se revierte todo, también el cliente (antes quedaba un contacto sin cita). Pide fecha de nacimiento obligatoria.

### 3.3 Consulta y exportación

`/api/loc/:loc/audit` (módulo `audit`, **solo lectura**: no hay ninguna ruta para escribir, cambiar o borrar):

| Ruta | Para qué |
|---|---|
| `GET /` | Listado, el más nuevo primero. Filtros: fechas, cliente, categoría, acción exacta o prefijo (`note.`), quién (`operator`/`client`/`workflow`/`system`), entidad. Paginación por cursor (hasta 200). Resuelve el nombre del operador y el nombre actual del cliente |
| `GET /verify` | Recalcula la cadena: `{ ok, count, brokenAtSeq }` |
| `GET /export.csv` | Los mismos filtros, hasta 50 000 filas. UTF-8 con BOM, saltos CRLF, hora local de Puerto Rico y UTC, y celdas protegidas contra inyección de fórmulas. La exportación se registra **antes** de entregar el archivo |

Los parámetros se validan (una fecha, categoría o acción mal formada da 400, nunca llega al SQL) y los de una práctica no muestran las filas de otra.

**Interfaz.** Settings → **Audit log** (filtros, "Verify integrity" con banner verde o rojo, "Export CSV", filas expandibles con el detalle completo y la IP). En la ficha de cada cliente, **Access & change history** (se carga solo al abrirla).

### 3.4 Fecha de nacimiento y edad

`server/lib/age.ts`: edad exacta (cumpleaños el mismo día; el 29 de febrero cuenta el 1 de marzo en años no bisiestos), "hoy" en hora de Puerto Rico (a las 8 pm de allí ya es mañana en UTC), **adulto = 18 años o más**. Un cliente nuevo exige una fecha de nacimiento válida y no futura, tanto en el diálogo "Add contact" (el botón queda desactivado hasta ponerla) como en la API y en la reserva pública. Se guarda como el campo personalizado `date_of_birth` y **no se sobrescribe** si el cliente ya tenía una. El diálogo ahora muestra el mensaje de error de la API (antes fallaba en silencio).

### 3.5 Archivos

**Nuevos (21):** `server/lib/audit.ts`, `audit-vocab.ts`, `audit-csv.ts`, `age.ts`, `client-ip.ts`, `pipeline-moves.ts`; `server/repos/audit-repo.ts`; `server/routes/audit.ts`; `server/test-utils/pglite.ts` (base real en memoria para probar triggers y restricciones); `src/lib/audit-vocab.ts` (espejo web, con un test que falla si se desfasa del servidor); `src/features/audit/` (`AuditLogPage`, `AuditTable`, `ContactAudit`, `useAuditEntries`) y sus tests.

**Modificados (principales):** `db/schema.sql`, `server/db/database.ts` / `pglite-database.ts` / `fake-database.ts`, `server/routes/{auth,contacts,calendars,opportunities,public-booking,locations}.ts`, `server/repos/{contacts,appointments}-repo.ts`, `server/jobs/workflow-runner.ts`, `server/lib/{automation-vocab,booking-page}.ts`, `server/index.ts`, `src/features/contacts/{AddContactDialog,ContactDetail,ContactsPage}.tsx`, `src/lib/api.ts`.

---

## 4. Cómo probar lo hecho

| Qué | Cómo |
|---|---|
| Esquema, triggers y cadena | `npx vitest run server/db/audit-schema.test.ts` (base real PGlite: encadenado, aislamiento por práctica, inmutabilidad, detección de alteraciones, migración repetible) |
| Atomicidad cambio + auditoría | Los tests "against a real database…" de `server/routes/{contacts,opportunities,calendars}.test.ts` renombran la tabla de auditoría y comprueban que el cambio se revierte |
| Comportamiento fijo e integraciones | `server/index.test.ts` (ninguna integración montada por defecto y cada una monta exactamente sus rutas, compuertas de módulos, cabeceras en la API y en las páginas públicas, inactividad, estáticos); `server/lib/integrations.test.ts`; `server/lib/config.test.ts` |
| Seed | `server/lib/practice-seed.test.ts` (crea, es idempotente, no pisa ediciones, exige contraseña fuerte) |
| Aviso de inactividad en la web | Se verificó adelantando el reloj del navegador (Playwright `page.clock`): sin aviso a los 10 min, aviso a los 26 con "4:00", "Stay signed in" lo cierra y a los 31 min más sin actividad vuelve a `/login` |
| Verificación manual | Con una base y el seed, iniciar sesión, crear un cliente (con fecha de nacimiento), abrir su ficha y revisar Settings → Audit log |

---

## 5. Hallazgos y problemas resueltos

1. **`package-lock.json` dañado.** 18 de los 276 hashes de integridad no coincidían con los del registro de npm, así que `npm ci` fallaba con `EINTEGRITY` (entre otros: `zod`, `react`, `postcss`, `tslib`, `xtend`). En los 18 la **única** diferencia era `JF`→`AL` (en cualquier combinación de mayúsculas); los otros 258 coinciden exactamente. Es el rastro de un reemplazo de texto global sobre el repositorio, no de un paquete alterado. Se restauró cada valor al que publica el registro (`npm view <paquete>@<versión> dist.integrity`); versiones y URLs no cambiaron (commit `63ade70`, 18 líneas). Sin esto tampoco funcionaría el build de la imagen.
2. **`vault.test.ts` fallaba desde el commit inicial** (el código convierte el nombre en mayúsculas, `ALEX_…`, y el test definía `Alex_…`). Mismo tipo de daño; corregido en el test.
3. **Las fechas se perdían en el log** (`pg` devuelve `timestamptz` como `Date` y mi filtro las aplanaba a `{}`). Lo encontró un test con base real; corregido y con test propio.
4. **El límite de intentos de login se podía evadir:** tomaba la primera dirección de `X-Forwarded-For`, que el cliente puede falsificar. `clientIp` ahora toma la que añade nuestro balanceador (la última). Beneficia también a la IP que queda en el log.
5. **La CSP bloqueaba la fuente de Google Fonts** (y además la app enviaba la IP de la usuaria a Google): se eliminó la solicitud.
6. **Errores míos corregidos durante el trabajo** (todos cubiertos por tests): comillas escapadas y una ruta de `/social` mal envuelta en `App.tsx`; un parámetro por defecto en un test; `Response.text()` descarta el BOM del CSV; un carácter nulo en una consulta; una carrera de doble reserva imposible de provocar en una sola conexión PGlite (se simula el error de unicidad dentro de la transacción real).

---

## 6. Decisiones y diferencias respecto a los specs

| Tema | Decisión |
|---|---|
| **Sin flag global** (2026-11-06) | Se eliminó `PSYCRM_MODE`. Lo creé el día 1 para no tocar el comportamiento original de OpenLevel (y sus ~1 600 tests), pero fallaba hacia lo inseguro: olvidarlo en producción dejaba montadas las integraciones con terceros, sin cierre por inactividad y sin exigir SSL a la base, sin avisar. Ahora cabeceras, inactividad, compuertas de módulos, fecha de nacimiento obligatoria y SSL verificado son **siempre** así, y las integraciones son una lista explícita y vacía por defecto (`ENABLED_INTEGRATIONS`), para poder encenderlas una a una cuando haya un BAA. Cambios en las respuestas de la API: `/api/locations` ya no lleva `psycrm`; `enabledModules` sale siempre de la configuración de la práctica |
| Compuerta de módulos | Se registraba con dos patrones por grupo y cada petición consultaba los ajustes de la práctica **dos veces**; ahora es una (el patrón `/x/*` ya cubre `/x`) |
| `chain_seq` | La cadena se ordena por una columna propia, no por el `id` serial |
| Login fallido con un correo desconocido | **No se registra:** la tabla exige `location_id` y no hay práctica a la que asociarlo. Lo cubre el límite de intentos. El de una cuenta real se registra en cada una de sus prácticas |
| Automatizaciones | La auditoría es de **mejor esfuerzo**: si falla escribirla, la ejecución sigue (un fallo haría que la cola reintente y repita efectos reales como un email). Los efectos clínicos relevantes (cambio de etapa, citas) se auditan en su origen y **sí** hacen fallar la operación |
| `contact.viewed` | Se registra en cada apertura de la ficha (sin deduplicar) |
| Campos `phone`/`email` de contacto | Tipo `text` (el sistema de campos solo soporta text, textarea, number, date, dropdown, checkbox) |
| `is_minor` | Eliminado: la edad se calcula de la fecha de nacimiento |
| Login: `Bearer` | Exento del límite de inactividad |
| Código de respuesta de "crear contacto" | Sigue siendo 201 también cuando coincide con un cliente existente (comportamiento original) |
| `Dockerfile` | Se envía el `node_modules` completo (`tsx` es dependencia de desarrollo). Compilar el servidor a JavaScript y quitar las dependencias de desarrollo queda como endurecimiento posterior |

---

## 7. Pendiente, riesgos y deuda conocida

**Sin verificar**
- El build de la imagen Docker y el arranque en un contenedor real.
- Todo lo de AWS (RDS con SSL verificado, ECS, balanceador, SES, secretos). El código se probó contra PGlite, no contra un Postgres real: conviene una corrida de migración, seed y arranque contra un RDS (o un Postgres local) antes de salir a producción.
- La **concurrencia** del bloqueo que evita bifurcar la cadena entre conexiones simultáneas: PGlite atiende una consulta a la vez. Pendiente para el día 8, contra Postgres real.

**Sin hacer (por diseño del plan)**
- `moveOpportunityToStage` aún no lo usa nadie más que la ruta del tablero; `operator-tools.ts` (asistente de IA, apagado salvo que se habilite `ai`) debe migrarse si se reactiva.
- No se auditan todavía: editar la configuración de reservas de un calendario, borrar tarjetas, alta y baja de etapas.
- Una pantalla Settings → Modules (hoy `enabledModules` se cambia con SQL; ver `INTEGRACIONES.md` §5).
- MFA, esperas durables en las automatizaciones y el resto de la lista de la semana 2 (ver [`PLAN_MVP.md`](PLAN_MVP.md)).

**Riesgos a tener presentes**
- Las **notas libres del contacto** (`contact_notes`) se pueden editar y borrar para siempre. Quedan auditadas (sin su texto), pero **no son notas clínicas**: conviene ocultarlas cuando el módulo de notas de sesión esté activo (días 3-4).
- La **página pública de reservas sigue en inglés**; los textos para clientes en español (decisión 4 del plan) se tratan con las demás páginas públicas en el día 6.
- El **registro de un intento fallido de login con un correo inexistente** no existe (ver §6).
- El **`.gitignore` es nuevo**: antes un `git add -A` habría incluido `node_modules`.

---

## 8. Siguiente paso

Día 3: notas de sesión en el servidor ([`day-03-session-notes-backend.md`](specs/day-03-session-notes-backend.md)): tablas con el bloqueo a las 72 horas desde la creación impuesto por la base de datos, evaluación de riesgo obligatoria para firmar, revisiones y anexos inmutables, y las rutas con auditoría. Reutiliza `audit()`, `Database.transaction`, `reject_mutation()` y `server/test-utils/pglite.ts` del día 2.
