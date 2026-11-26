# Resultados: sesiones por video integradas (B5, fase 2)

Construido el 25 de noviembre de 2026 sobre **Amazon Chime SDK** (confirmado por la terapeuta: está bajo el BAA de AWS). Spec original: [`specs/future-telehealth.md`](specs/future-telehealth.md).

## Qué hay

| Pieza | Dónde | Qué hace |
|---|---|---|
| Modalidad en la cita | `appointments.modality`, `calendars.default_modality` | `in_person`, `telehealth_video` o `phone`. La cita toma el valor de su calendario si no se elige otro. La nota usa el mismo vocabulario |
| Sala por cita | `video_meetings`, `video_meeting_events` | Una sala por cita. Guarda solo la hora de cada entrada y salida: **sin grabación, sin contenido** |
| Enlace del cliente | `/v/<token>` | Español, para teléfono. Confirma dónde está, si está en Puerto Rico y si está en un lugar privado; sala de espera; entra cuando la terapeuta le admite |
| Sala de la terapeuta | `/api/loc/:loc/video/appointments/:id/room` | Ve lo que el cliente confirmó, **admite**, conduce la sesión y puede **terminarla para todos** |
| Agenda | botones **Join video** y **Copy message** | Abren la sala; copian el texto listo para pegar (hora en hora de Puerto Rico, enlace, 15 minutos antes) |
| Aviso de consentimiento | al agendar y en la sala | Si el cliente no firmó el consentimiento de telepsicología: aviso, **nunca bloqueo** |

## Reglas

- **Vigencia del enlace:** desde 15 minutos antes del inicio hasta **60 minutos después del fin programado**. Fuera de eso la página dice "aún no está abierta" o "ya terminó".
- **El enlace** se deriva del id de la sala con un HMAC de `SESSION_SECRET`, así se puede volver a copiar; en la base de datos solo queda su sha256. Rotar `SESSION_SECRET` invalida los enlaces emitidos.
- **El cliente no entra** hasta que la terapeuta abrió la sala y le admitió.
- **Auditoría:** `appointment.video_started`, `appointment.video_admitted`, `appointment.video_ended` (sin contenido). Entradas y salidas, en `video_meeting_events`.
- Las rutas de video **solo existen si `CHIME_REGION` está definida**. Sin ella no hay botones ni página `/v`.

## Abrir, editar y borrar una cita

Pedido el mismo día: no había forma de abrir una cita para ver sus detalles ni de modificarla o borrarla.

- **Abrir:** pulsar una cita en el mes o en la agenda (también con Enter) abre una ventana con sus detalles: hora, calendario, cliente, cómo se realiza, lugar, notas, estado, y **Join video** / **Copy message** si es por video.
- **Editar:** título, cliente, fecha, hora, duración, modalidad, lugar, notas y estado, en una sola petición (`PATCH /appointments/:id`). El servidor aplica detalles, cambio de hora y cambio de estado **juntos o ninguno**: si el nuevo horario ya está ocupado, tampoco se guarda el título.
- **Borrar:** `DELETE /appointments/:id`. Pide confirmación. Un cargo hecho a partir de la cita **no se toca** (guarda el id solo como información).
- **No se puede borrar** una cita con **nota de sesión** (el mensaje sugiere marcarla como cancelada) ni con una **sala de video en curso**.
- **Modalidad:** no se puede cambiar en una cita **completada** (el lugar de servicio de la facturación depende de ella) ni **mientras la sala de video está en curso** (termínela primero desde la sala). Pasar a video sin consentimiento firmado avisa, no bloquea.
- **Bitácora:** `appointment.updated` (solo **nombres** de campos, nunca el texto; la modalidad con de/a), y por fin se usa `appointment.deleted`.
- **Cliente:** el cliente de una cita tiene que ser de esta práctica, al agendar y al editar (antes, agendar aceptaba el id de un cliente de otra práctica).

## Primera llamada real (26 de noviembre de 2026): no conectó

La primera prueba con Chime real falló en los dos lados con "No pudimos conectar la sesión". Causas y arreglos:

1. **`ReferenceError: global is not defined`** (la causa de que ningún lado conectara). El código de Chime en el navegador espera el objeto `global` de Node y el modo biblioteca de Vite no lo define; la llamada moría al empezar. Arreglo: `define: { global: 'globalThis', 'process.env.NODE_ENV': … }` en `vite.video.config.ts`, con una prueba que lo vigila. Las pruebas anteriores con un Chime simulado nunca llegaban a iniciar una llamada, por eso no lo vieron.
2. **Admitir antes de abrir la sala dejaba al cliente sin sala.** Ahora **Admit abre la sala** (si Chime no la puede abrir, no se admite a nadie y la terapeuta ve el motivo).
3. **Un solo mensaje genérico para todo.** Ahora cada fallo dice qué pasó: sala aún no abierta, servicio de video no disponible (502), librería no cargada, permisos de cámara/micrófono, o "la llamada se interrumpió (código: …)" con el estado del SDK de Chime. Una llamada que no conecta en **25 segundos** se declara fallida en vez de quedarse en negro, y mientras tanto se ve "Conectando…".
4. **La bitácora del servidor no decía nada** (`request failed … unknown`). Ahora un fallo de Chime registra la **llamada** (`createMeeting`, `createAttendee`, `endMeeting`) y el **nombre del error** de Amazon (por ejemplo `AccessDeniedException`), sin ids, nombres ni texto del mensaje.

