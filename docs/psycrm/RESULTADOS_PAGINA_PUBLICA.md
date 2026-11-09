# Resultados: página pública y bandeja de solicitudes

Pedido el 9 de noviembre de 2026. Objetivo: que la gente vea tarifas, planes médicos y preguntas frecuentes **antes** de pedir una cita, para que la doctora no tenga que llamar a cada persona, y que pida información o una cita desde un formulario.

Decisiones tomadas con la doctora: solicitud con horarios preferidos (no reserva en vivo), las solicitudes caen en una bandeja aparte y de ahí se invita, la página vive en `app.dramaritzamartinez.com/p/<nombre>`, en español primero.

## Lo que hay

| Pieza | Dónde | Qué hace |
|---|---|---|
| La página | `https://app.dramaritzamartinez.com/p/<nombre>` | Banner, sobre la consulta, servicios, **tarifas**, **planes médicos**, **preguntas frecuentes** (se abren al tocarlas, sin JavaScript), horario y ubicación, números de crisis, formulario |
| El editor | Settings → **Public page** | Todo el contenido, el banner, la dirección, las opciones del formulario, y **Preview** (ver la página antes de publicarla) |
| La bandeja | Contacts → **Requests** | Las solicitudes recibidas, con **Invite** (abre la invitación con el nombre y el correo ya puestos), **Handled** y **Delete** |

La página **no existe** para nadie hasta que se enciende "The page is public". Una dirección desconocida y una página apagada muestran lo mismo.

## El formulario

- **Datos:** nombre, correo, teléfono (opcional), para quién es (para mí / para un menor a mi cargo).
- **Horario:** modalidad **Presencial o Virtual**; luego **días** y **franja**. Por ahora: **lunes o martes**, **mañana o tarde** (se pueden marcar varios). La doctora cambia los días, las franjas y las modalidades en el editor. Virtual usa los mismos días y franjas por ahora.
- **Casillas obligatorias de "lo leí".** El texto exacto que la persona marcó se guarda con su solicitud:
  - "Leí las preguntas frecuentes de esta página." y "Vi las tarifas." (editables, hasta 5).
  - **"Entiendo que no se aceptan planes médicos."** se agrega **sola** mientras la consulta no acepte planes, para que la página y la casilla no puedan contradecirse. Si la doctora marca que sí acepta planes, esa casilla desaparece, la página lista los planes y el formulario pregunta cuál tiene.
- **No hay campo clínico.** El formulario dice que no se escriba información médica ni de salud, y el mensaje opcional tiene tope de 600 caracteres.
- Autorización de contacto (casilla obligatoria).

## Qué pasa con una solicitud

Una solicitud **no es un cliente**: no hay expediente, no hay fecha de nacimiento. Cae en la bandeja y la doctora decide. Con **Invite**, la persona recibe la invitación de siempre (registro con fecha de nacimiento) y ahí sí se crea el contacto. Un correo repetido en 7 días no crea otra solicitud.

El aviso a la doctora: un correo (como mucho uno por hora) que solo dice que hay algo que leer, sin nombre ni contenido. Con SES en *sandbox* ese correo no sale; la bandeja en la app es la fuente de verdad.

## Privacidad y seguridad

- Las solicitudes son datos sensibles (alguien que busca terapia): viven solo en la base cifrada y en la bandeja; la bitácora guarda solo su forma (`inquiry.received` con "adulto/menor" y "presencial/virtual"), nunca nombre, correo ni mensaje.
- Todo el texto de la doctora se escapa (no admite HTML); la página fija su propia política de seguridad con *nonce* y el único script es el del formulario.
- Anti-spam: campo oculto, 5 solicitudes por hora por dirección y 60 por hora por página, tope de tamaño.
- El banner: PNG, JPEG o WebP de hasta 700 KB, reconocido por sus primeros bytes (no por lo que diga el archivo); no se acepta SVG.
- La página sí es indexable (es una página de presentación); la vista previa no.

## Verificado

- 22 pruebas de servidor (`server/routes/public-page.test.ts`): página apagada y desconocida, publicación y dirección, tarifas y planes, escapado, política de seguridad, el formulario según la configuración (modalidades, días, franjas, casillas), solicitudes rechazadas, plan médico, campo oculto, límites, auditoría sin datos personales, aislamiento entre consultas, bandeja, aviso por correo, banner, vista previa. Más la prueba de espejo con el web y una del servidor completo.
- **19 pasos en un navegador real**: editar y publicar, subir el banner, ver la página en un teléfono, abrir una pregunta, no poder enviar sin las casillas, enviar, ver la solicitud en la bandeja con modalidad, día y franja, invitar desde ella, apagar la página. Capturas: `docs/psycrm/e2e/page-*.png`.
- **Un error que encontró la prueba en navegador:** al enviar, el "gracias" quedaba dentro del formulario que se oculta. Corregido y con prueba.

## Pendiente

- **Que la doctora escriba el contenido** (titular, preguntas y respuestas, planes, horario). No se publica nada que ella no haya escrito: el editor solo sugiere preguntas comunes.
- **Confirmar los números de crisis** (988, 1-800-981-0023, 911) antes de publicar: son los mismos de los documentos de ingreso y de la nota de sesión. Una prueba los mantiene iguales.
- **Enlazar** `https://app.dramaritzamartinez.com/p/<nombre>` desde su sitio web, Instagram y firma de correo.
- Más adelante: inglés, reserva en vivo con su calendario, un subdominio propio (`citas.dramaritzamartinez.com`) y un aviso en la barra lateral cuando hay solicitudes nuevas.
