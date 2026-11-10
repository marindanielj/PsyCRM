# Extra: sincronización de calendario por `.ics`

**Estado:** construido y probado (typecheck limpio; pruebas de librería, repositorio, rutas y base de datos en PGlite). Apagado por defecto: ver "Cómo se enciende". Diseño de origen: [`../INTEGRACIONES.md`](../INTEGRACIONES.md) §3.1.

## Por qué

La terapeuta no tiene horario fijo: su calendario de referencia es el del teléfono y las citas se acomodan alrededor de su vida personal. Necesita (1) ver sus citas en el teléfono y (2) que el sistema no ofrezca a un cliente un rato que ella ya tiene ocupado, **sin enviar datos de clientes a Google o Apple y sin OAuth**.

## Regla de oro

**Solo se intercambian bloques "ocupado". Nunca títulos, nombres, motivos ni notas, en ninguna dirección.** Se hace cumplir en el código, no en la disciplina:

| Dirección | Cómo se garantiza |
|---|---|
| PsyCRM → teléfono | `buildFeed` solo recibe un id, un inicio, un fin y una marca de tiempo. No existe un parámetro por el que un nombre pueda llegar. El título es una de dos palabras fijas por constraint de la base de datos (`Cita` u `Ocupado`) |
| Teléfono → PsyCRM | `parseBusyBlocks` devuelve solo `{ start, end }`. `SUMMARY`, `DESCRIPTION`, `LOCATION` y los asistentes no se copian a ningún lado al leer. Además, los bloques que se solapan se **fusionan**, así el resultado ni siquiera revela cuántos eventos había |

Las pruebas lo verifican de punta a punta: se leen eventos con título, nota y teléfono, y se comprueba que **ninguno de esos textos existe en ninguna tabla** (bloques, calendarios ni auditoría).

## Qué incluye

### 1. Feed de salida (la práctica → su teléfono)
- `GET /cal/<token>.ics`. Sin sesión: el token (256 bits) es la credencial. Se guarda **solo su hash SHA-256**; la dirección completa se muestra **una sola vez**, al crearla o reemplazarla.
- Una dirección por práctica. **Reemplazar** (`POST /feed?replace=1`) mata la anterior al instante; **apagar** (`DELETE /feed`) mata todas. Crear sin pedir reemplazo cuando ya existe responde 409, para que un clic perdido no rompa la suscripción del teléfono.
- Cualquier dirección mala (mal formada, desconocida, revocada, reemplazada) recibe **el mismo 404 de texto plano**: la respuesta no revela si un token existió.
- Cabeceras: `text/calendar`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `nosniff`.
- Publica las citas no canceladas de los últimos 30 días y los próximos 365, de **todos** los calendarios de la práctica. Cada una sale como `UID:appt-<id>@psycrm` para que el teléfono la actualice en vez de duplicarla.
- Cada lectura se cuenta; la **auditoría registra una línea por día como máximo** (un teléfono consulta cada pocas horas y llenaría el log).

### 2. Calendarios personales (su teléfono → la práctica)
- Ella pega la dirección secreta `.ics` de su calendario (Google: "dirección secreta en formato iCal"; iCloud: calendario público, `webcal://` se convierte a `https://`). Hasta 5 por práctica.
- **Se lee antes de guardarse.** Una dirección con un error de dedo, un enlace equivocado o una página que no es un calendario se informa en el momento (422 con un código corto) y **no queda nada guardado**.
- La dirección se guarda **cifrada** (AES-256-GCM, clave derivada de `SESSION_SECRET` con HKDF, etiqueta propia) porque el lector debe poder usarla. **Nunca se devuelve por la API**: la pantalla solo muestra el servidor (`calendar.google.com`). Si se rota `SESSION_SECRET`, las direcciones guardadas no se pueden abrir y la pantalla pide reconectar (`secret_unreadable`).
- Un trabajo de pg-boss (`calendar.sync`, cada 5 minutos) lee los calendarios cuyo último intento tenga más de 9 minutos. "Sync now" desde la pantalla, con un mínimo de 60 s entre lecturas.
- **Si una lectura falla, se conservan los bloques anteriores** (una conexión inestable no debe liberar de golpe una tarde que ella bloqueó). El fallo queda como un código corto (`unreachable`, `timeout`, `http_error`, `not_calendar`…), nunca la respuesta ni la dirección. Solo el **primer** fallo seguido se audita.
- Pausar un calendario borra sus bloques (deja de bloquear tiempo); al reanudar vuelven en la próxima lectura. Quitarlo borra el calendario y sus bloques.

### 3. Qué hace con la agenda
- **Reserva pública y agente de IA:** `calendarBusyFor` suma los bloques personales a los de las citas, para **todos** los calendarios de la práctica (es una sola persona). Un horario bloqueado en su teléfono deja de ofrecerse. Un bloque de otra práctica nunca afecta a esta.
- **Agenda (vista mensual):** los bloques salen como chips grises "Busy 11:00 AM – 12:00 PM" ("All day" si cubren el día), recortados por día.
- **Aviso, no bloqueo:** al crear o mover una cita encima de un bloque personal, la API responde con `warnings: ['overlaps_personal_calendar']` y la agenda muestra "Booked. That time overlaps something in your personal calendar." Ella puede reservar encima a propósito.