### Segunda prueba (26 de noviembre de 2026): la llamada arrancó, pero…

5. **La pantalla del cliente volvía a "Su terapeuta le espera" mientras el navegador pedía permiso de cámara y micrófono.** La página consulta cada 3 segundos si la terapeuta ya admitió; si sí y todavía no hay llamada, mostraba otra vez la tarjeta de espera. Mientras la persona tarda unos segundos en pulsar "Permitir" no existe aún la llamada, así que la consulta cambiaba la pantalla y, después de "Permitir", nadie la volvía a cambiar. Arreglo: la página recuerda que está entrando (`busy`) y la consulta no toca la pantalla hasta que la llamada arranque o falle. Mismo cuidado en la sala de la terapeuta (el botón "Open the room" ya no se reactiva solo mientras la llamada arranca). Las pruebas anteriores aceptaban el permiso al instante, antes de la primera consulta, por eso no lo vieron.
6. **Los dos paneles de video salían negros en la sala de la terapeuta.** La cámara propia se activaba **antes** de registrar el oyente de eventos del SDK, que anuncia el cuadro de video una sola vez, así que nunca se mostraba. Arreglo: el oyente se registra primero; la vista previa propia sale **directamente de la cámara** (no depende de ningún evento de la reunión); el video propio se envía cuando la llamada ya arrancó; y al terminar se apaga la cámara. Si la otra persona aún no entró, el panel grande dice "Esperando…" (antes era un cuadro negro sin explicación).

Para probarlo en local sin Chime real: `npm run build` y luego `DEV_FAKE_VIDEO=1 npm run dev:local` (sirve el paquete de la llamada; no conecta ninguna llamada).

## Falta antes de usarlo con clientes

1. **IAM y región (hecho en el código, falta desplegar):** `infra/` tiene ahora el ajuste `enableVideo`, **apagado por defecto**. Encendido (`-c enableVideo=true`), el rol de la tarea recibe **solo** `chime:CreateMeeting`, `chime:CreateAttendee` y `chime:DeleteMeeting` (nombres confirmados en la [referencia de autorización de servicio de AWS](https://docs.aws.amazon.com/service-authorization/latest/reference/list_chime.html)) y la app recibe `CHIME_REGION` (= la región del despliegue, `us-east-1`). Chime no admite limitar `CreateMeeting` a un recurso, así que la declaración va con `Resource: *`; las otras dos quedan igual, porque el formato del ARN de una reunión no se pudo probar antes de un despliegue.
   - Para encenderlo, agregar `-c enableVideo=true` al `cdk deploy` (junto con los demás `-c` de siempre).
   - **Cuidado:** si se vuelve a ejecutar `cdk deploy` **sin** esa bandera, se **quita** el permiso y las rutas de video dejan de existir. Es el mismo cuidado que ya hay con `imageTag`.
   - Con el ajuste apagado el rol queda exactamente como antes (solo enviar correo); la prueba que lo afirma sigue vigente y hay otra que exige que, encendido, sean exactamente esas tres acciones.
2. **Desplegar** con la bandera y comprobar en el navegador que la agenda muestra **Join video** (el botón solo aparece cuando la app tiene video).
3. **Probar con llamadas reales** desde un teléfono y desde un computador, incluida una conexión mala y un cliente que se cae y vuelve a entrar. Todo lo verificado hasta aquí fue contra un Chime simulado.
4. Confirmar la **tarifa vigente** de Chime SDK por minuto y participante.

## Límites conocidos

- **No hay correo ni recordatorio automático de citas** en PsyCRM (ni confirmación ni recordatorio con tiempo). Por eso el enlace va en **Copy message**, que la terapeuta pega en WhatsApp o SMS. Un recordatorio automático sería una pieza nueva (un disparador por tiempo en los flujos).
- La zona horaria que se muestra en la sala y en el mensaje es la de Puerto Rico, fija.
- No se identifica al cliente más allá del enlace: quien tenga el enlace y llegue a la sala de espera es admitido solo si la terapeuta lo decide.
- El consentimiento se busca por la plantilla sembrada `telepsychology`; una plantilla propia con otro nombre de familia no cuenta.

## Verificado

- Pruebas de servidor: vigencia del enlace, token, proveedor de Chime (con un cliente simulado), rutas de la terapeuta, rutas públicas y el flujo completo contra Postgres real (PGlite), incluida la aplicación ensamblada (CSP propia de la sala, 401 sin sesión, rutas ausentes con el video apagado).
- Navegador real (Chromium, perfil de teléfono): el cliente confirma y espera; la sala de la terapeuta muestra lo confirmado; al admitir, la página del cliente pasa a "lista". Sin errores de consola con la CSP estricta.
