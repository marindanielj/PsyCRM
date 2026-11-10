# Integraciones y módulos: cómo se activan (y cuándo)

> PsyCRM **no tiene un "modo"**: es el producto. Lo que sí tiene son dos niveles de interruptores, y los dos están apagados por defecto en todo lo que mueve datos de clientes a un tercero. Este documento explica cómo se vuelve a encender cada cosa cuando exista un acuerdo HIPAA (BAA) con el proveedor.
>
> Contexto: antes existía la variable `PSYCRM_MODE`. Se eliminó (2026-11-06) porque fallaba hacia lo inseguro: olvidarla en producción dejaba las integraciones montadas sin avisar. Ahora **lo seguro es lo que ocurre si no se hace nada**.

---

## 1. Los dos niveles

| | **Módulos** | **Integraciones** |
|---|---|---|
| **Qué controla** | Qué partes del producto ve y puede usar una práctica (menú, páginas, rutas de la API) | Si el servidor **monta** código que envía o recibe datos de un proveedor externo |
| **Dónde se configura** | Por práctica, en la base de datos: `locations.settings.enabledModules` | Por despliegue, en una variable de entorno: `ENABLED_INTEGRATIONS` |
| **Valor por defecto** | Contactos, etiquetas, oportunidades, tareas, calendarios, automatizaciones, dashboard, documentos, notas de sesión y auditoría | **Ninguna** |
| **Si está apagado** | El menú no lo muestra, la página redirige al inicio y la API responde 404 | Las rutas **no existen** (404) y no se crea ningún cliente del proveedor |
| **Código** | `server/lib/modules.ts`, `server/middleware/module-gate.ts` | `server/lib/integrations.ts`, `server/index.ts` |

Un módulo y una integración suelen ir juntos, pero no son lo mismo: el módulo `conversations` muestra la bandeja en la interfaz; la integración `chatwoot` es lo que recibiría los mensajes que la alimentan. Para usar de verdad una función hay que encender **las dos cosas** (§3 dice cuáles).

---

## 2. Integraciones (variable `ENABLED_INTEGRATIONS`)

Valor: nombres separados por comas, por ejemplo `ENABLED_INTEGRATIONS=voice,payments`. Vacío o ausente = ninguna.

| Nombre | Qué monta | Proveedor que recibe datos | Variables / secretos que además necesita |
|---|---|---|---|
| `chatwoot` | `POST /api/webhooks/chatwoot` (mensajes entrantes) y el disparador "mensaje recibido" de las automatizaciones | El servidor de Chatwoot y los canales detrás de él (SMS, WhatsApp, email…) | `CHATWOOT_WEBHOOK_SECRET` (≥ 32 caracteres; en producción deja de aceptar el valor de desarrollo) |
| `calendar_sync` | `GET /cal/<token>.ics` (el feed de la práctica), `/api/loc/:loc/calendar-sync` y el trabajo que lee sus calendarios personales cada 5 minutos | El servidor del calendario cuya dirección ella pega (Google, Apple…). **Solo cruzan bloques de tiempo, nunca datos de clientes** | Ninguno: usa `SESSION_SECRET` para cifrar la dirección que ella pega. Ver §3.1 |
| `ai` | Cliente de IA (Claude), el worker de respuestas del agente, las rutas del asistente y el canal de texto con aprobación | Anthropic (y el *gateway* de texto) | Clave de Anthropic por práctica; `GATEWAY_TEXT_URL`, `INTERNAL_PUSH_SECRET` |
| `public_pages` | Páginas públicas de marketing: embudos, formularios, reseñas, cursos, blog, comunidades, encuestas, propuestas, enlaces de seguimiento y afiliados | Ninguno directamente, pero los visitantes envían datos personales a páginas sin sesión | — |
| `payments` | `/api/public/pay` (avisos de Stripe o Square) | Stripe o Square | Claves del proveedor por práctica |
| `voice` | `/api/public/voice` (reportes de llamadas) | Twilio o Vapi | Claves del proveedor por práctica |
| `federation` | `/federation/*` | El *gateway* del hub | `FEDERATION_SERVICE_TOKEN` (≥ 32 caracteres en producción) |
| `push` | `/api/push-tokens` (y las notificaciones push de mensajes entrantes) | El proveedor de notificaciones push | `GATEWAY_PUSH_URL`, `INTERNAL_PUSH_SECRET` |

