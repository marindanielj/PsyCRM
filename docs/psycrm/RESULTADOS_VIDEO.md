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

## Falta antes de usarlo con clientes

1. **IAM:** el rol de la tarea de ECS no tiene permisos de Chime (las tres llamadas que usa el servidor son crear sala, crear asistente y borrar sala; **confirmar los nombres exactos de las acciones en la documentación de IAM de Chime SDK antes de escribir la política**). Es un cambio en `infra/` que hay que revisar aparte; la prueba de infraestructura hoy afirma que el rol solo envía correo.
2. **`CHIME_REGION`** en el entorno de la tarea (por ejemplo `us-east-1`).
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
