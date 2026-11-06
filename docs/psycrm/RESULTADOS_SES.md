# Resultados: correo con Amazon SES

Guía de configuración: [`CORREO_SES.md`](CORREO_SES.md).

## Qué se construyó
- **Adaptador de SES v2** (`server/lib/sending/ses-adapter.ts`) con el SDK oficial de AWS, sin llaves: usa el rol de la tarea. Registrado como proveedor de correo junto a Brevo.
- **Remitente**: el de la práctica o, si no tiene, el de la plataforma (`SES_FROM_ADDRESS`). Región y conjunto de configuración por variables de entorno.
- **Las prácticas nuevas arrancan en SES** cuando el despliegue tiene `SES_FROM_ADDRESS` (`seed:practice`), sin pisar una elección ya hecha.
- **Settings → Email & SMS**: tarjeta "Amazon SES", remitente y nombre, y **Send test email** para comprobar la conexión.
- Todos los correos del sistema (invitación, documentos, código, copia firmada, automatizaciones) usan el proveedor elegido.

## Seguridad
- Sin claves que guardar: el permiso es del rol, limitado a `ses:SendEmail` desde la identidad.
- Un nombre, un asunto o una dirección **no pueden inyectar encabezados ni destinatarios** (se limpian o se rechazan antes de enviar).
- Los errores guardan solo su tipo, nunca el mensaje del SDK (que puede repetir la dirección del cliente).

## Verificación
- `npm run typecheck` limpio; 216 archivos y 1923 pruebas en verde (más 9 de PostgreSQL real que se omiten sin servidor).
- Pruebas nuevas: forma del mensaje y del remitente, nombres con tilde (RFC 2047), intentos de inyección, error sin filtrar la dirección, la elección de proveedor y del remitente, el valor por omisión del *seed* (sin pisar lo ya elegido), el botón de prueba, y **el SDK real contra un servidor local que imita SES** (firma y cuerpo exactos).
- Navegador: elegir Amazon SES, guardar, "Connected" y el botón de prueba disponibles.

## Lo que falta (no depende del código)
Cuenta de AWS, identidad de envío verificada, salir del *sandbox*, el permiso del rol y una **prueba de envío real**. Y, después, **leer los rebotes y quejas** de SES para marcar un envío como "no entregado".
