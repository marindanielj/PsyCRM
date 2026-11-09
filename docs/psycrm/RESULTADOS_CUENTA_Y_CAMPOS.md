# Resultados: contraseña propia y campos personalizados en la invitación

Dos cambios pedidos el 9 de noviembre de 2026, verificados con pruebas automáticas y en un navegador real.

## 1. Cambio de contraseña (Settings → Account)

**Por qué:** la contraseña inicial de la doctora la genera AWS (24 caracteres) y la app no tenía forma de cambiarla, así que esa era la definitiva.

| Qué hace | Cómo |
|---|---|
| Pide la contraseña actual y una nueva | `POST /api/auth/change-password`. Nueva: 12 a 128 caracteres, distinta de la actual y del correo |
| Un robo de sesión no basta para tomar la cuenta | Sin la contraseña actual no se cambia nada. 5 intentos fallidos por persona cada 15 minutos (429) |
| Cierra las demás sesiones | `operators.password_changed_at`: las sesiones emitidas antes de esa hora se rechazan. Esta sesión recibe una cookie nueva |
| Queda registrado sin secretos | `auth.password_changed` y `auth.password_change_failed`; nunca las contraseñas |
| Recordatorio | Mientras `passwordChangedAt` sea nulo, un aviso amarillo invita a elegir la propia |

Costo: una consulta indexada por petición autenticada (la lectura de `password_changed_at`).

**Verificado:** 8 pruebas con PostgreSQL embebido (`server/routes/auth-password.test.ts`): contraseña incorrecta (403, no 401: la app trata 401 como "sesión cerrada"), validaciones, hash argon2id, auditoría sin secretos, otra sesión cerrada, inicio de sesión con la nueva y no con la vieja, límite de intentos. Más 14 comprobaciones en navegador (escritorio y teléfono). Capturas: `docs/psycrm/e2e/pw-*.png`.

**No incluido (siguiente):** recuperación por correo (necesita SES fuera del *sandbox*), verificación en dos pasos, y aviso por correo de que la contraseña cambió.

## 2. Campos personalizados en el formulario de la invitación

**Qué cambia:** el formulario que ve el cliente al registrarse incluye los campos personalizados de la práctica. Se leen **al abrir la página** (y de nuevo al enviarla), no al crear la invitación: un campo que se añade hoy sale en la siguiente invitación, y también en una ya enviada si aún no la han usado; uno que se quita desaparece.

| Regla | Detalle |
|---|---|
| Qué se pregunta | Todos los campos de *Settings → Custom Fields*, en el orden de la práctica, con el control de su tipo (texto, área de texto, número, fecha, lista, casilla) |
| Qué no se repite | `date_of_birth` y `guardian_*` (el formulario ya los pregunta) e `intake_conflicts` (control interno). Nunca se pueden escribir desde el formulario |
| Ocultar uno | Casilla *"Ask the client for this when they register from an invitation"* en cada campo. Por defecto activada: lo que se añade aparece. Sirve para notas o datos que solo debe llenar la terapeuta |
| Cliente nuevo | Las respuestas se guardan en su ficha, con el tipo correcto |
| Cliente que ya existe | Solo se llenan los vacíos. Un valor distinto del registrado no lo reemplaza: queda en `intake_conflicts` para revisión |
| Menor | Las respuestas van a la ficha del menor |
| Validación | Cada respuesta se revisa contra su campo. Un valor ilegible (un número que no es número, una opción inexistente, una fecha imposible) se rechaza nombrando el campo; una casilla sin marcar o un campo vacío es "sin respuesta" |
| Seguridad | Etiquetas, opciones y sugerencias se escapan en el HTML. Máximo 50 respuestas, 500 caracteres por campo de texto y 2000 por área de texto. Objetos o listas se rechazan. La auditoría guarda nombres de campo, nunca respuestas |

**Un error que encontraron las pruebas:** un número escrito como "muchos" se descartaba en silencio en vez de rechazarse. Corregido y con prueba.

**Verificado:** 15 pruebas de la ruta + 4 de la validación (`server/routes/public-invites-custom-fields.test.ts`, `server/lib/invite-custom-fields.test.ts`), y 11 comprobaciones en navegador: añadir un campo en Settings y verlo en la invitación, esconder y borrar campos y ver el mismo enlace actualizado, enviar el formulario y ver las respuestas en la ficha. Capturas: `docs/psycrm/e2e/cf-*.png`.

**Pendiente:** las etiquetas de los campos de arranque están en inglés (*Preferred name*, *Pronouns*…) y la página del cliente está en español. La doctora puede renombrarlas en Settings; con el soporte bilingüe se resolverá de raíz.