### 4. Pantalla
**Settings → Calendar sync** (en inglés). Explica la regla de oro y la latencia, muestra la dirección una sola vez con pasos para iPhone y Google, y permite cambiar el título, reemplazar o apagar la dirección; conectar, sincronizar, pausar y quitar calendarios, con mensajes claros por cada código de error. Un test comprueba que **cada código que la base de datos puede registrar tiene un mensaje legible**.

## Seguridad de la lectura (SSRF)

Leer una dirección que escribe un usuario, desde un servidor dentro de la red de la práctica, es el patrón clásico de *server-side request forgery*. Controles (`server/lib/ssrf.ts`, con pruebas):

- Solo `https`. `http`, `file`, `javascript` y credenciales en la dirección se rechazan.
- Nombres locales (`localhost`, `.local`, `.internal`, `.lan`) y direcciones IP privadas, de enlace local (incluida la de metadatos de la nube `169.254.169.254`), de loopback, CGNAT, multicast y reservadas se rechazan, **también en IPv6** y en formas disfrazadas (IPv4 mapeado, NAT64, 6to4, `2130706433`, `0x7f.1`).
- **La comprobación se hace al conectar**, en el `lookup` del propio socket: un nombre que resuelve a una dirección privada, o que cambia entre la comprobación y la conexión (*DNS rebinding*), se rechaza. Basta una respuesta privada entre varias para rechazar.
- Cada redirección se vuelve a comprobar; máximo 3.
- Tope de 5 MB y de 10 s en total. `Accept-Encoding: identity`.
- No se acepta la propia dirección del feed de la práctica (`own_feed`), que devolvería las citas como "ocupado" y las bloquearía.

## Cómo se enciende

1. Añadir `calendar_sync` a `ENABLED_INTEGRATIONS` en la definición de la tarea de ECS y desplegar. Sin BAA, pero siguiendo los pasos 3 a 7 de [`INTEGRACIONES.md` §4](../INTEGRACIONES.md) (lo que cruza ya está descrito arriba) y registrándolo en su §6.
2. La pantalla aparece con el módulo `calendars` (ya activo por defecto). Sin la integración, la ruta responde 404 y la pantalla dice que no está activada en esta instalación.
3. Para probarla en local: `DEV_ENABLE_CALENDAR_SYNC=1 npm run dev:local` (el trabajo de lectura periódica no corre en el servidor de desarrollo; "Sync now" sí).

## Limitaciones conocidas

- **No es tiempo real.** Google puede tardar horas en refrescar un feed suscrito; Apple, menos. Un cambio hecho aquí tarda en verse en el teléfono. Lo contrario (su teléfono → aquí) tarda hasta ~15 minutos.
- **Solo calendarios en la nube** (Google o iCloud): uno guardado solo en el aparato no tiene dirección.
- **Reglas de repetición:** se expanden DAILY, WEEKLY, MONTHLY y YEARLY con INTERVAL, COUNT, UNTIL, BYDAY (con ordinales), BYMONTHDAY, BYMONTH, EXDATE, RDATE e instancias modificadas o canceladas. Una regla con `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY` o `BYHOUR` no se expande: el evento bloquea solo su primera ocurrencia y la lectura lo cuenta (`unsupportedRules`). Es el lado conservador para un caso poco común.
- **Zonas horarias:** nombres IANA y los nombres de Windows más comunes de EE. UU./Puerto Rico. Una zona desconocida usa la de la práctica (`settings.timezone`, o la del primer calendario, o `America/Puerto_Rico`).
- **Eventos "libres":** los marcados `TRANSP:TRANSPARENT` (o "libre" de Outlook) y los cancelados no bloquean.
- El feed no se limita por frecuencia; el token de 256 bits hace inviable adivinarlo y la consulta es una búsqueda por hash.

## Decisiones tomadas sin consultar

- **El bloqueo es para toda la práctica**, no por calendario (una práctica = una persona). Si algún día hay varios terapeutas (B9), pasa a ser por usuario.
- **La disponibilidad sigue siendo "horas semanales fijas, menos lo ocupado"**. La idea del §3.1 de "abierto por defecto, bloqueado por su calendario" (cambia el cálculo de `server/lib/availability.ts`) **queda pendiente de que ella lo confirme**; este extra no la necesita.
- **Títulos en español** (`Cita` / `Ocupado`) porque se muestran en su teléfono personal, no en la interfaz de la terapeuta. Es una constraint de base de datos.
- **Confirmado (2026-11-10):** su calendario de referencia es **Google (Gmail)**. No cambia el código; sí significa que la lectura de su calendario depende de la "dirección secreta en formato iCal", que Google solo muestra en la versión web (Configuración del calendario → Integrar calendario) y que un administrador de Google Workspace puede desactivar. Y que el feed de salida hacia su teléfono lo refrescará Google con retraso de horas si lo suscribe en Google Calendar; en un iPhone con el calendario de Apple se refresca antes.

## Archivos

`db/schema.sql` (3 tablas) · `server/lib/ics.ts` (feed y lector, puros) · `server/lib/ssrf.ts` · `server/lib/secret-box.ts` · `server/lib/calendar-sync.ts` · `server/repos/calendar-sync-repo.ts` · `server/routes/calendar-sync.ts` · `server/jobs/boss.ts` (`registerCalendarSyncWorker`) · `server/lib/booking-availability.ts` · `server/routes/calendars.ts` (avisos) · `src/features/settings/CalendarSyncSettingsPage.tsx` · `src/features/calendars/MonthView.tsx` · `src/lib/calendar-sync.ts`.
