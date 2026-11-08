# Resultados: invitación al cliente

Spec: [`specs/extra-client-invite.md`](specs/extra-client-invite.md).

## Qué se construyó
- **Invite client** en Contacts: nombre, correo y quién lo llena (cliente adulto o padre/madre/tutor de un menor). Panel **Invitations** con Sent / Opened / Expired, Resend y Cancel.
- **Página `/i/:token`** (español, móvil primero, CSP con nonce): un formulario de menos de un minuto; versión para tutor con los datos del paciente y los suyos. Un solo uso, 14 días.
- **El contacto se crea al registrarse**, con fecha de nacimiento; se emite `contact_created` y **el flujo del día 7 envía los documentos solo**: paquete adulto al cliente, o paquete adolescente al tutor.
- Reglas de seguridad: tipo de invitación validado contra la fecha de nacimiento, menores sin correo propio (no se mezclan hermanos), clientes existentes no se duplican (fecha distinta = revisión, no reemplazo), campo trampa, límites por IP, enlace único, auditoría sin nombres ni correos.

## Verificación
- `npm run typecheck` limpio; `npx vitest run`: **212 archivos, 1884 pruebas**.
- Pruebas de integración con base real (`onboarding-flow.test.ts`): invitación → registro → contacto → tarjeta → paquete emitido (adulto y menor con tutor), uso único, desajuste de edad, bot, cliente existente (por correo y por teléfono), enlace desconocido/vencido/cancelado indistinguibles, escape de HTML, reenvío, una invitación abierta por correo, sin proveedor de correo, y límite de tasa.
- Navegador (iPhone SE, 375 px): sin scroll horizontal, mensaje claro con fecha de menor, el cliente aparece en la lista y la tarjeta en "Documents sent".
- Se corrigieron dos pruebas del día 6 que dependían del reloj real (usaban una fecha fija contra el reloj de la base de datos).

## Pendientes y advertencias
Ver "Estado de implementación" en el spec. Lo más importante: **sin un proveedor de correo con BAA no debe usarse con clientes reales**, y el asentimiento del menor aún no se entrega automáticamente.
