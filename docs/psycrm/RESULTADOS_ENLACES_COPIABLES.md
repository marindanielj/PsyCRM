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

Salidas:
1. **Esperar la aprobación de SES** (lo normal: 1 a 2 días hábiles). Es la solución de fondo.
2. **Verificar en SES la dirección de un cliente** que no pueda esperar (el cliente recibe un correo de AWS y pulsa un enlace).
3. **Código dado por la terapeuta** (construido, **apagado por defecto**): ver la sección siguiente.

## Código dado por la terapeuta (apagado por defecto)

Pedido el mismo día al verse que, sin SES, el flujo de documentos se corta. Settings → Practice → *Verification codes for documents* → *Let me give a client the code myself*.

| Con el interruptor | Qué pasa |
|---|---|
| Apagado (valor inicial) | Nada cambia. El servidor responde 403 si alguien intenta pedir un código, y la tarjeta no ofrece el botón |
| Encendido | En la tarjeta del paquete, cada firmante tiene **Give a code**. Muestra un código de 6 dígitos **una sola vez**, válido 30 minutos |
| El cliente | Abre su enlace; la página dice *"Su terapeuta le dio un código"* y ya tiene la caja abierta. Puede preferir recibirlo por correo |

**Por qué está apagado:** es una verificación más débil. El código por correo prueba que la persona controla ese correo; el dado por la terapeuta depende de que ella sepa con quién habla. Por eso hay que encenderlo a propósito, y queda constancia en tres sitios:
- La bitácora: `document.verification_changed` (quién lo encendió o apagó) y `packet.code_issued` (cada código dado, sin el código).
- El documento firmado: `signed_documents.verified_via = 'therapist_code'` (y `email_otp` para los demás). El visor de documentos firmados lo muestra.
- La pantalla de Settings lo explica y recomienda dar el código por un canal distinto al del enlace.

**Controles:** el código nunca se guarda (solo su resumen) ni sale en la bitácora; 5 intentos fallidos bloquean el enlace y un código nuevo lo reabre; un código nuevo reemplaza al anterior; un enlace nuevo borra la verificación; máximo 10 códigos por hora por firmante; si la persona pide el código por correo y el correo falla, el código de la terapeuta sigue vigente.

**Cómo quitarlo del todo:** apagar el interruptor basta; si más adelante no se quiere ni la opción, se borran el botón de `RequestCard.tsx` y la ruta `POST /requests/:id/signers/:signerId/code`.

**Verificado:** 11 pruebas de servidor (`server/routes/documents-therapist-code.test.ts`) y 12 pasos en navegador real (capturas `docs/psycrm/e2e/code-*.png`).

## Verificado

- 2 pruebas de servidor (invitación y documentos) y 4 del texto, incluyendo: no se envía correo, el enlace viejo muere, el nuevo abre, `delivery` en la auditoría, el enlace no aparece en la bitácora, y una llamada sin cuerpo sigue enviando.
- 13 pasos en un navegador real: invitar, copiar el mensaje, copiar un enlace nuevo, registrar al cliente con él, copiar el enlace de los documentos. Capturas: `docs/psycrm/e2e/links-*.png`.
