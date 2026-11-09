# Correo con Amazon SES

Todo el correo del sistema (la invitación al cliente, los documentos para firmar, el código de verificación, el aviso de la copia firmada y los `send_email` de las automatizaciones) puede salir por **Amazon SES**, cubierto por el mismo BAA de AWS que el resto de la infraestructura. El código está en `server/lib/sending/ses-adapter.ts`; esta guía cubre lo que hay que hacer en AWS.

> **Regla de contenido:** ningún correo lleva datos clínicos. Dicen el nombre de la práctica y llevan un enlace o un código. Aun así, se envían por un proveedor con BAA.

## 1. Cómo se conecta la aplicación
- **Sin llaves.** La tarea de ECS corre con el rol `psycrm-task`; el SDK de AWS toma sus credenciales de ahí. No hay clave que guardar, rotar o filtrar.
- **Variables de entorno** de la tarea:

  | Variable | Para qué |
  |---|---|
  | `SES_FROM_ADDRESS` | El remitente verificado, p. ej. `no-reply@<dominio>` |
  | `SES_REGION` | La región de SES (si falta, `AWS_REGION`, y si no, `us-east-1`) |
  | `SES_CONFIGURATION_SET` | (Opcional) conjunto de configuración con eventos de rebote y queja |

- **Las prácticas nuevas arrancan en SES** si `SES_FROM_ADDRESS` está puesta cuando se corre `npm run seed:practice`. Una práctica ya existente se cambia en **Settings → Email & SMS → Amazon SES** (el remitente puede quedar vacío para usar el de la plataforma). Una elección ya hecha nunca se pisa.
- **Settings → Email & SMS → Test the connection**: envía un mensaje corto a la dirección que se escriba. Es la forma de comprobar el permiso, la identidad y el *sandbox* antes de que un cliente dependa del correo.