**Cómo se comporta el servidor**
- Un nombre desconocido **detiene el arranque** con un error que lista los válidos (así un error de tipeo nunca parece funcionar).
- Al arrancar imprime una línea con **solo los nombres** habilitados (`integrations enabled: none`), para que quien revise el registro vea de un vistazo qué proveedores están conectados.
- La reserva pública (`/api/public/booking`) **no** es una integración: siempre está montada, y los calendarios arrancan con las reservas apagadas.
- Las pruebas (`server/index.test.ts`) comprueban, leyendo el enrutador, que ninguna integración está montada por defecto y que cada una monta exactamente sus rutas y las de nadie más.

---

## 3. Módulos que dependen de un tercero

Estos módulos están **apagados por defecto** (no están en la lista de arriba del §1). Antes de encenderlos para una práctica, hay que resolver el proveedor que usan:

| Módulo | Qué usa fuera de PsyCRM | También hay que habilitar | Pendiente antes de usarlo con clientes |
|---|---|---|---|
| `conversations` | Los mensajes llegan por Chatwoot | `chatwoot` | BAA con Chatwoot (y con el canal: SMS/WhatsApp/email) |
| `assistant` | Anthropic | `ai` | BAA con Anthropic y retención cero de datos |
| `marketing` | Brevo (email) o Twilio (SMS), según Settings → Email & SMS | — | BAA con el proveedor de envío elegido |
| `calls` | Twilio o Vapi, según Settings → Voice | `voice` (para los reportes) | BAA con el proveedor de voz |
| `payments` | Stripe o Square | `payments` | Confirmar con el proveedor qué datos de clientes reciben y su política HIPAA |
| `social` | Facebook, Instagram, LinkedIn, X | — | No debe llevar datos de clientes; revisar el contenido que se publica |
| `reputation` | Google y Facebook (reseñas) | — | Las reseñas son públicas; no responder con datos clínicos |
| `sites`, `forms`, `surveys`, `proposals`, `blog`, `communities`, `memberships`, `trigger_links`, `affiliates` | Páginas públicas sin sesión | `public_pages` | Revisar qué datos personales recogen y añadir el texto de privacidad; las páginas públicas llevan un script en línea, por lo que hoy salen **sin** política CSP |
| `calendar_sync` (**construido**; apagado hasta encenderlo en `ENABLED_INTEGRATIONS`) | Calendarios del teléfono de la terapeuta (Google o iCloud) por URL `.ics`, **sin OAuth** | `calendar_sync` | Sin BAA: solo cruzan bloques de tiempo, nunca datos de clientes (ver §3.1) |
| `documents` (día 5-6) y la invitación al cliente | Correo de Amazon SES para enviar los enlaces y los códigos (adaptador **ya escrito**; ver [`CORREO_SES.md`](CORREO_SES.md)) | — | Cubierto por el BAA de AWS **si** SES figura en la lista de servicios elegibles (tarea 1.4 de `INFRA_AWS.md`). Falta la cuenta de AWS, la identidad verificada y salir del *sandbox* |

### 3.1 Sincronización de calendario por `.ics` (construida)

> **Estado:** construida y probada (spec: [`specs/extra-calendar-sync.md`](specs/extra-calendar-sync.md)). Para usarla hay que añadir `calendar_sync` a `ENABLED_INTEGRATIONS` y seguir el §4. Pantalla: **Settings → Calendar sync**.

**Por qué:** la terapeuta no tiene horario fijo; su calendario de referencia es el del teléfono y las citas se acomodan alrededor de su vida personal. Se necesita ver todo en un solo calendario, sin enviar datos de clientes a Google o Apple.

**Regla de oro: solo se intercambian bloques "ocupado". Nunca títulos, nombres, motivos ni notas, en ninguna dirección.**

| Dirección | Qué hace | Qué cruza |
|---|---|---|
| **Salida** (PsyCRM → teléfono) | Feed `.ics` por URL con token secreto (regenerable y revocable). Ella lo suscribe en su teléfono. | Inicio, fin y el título genérico "Cita" (o "Ocupado"). Sin nombre, sin motivo, sin enlace a la nota. |
| **Entrada** (teléfono → PsyCRM) | Ella pega en Settings la dirección `.ics` secreta de su calendario (Google: "dirección secreta en formato iCal"; iCloud: calendario compartido por enlace). PsyCRM la lee cada pocos minutos. | Se guardan **solo inicio y fin**; el título y la descripción se descartan al leer. Se muestran como bloques grises "Busy"; restan a los espacios ofrecidos y avisan si se agenda encima. |

**Controles:**
- Auditoría: feed generado/consultado, token regenerado o revocado, calendario conectado o desconectado (sin la URL en el log; la URL entrante es un secreto).
- Seguridad de la lectura: solo `https`, bloquear IPs privadas y de enlace local (SSRF), límite de tamaño y de tiempo, redirecciones limitadas.
- El token de salida y la URL de entrada se guardan como secretos, no se imprimen en logs.
- Pantalla de configuración con la advertencia de latencia (abajo).

