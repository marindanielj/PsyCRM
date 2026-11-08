# Extra: invitación al cliente (la doctora envía, la persona se registra)

## Objetivo
Que la terapeuta invite a un cliente nuevo con **solo un nombre y un correo**, y que la persona complete sus propios datos en una página suya. Al terminar se crea el contacto y **la automatización del día 7 envía sola los documentos**. No hay una página pública abierta en la web: solo existe a través de un enlace que ella envía.

Depende de los días 6 y 7. Páginas y correos en **español**; la UI de la terapeuta en inglés.

## Flujo
1. **Contacts → Invite client**: nombre, correo y "¿quién lo llena?" (**el cliente**, 18 o más; o **un padre, madre o tutor**, si el cliente es menor). Se envía un correo con un enlace de un solo uso (14 días).
2. **La persona abre `/i/:token`**: ve solo lo que la terapeuta escribió (nombre y correo) y llena sus datos: nombre, apellidos, teléfono y **fecha de nacimiento**. En la invitación a un tutor: los datos del paciente (menor) y los del tutor.
3. **Al enviar** se crea el contacto (recién entonces), se registra `contact.created` y `invite.completed` con actor `client`, y se emite `contact_created` con `{ source: 'invite', inviteKind }`.
4. **W1 (día 7) hace el resto**: tarjeta en "New contact", envío del paquete y tarjeta en "Documents sent". A un adulto se le envía el paquete adulto; a un menor, **el paquete adolescente al tutor** registrado.
5. En la lista de contactos, la invitación aparece en **Invitations** ("Sent", "Opened" o "Expired") con **Resend** y **Cancel**; al completarse, el cliente aparece en la lista.

## Decisiones
- **El contacto no existe hasta que la persona se registra.** Así todo expediente empieza con fecha de nacimiento (que decide el paquete) y no quedan "contactos fantasma" si nadie responde.
- **Sin código de verificación en esta página.** El enlace ya viaja por el correo, es de un solo uso, vence en 14 días y solo muestra un nombre y un correo. Los documentos, que sí contienen datos clínicos, siguen protegidos por el código del día 6.
- **El tipo de invitación se valida con la fecha de nacimiento.** Una invitación de adulto con una fecha de menor (o al revés) no crea nada y le dice a la persona que pida la invitación correcta a su terapeuta; la invitación sigue válida.
- **Un menor se registra sin correo ni teléfono propios**: el correo y el teléfono del tutor van a `guardian_email` y `guardian_phone`. Así dos hermanos con un mismo padre nunca se mezclan en un solo registro.
- **Un adulto que ya es cliente no se duplica**: se busca por su correo (en todos sus correos); si su fecha de nacimiento difiere, **no se reemplaza** y queda en `intake_conflicts` para revisión. No se reinicia el onboarding.
- **Una invitación abierta por correo.** Invitar de nuevo al mismo correo responde 409 (`already_invited`); se usa Resend. Resend crea un enlace nuevo, inutiliza el anterior y reinicia los 14 días.
- **Antiabuso**: el enlace es un secreto de 256 bits (solo se guarda su hash), un solo uso, límites por IP (60 vistas / 15 min y 10 envíos / hora), un campo trampa invisible (un bot no crea nada), CSP con nonce, y un mismo "enlace no válido o expiró" para enlaces desconocidos, vencidos o cancelados.
- **Auditoría sin datos personales**: `invite.sent`, `invite.resent`, `invite.voided`, `invite.expired`, `invite.completed` llevan ids y el tipo, nunca el nombre ni el correo.

## Esquema y rutas
- `client_invites` (`kind` adult|guardian, `status` sent|completed|expired|voided, `token_hash` único, fechas de envío, apertura, vencimiento y cierre, `contact_id`).
- Operador (módulo `contacts`): `GET/POST /api/loc/:loc/invites`, `POST /:id/resend`, `POST /:id/void`.
- Público: `GET /i/:token`, `POST /i/:token/submit`.
- Servicios: `server/lib/invite-complete.ts` (crea el contacto), `server/lib/invite-page.ts`, `server/repos/client-invites-repo.ts`.

## Cambio en el día 7
`send_document_packet` acepta ahora `adolescentPacketId`. Con una fecha de nacimiento de menor envía ese paquete **al tutor** (nombre y correo en los campos `guardian_*`); si faltan, se salta y crea la tarea "Add the guardian's name and email to send the adolescent packet". Sin `adolescentPacketId`, el comportamiento anterior (tarea manual) se mantiene. El workflow W1 sembrado lo trae configurado.

## Estado de implementación
**Hecho y verificado** (typecheck limpio; 212 archivos / 1884 pruebas en verde; recorrido en navegador: invitar, abrir el enlace en un iPhone SE, error por fecha de menor, registro, el contacto aparece, la tarjeta pasa a "Documents sent" y el paquete sale por correo; lo mismo para un tutor con un menor).

**Pendiente / sin verificar**
- **Correo con BAA** (igual que los días 6 y 7): sin proveedor, la invitación se crea y el enlace se entrega para enviarlo a mano, pero el paquete posterior no saldrá.
- **El asentimiento del menor no se envía por la automatización** (el paquete adolescente se envía solo al tutor; los documentos solo del rol "menor" se omiten con una advertencia en el audit). Falta decidir cómo se le entrega al menor su propio documento.
- Los workflows W1–W4 siguen naciendo en borrador: la invitación no envía nada hasta que ella los encienda. Para que un menor reciba el paquete automático, el paquete adolescente también debe tener sus plantillas activas (si no, el paso falla visiblemente).
- Un cliente que ya estaba en la lista solo con un teléfono (sin correo) se encuentra solo si el correo invitado coincide con alguno de sus correos.
- No hay límite por invitación de "intentos de correo": un correo mal escrito se corrige cancelando y volviendo a invitar.