## 2. Lo que hay que hacer en AWS (tuyo)
1. **Verificar la identidad de envío.** Con dominio: crear la identidad del dominio en SES con **DKIM** (2048 bits), un **MAIL FROM** propio (SPF alineado) y los registros en Route 53. *Mientras no haya dominio:* verificar una sola dirección de correo, **solo para pruebas con datos ficticios**.
2. **Salir del *sandbox*.** En una cuenta nueva SES solo envía a direcciones verificadas. Pedir "acceso a producción" (formulario en la consola; suele tardar alrededor de un día). Hasta que lo aprueben, solo se puede probar con direcciones propias verificadas.
3. **Conjunto de configuración** (recomendado): eventos de **rebote y queja** hacia CloudWatch/SNS y la lista de supresión activada. Poner su nombre en `SES_CONFIGURATION_SET`.
4. **Permiso del rol `psycrm-task`**, limitado a la identidad:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": "ses:SendEmail",
       "Resource": [
         "arn:aws:ses:<región>:<cuenta>:identity/<dominio o dirección>",
         "arn:aws:ses:<región>:<cuenta>:configuration-set/<conjunto>"
       ]
     }]
   }
   ```
   (Sin el segundo recurso si no se usa conjunto de configuración.)
5. **Confirmar que SES figura en la lista oficial de servicios elegibles para HIPAA** (tarea 1.4 de `INFRA_AWS.md`) y que el BAA está aceptado en Artifact.
6. **Alarma** de tasa de rebote y de queja (la lista de alarmas de `INFRA_AWS.md` §3.9 ya la incluye).

### Mientras SES siga en *sandbox*
SES solo envía a direcciones verificadas, así que los correos a clientes reales rebotan. Para no depender de ellos:
- **Invitación de registro:** se puede mandar por cuenta propia con **Copy link** / **Copy message** (ver `GUIA_RAPIDA.md`). No necesita correo.
- **Documentos de onboarding:** el enlace también se copia, pero la página pide un **código de 6 dígitos que se envía por correo** para verificar a la persona. Con SES en *sandbox* ese código solo llega a direcciones verificadas en SES. Opciones: esperar la aprobación, o verificar la dirección del cliente en SES (el cliente debe pulsar un enlace que AWS le manda).

### Estado con el dominio `dramaritzamartinez.com` (nov 2026)
- El dominio está registrado en Network Solutions con su DNS allí (servidores `ns11/ns12.worldnic.com`), una web activa en la raíz y **sin registros de correo** (ni MX ni TXT). Por eso solo se delega `app.dramaritzamartinez.com` a Route 53 y la web no se toca. El código de `infra/` crea la zona, la identidad de SES (DKIM 2048, MAIL FROM `bounce.app…`, DMARC estricto), el conjunto de configuración `psycrm` y el certificado. El remitente será `no-reply@app.dramaritzamartinez.com`.
- Si algún día se quiere enviar como `@dramaritzamartinez.com` (sin `app.`), hay que crear la identidad de la raíz y pegar sus registros DKIM en Network Solutions. No es necesario para empezar.

### Solicitud de acceso a producción (texto para el formulario de SES)
Se hace en la cuenta `psycrm-prod`, región `us-east-1` (consola: *SES → Account dashboard → Request production access*, o `aws sesv2 put-account-details`). Texto propuesto, en inglés porque lo lee AWS:

> **Mail type:** Transactional.
> **Website URL:** https://app.dramaritzamartinez.com
> **Use case:** We operate a practice-management application for a licensed psychologist in Puerto Rico. The only emails we send are transactional messages to the practice's own clients, one per event, each containing a single secure link to complete intake paperwork or to register, and one-time verification codes for that paperwork. Messages never contain clinical information. Recipients are existing clients or prospective clients who were invited by the practice itself; we never send marketing or bulk mail and we do not buy or scrape addresses.
> **How recipients are obtained:** The therapist enters or confirms each client's email address herself when scheduling or inviting that client; every message is triggered by an action of the practice.
> **Bounce and complaint handling:** We use a configuration set with the account-level suppression list enabled for bounces and complaints, reputation metrics, and CloudWatch alarms on bounce and complaint rates. Addresses that bounce are not retried.
> **Expected volume:** Fewer than 200 emails per day, typically under 30.
> **Sending identity:** app.dramaritzamartinez.com with DKIM, SPF (custom MAIL FROM) and DMARC configured.

## 3. Cómo probarlo
1. Con la identidad verificada y el rol puesto, abrir **Settings → Email & SMS**, elegir **Amazon SES**, guardar y pulsar **Send test email** a una dirección verificada. Debe responder "Sent".
2. Repetir el recorrido de punta a punta de `OPERACIONES.md` §7 con un cliente ficticio cuyo correo sea una dirección verificada (mientras dure el *sandbox*).
3. Errores comunes, tal como los muestra el botón de prueba (solo el tipo, nunca el mensaje de AWS):

   | Mensaje | Causa |
   |---|---|
   | `MessageRejected` | La identidad o la dirección de destino no está verificada (*sandbox*) |
   | `AccessDeniedException` | El rol de la tarea no tiene `ses:SendEmail` sobre esa identidad |
   | `CredentialsProviderError` | La aplicación no corre bajo el rol de la tarea (por ejemplo, en una máquina local) |
   | `sender email is not configured` | Falta `SES_FROM_ADDRESS` y la práctica no puso remitente |

## 4. Qué hace y qué no hace el código
- Envía texto plano en UTF-8 con la API de SES v2. Los nombres con tilde se codifican (RFC 2047), y un nombre o un asunto **no puede añadir otro destinatario ni otro encabezado** (se limpian comillas, signos `<` `>` y saltos de línea; una dirección de destino con comas, espacios o saltos se rechaza antes de enviar).
- Si el envío falla, el error que se guarda es solo su **tipo** (p. ej. `ses send failed: MessageRejected`), porque el texto de AWS puede repetir la dirección del cliente.
- **No procesa rebotes ni quejas.** Si un correo rebota, la doctora lo ve como "enviado" y el cliente nunca recibe el enlace. Mientras no se construya, la señal es la alarma de rebotes de SES y el botón **Resend** de la solicitud. *(Pendiente: leer los eventos de SES y marcar la solicitud como "no entregada".)*
- Se probó el formato de la petición firmada contra un servidor local que imita a SES (firma `AWS4-HMAC-SHA256` para `ses` en la región, ruta `/v2/email/outbound-emails`, cuerpo exacto). **No se ha probado contra AWS** porque aún no hay cuenta.
