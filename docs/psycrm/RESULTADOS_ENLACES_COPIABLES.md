# Resultados: copiar enlaces y mensajes (sin depender del correo)

Pedido el 9 de noviembre de 2026, mientras la salida del *sandbox* de SES está pendiente.

## Qué se puede hacer

| Dónde | Botones | Qué hacen |
|---|---|---|
| Ventana *Invite client* (tras enviar) | **Copy link**, **Copy message** | El enlace de la invitación, y el texto listo para pegar |
| Contacts → *Invitations* (pendientes) | **Copy link**, **Resend** | *Copy link* genera un enlace nuevo **sin enviar correo**; *Resend* lo genera y lo envía |
| Ficha del cliente → *Documents* | **Copy link**, **Resend** (por firmante) | Igual, para el enlace de firma de cada persona |
| Ventana *Send onboarding packet* (tras enviar) | **Copy link**, **Copy message** | Enlace y texto de cada firmante |

El texto copiado usa las mismas palabras que los correos del sistema (`server/lib/document-mail.ts`): saluda por el primer nombre, nombra la consulta, el enlace y la vigencia de 14 días. No contiene títulos de documentos, diagnósticos ni la palabra "psicoterapia". Una prueba (`server/lib/link-messages.test.ts`) vigila que no se separe del correo.

## Cómo funciona

- Solo se guarda el resumen (hash) de cada enlace, así que un enlace ya emitido **no se puede recuperar**: copiar emite uno **nuevo** y el anterior deja de funcionar. La pantalla lo dice.
- API: `POST /invites/:id/resend` y `POST /documents/requests/:id/resend` aceptan `deliver: "email" | "none"` (por defecto `email`; una llamada sin cuerpo sigue enviando correo). Con `none` no se toca el proveedor de correo.
- Auditoría: `invite.resent` y `packet.resent` guardan `delivery: "copy" | "email"`. Nunca el enlace.

## Límite importante: los documentos piden un código por correo

La página de firma (`/d/<enlace>`) verifica a la persona con un **código de 6 dígitos enviado a su correo**. Con SES en *sandbox*, ese código solo llega a direcciones verificadas en SES. Por eso, aunque la terapeuta copie el enlace de los documentos, el cliente no podrá abrirlos hasta que el correo funcione para su dirección. La **invitación de registro no lleva código** y funciona completa con el enlace copiado.

Opciones (decisión pendiente):
1. Esperar la aprobación de SES (lo normal: 1 a 2 días hábiles).
2. Verificar en SES la dirección de cada cliente que no pueda esperar (el cliente recibe un correo de AWS y pulsa un enlace).
3. Un código que la terapeuta vea en la app y dicte por otro canal. **No construido**: quita la prueba de que la persona controla ese correo, y por eso no se hizo sin su decisión.

## Verificado

- 2 pruebas de servidor (invitación y documentos) y 4 del texto, incluyendo: no se envía correo, el enlace viejo muere, el nuevo abre, `delivery` en la auditoría, el enlace no aparece en la bitácora, y una llamada sin cuerpo sigue enviando.
- 13 pasos en un navegador real: invitar, copiar el mensaje, copiar un enlace nuevo, registrar al cliente con él, copiar el enlace de los documentos. Capturas: `docs/psycrm/e2e/links-*.png`.