**Limitaciones que se le deben explicar a la usuaria:**
- **No es tiempo real.** Google puede tardar horas en refrescar un feed suscrito; Apple permite intervalos más cortos. Un cambio hecho en PsyCRM puede tardar en verse en el teléfono.
- **Solo funciona con calendarios en la nube** (Google o iCloud). Un calendario guardado únicamente en el aparato no tiene URL.
- **Pendiente de decidir:** su modelo de disponibilidad hoy son horas semanales fijas. Para ella puede convenir "abierto por defecto, bloqueado por su calendario", lo que cambia el cálculo en `server/lib/availability.ts`.
- **Por confirmar con ella:** ¿su calendario de referencia está en iCloud o en Google?

Sigue el procedimiento del §4 (aunque no requiere BAA, deben cumplirse los pasos 3 a 7).

---

## 4. Lista de verificación para encender una integración

Hágase **una a la vez**, y no por conveniencia ("lo probamos un rato"):

1. **BAA firmado** con el proveedor, guardado fuera del repositorio, con fecha y referencia anotadas en el registro del §6.
2. **Qué datos salen.** Revisar el código de esa integración y escribir en el registro qué información de clientes cruza (nombres, teléfonos, texto de mensajes…). Si hay una alternativa que no la envíe, preferirla.
3. **Auditoría.** Confirmar que lo que se haga a través de esa integración queda en el log de auditoría (por ejemplo: un mensaje enviado, una llamada, un cobro). Si no, **añadirlo antes de encenderla**; hoy esas rutas no están instrumentadas.
4. **Secretos.** Cargar las claves en AWS Secrets Manager (nunca en el repositorio ni en la definición de la tarea) y comprobar que no aparecen en los logs.
5. **Encender.** Añadir el nombre a `ENABLED_INTEGRATIONS` en la definición de la tarea de ECS y desplegar. Comprobar en el registro de arranque que aparece, y que **solo** aparece esa.
6. **Probar** con un cliente ficticio de punta a punta, incluido que lo que debía quedar auditado quedó.
7. **Registrar** la fecha y la persona en el §6.

Para **apagarla** de nuevo basta con quitar el nombre y desplegar: no hace falta borrar código ni datos.

---

## 5. Cómo se enciende un módulo para una práctica

Hoy no existe una pantalla para esto (es un pendiente: Settings → Modules). Se hace con una sentencia SQL sobre la práctica, **una vez resueltos los pendientes de su fila en el §3**:

```sql
-- Ver lo que tiene hoy
SELECT settings->'enabledModules' FROM locations WHERE slug = '<slug-de-la-practica>';

-- Fijar la lista completa (reemplaza la anterior; incluya los módulos que ya tenía)
UPDATE locations
SET settings = jsonb_set(settings, '{enabledModules}',
  '["contacts","tags","opportunities","tasks","calendars","automations","reporting","documents","session_notes","audit","marketing"]')
WHERE slug = '<slug-de-la-practica>';
```

Los nombres válidos están en `server/lib/modules.ts`; uno que no exista se ignora. Si la práctica **no** tiene la clave `enabledModules`, recibe la lista por defecto del §1. Un cambio se nota en unos 5 segundos (la API guarda el resultado en memoria ese tiempo) y en la web al recargar.

---

## 6. Registro de integraciones y módulos habilitados

> Mantener al día. Una fila por cada vez que se enciende algo; si se apaga, añadir otra fila (no borrar).

| Fecha | Qué (integración o módulo + práctica) | Proveedor | Referencia del BAA | Datos que cruzan | Quién lo autorizó |
|---|---|---|---|---|---|
| 2026-11-06 | *(ninguna)* | — | — | — | — |

---

## 7. Deuda conocida

- **Sin pantalla de módulos:** cambiar `enabledModules` requiere SQL (§5).
- **Las rutas de esas integraciones no están auditadas** (mensajes, llamadas, cobros). Es el punto 3 de la lista de verificación y debe hacerse caso por caso al encenderlas.
- **Las páginas públicas** (`public_pages`, y los documentos del día 6) salen sin política CSP porque llevan un script en línea. Pasarlas a *nonces* permitiría aplicar la CSP estricta también allí.
- **Las notas libres del contacto** no son notas clínicas y conviene ocultarlas cuando el módulo de notas de sesión esté activo (ver `RESULTADOS_DIAS_1_2.md`).
