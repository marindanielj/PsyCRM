# Futuro (B5): telesalud

**Estado:** planificado, **no construido**. Post-MVP. Recoge la conversación del 12 de noviembre de 2026.

## Lo que ya existe
- **Notas de sesión:** modalidad `in_person`, `telehealth_video` o `phone`.
- **Billing:** a partir de la modalidad, el cargo sugiere el lugar de servicio 02 o 10 (se elige en Settings → Billing) y el modificador 95 (video) o 93 (teléfono).
- **Documentos:** plantilla "Consentimiento para telepsicología" (lugar privado, teléfono de contingencia, ubicación física al inicio de cada sesión).
- **AWS:** el BAA de AWS ya está aceptado para la organización (`INFRA_AWS.md`, paso 1.3).

## Cómo lo hacen otras plataformas
SimplePractice y sistemas parecidos traen el video **integrado**: la terapeuta pulsa **Join** en la cita y el cliente entra desde un enlace del recordatorio o de su portal, en el navegador, sin instalar nada y con sala de espera. El BAA es el mismo de la plataforma y el costo va en el plan. Por dentro, estas plataformas suelen apoyarse en un servicio de video por API en lugar de construir el video desde cero.

## Las dos rutas

### Fase 1: sala fija
Un enlace de video que **no cambia** (por ejemplo, la sala de Doxy.me o la sala personal de Zoom for Healthcare, siempre con sala de espera). Ella lo guarda una vez en Settings y PsyCRM lo pone donde corresponde. PsyCRM no le envía datos del cliente a la plataforma. La plataforma necesita su **propio BAA** con ella. Esfuerzo: uno o dos días.

### Fase 2: video integrado con Amazon Chime SDK
Es el mismo modelo de SimplePractice, con **un enlace por cita**. **Amazon Chime SDK** es el servicio de video de AWS y quedaría bajo el **BAA de AWS que ya está aceptado**: no hace falta un proveedor nuevo ni otro BAA, y todo queda en la misma cuenta. **Verificar antes de construir** que Chime SDK aparece en la lista de servicios elegibles para HIPAA de AWS.

Qué se construye:
1. Una reunión por cita, creada por el servidor al pulsar **Join** o al llegar la hora.
2. Una página del cliente `/v/<token>` (como `/d` y `/b`): español, apta para teléfono, sala de espera y confirmación de ubicación al entrar.
3. **Join** en la cita para la terapeuta, que admite al cliente desde la sala de espera.
4. Sin grabación. Auditoría de entradas y salidas con hora, sin contenido.
5. El enlace en la confirmación y el recordatorio, y **Copy message** mientras SES siga en sandbox.

Costo: Chime SDK cobra por minuto de cada participante; una sesión de 50 minutos con dos personas cuesta centavos (confirmar con la tarifa vigente). Esfuerzo: una o dos semanas, sobre todo por las pruebas en teléfonos y conexiones malas (cámara, micrófono, reconexión).

## Común a las dos fases
- **Modalidad en la cita** (`appointments` hoy no la tiene) y un valor por defecto por calendario. La nota la hereda.
- **Aviso de consentimiento:** al agendar por video, avisar si el cliente no firmó el consentimiento de telepsicología (aviso, no bloqueo).
- **Seguridad en cada sesión:** en una nota por video o teléfono, dónde está físicamente el cliente, si está en Puerto Rico (licencia), si está en un lugar privado y el teléfono de contingencia confirmado.
- **Reserva pública (opcional):** permitir elegir "por video" solo en los calendarios donde ella lo active.
- **No se usa Google Meet con una cuenta de Gmail personal:** Meet solo tiene BAA con Google Workspace de pago.

## Preguntas para ella
1. ¿Qué plataforma usa hoy para el video? ¿Tiene BAA con esa plataforma?
2. ¿Su Gmail es Google Workspace de pago o personal?
3. ¿Le basta una sala fija para empezar?
4. ¿Los clientes pueden elegir video al reservar, o lo decide ella?
5. ¿Atiende solo a clientes que estén en Puerto Rico?
