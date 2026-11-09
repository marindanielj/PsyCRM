# Futuro (A12): constructor de páginas por bloques

**Estado:** idea documentada, **no construida**. Nace de la página pública (`/p/<nombre>`, ver [`RESULTADOS_PAGINA_PUBLICA.md`](../RESULTADOS_PAGINA_PUBLICA.md)), que hoy es **una sola página con un diseño fijo**. Pedido por la doctora el 9 de noviembre de 2026: no depender de crear páginas sueltas con código, y poder usar un constructor de sitios y de formularios.

## Por qué

- Cada página nueva (una para adolescentes, una de recursos, una de preguntas sobre un servicio) hoy exige un programador.
- La visión del producto es que **cada terapeuta pueda cambiar toda su marca y su contenido sin tocar código** (ver [`extra-branding.md`](extra-branding.md)). Un constructor sencillo y seguro es la base de eso.
- Mantener varias formas de dibujar una página pública multiplica cada arreglo de seguridad.

## Qué trae OpenLevel y por qué no se puede encender tal cual

OpenLevel trae `sites` (embudos), `forms` (formularios) y `surveys` (encuestas), apagados en PsyCRM. Se hicieron como herramientas de marketing, y chocan con reglas que PsyCRM ya tiene:

| Obstáculo | Qué hacen hoy (verificado en el código) | Por qué importa en una consulta |
|---|---|---|
| **Crean un contacto con cada envío** | `public-forms.ts`, `public-funnels.ts` y `public-surveys.ts` llaman a `upsertByMatch`, ponen etiqueta, registran en la línea de tiempo y disparan `contact_created` | Rompe la regla de que no hay ficha sin fecha de nacimiento; el spam llenaría la lista de contactos |
| **Guardan respuestas libres sin límite ni bitácora** | `form_submissions` guarda el texto tal cual (`z.record(z.string(), z.string())`, sin tope de tamaño). Los 5 archivos públicos y de edición tienen 0 llamadas a `audit()` | Puede entrar información de salud sin control ni rastro |
| **Sin defensas** | Ni límite de intentos, ni campo oculto anti-bot, ni tope de tamaño de cuerpo | Cualquiera puede inundar el formulario |
| **Sin política de seguridad** | `/api/public/*` está exento de la política estricta; el script de `captureScript` no lleva *nonce* | Más débil que `/d`, `/i` y `/p` |
| **Contenido demasiado simple** | Un paso de embudo es titular, subtítulo, botón y campos (`opt_in`, `sales`, `thank_you`). No hay secciones, preguntas frecuentes, tarifas, horario, imágenes ni banner | No puede armar la página pública actual |
| **Pocos tipos de campo** | El constructor de formularios ofrece texto, área de texto y lista | Faltan casilla obligatoria de "lo leí" y selector de horario |
| **Direcciones con el id interno** | `/api/public/forms/<id de la práctica>/<nombre>` | Expone el identificador y no se ve profesional |
| **Solo inglés y no indexable** | `lang="en"`, textos fijos en inglés, `noindex` fijo | Una página de presentación debe poder encontrarse y estar en español |
| **Cuatro formas de dibujar una página pública** | Formularios, embudos, encuestas y la página pública | Cada arreglo hay que repetirlo cuatro veces |
| **Sin datos de la práctica** | No toman tarifas, planes, números de crisis ni color legible del perfil de la práctica | Hay que reescribir lo que el sistema ya sabe |

Lo aprovechable: la idea de definición por práctica, el estado borrador/publicado, el almacén de envíos y la interfaz del editor.

## Opciones consideradas

| | Opción | Veredicto |
|---|---|---|
| **A** | **Un solo motor de páginas por bloques**, nacido de la página pública actual | **Recomendada** |
| B | Arreglar los constructores viejos en su sitio (límites, *nonce*, auditoría, español, direcciones) | El contenido de los embudos es demasiado limitado: se terminarían construyendo los bloques igual y quedarían dos sistemas |
| C | Seguir con páginas hechas en código | Funciona hoy y no escala |
| D | Un constructor externo (Wix, Squarespace, Webflow) | Sirve para la parte **informativa** sin datos de pacientes. Muchos no firman BAA, así que no deben recibir solicitudes de pacientes. Opción complementaria, no sustituta |

## Diseño propuesto (opción A)

**Una página es una lista ordenada de bloques**, guardada como JSON por práctica y dibujada por **un solo renderizador seguro** (texto plano escapado, política de seguridad con *nonce*, sin HTML libre).

| Bloque | De dónde sale su contenido |
|---|---|
| Portada (titular, subtítulo, banner) | Editor |
| Texto | Editor |
| Servicios | Editor |
| **Tarifas** | **Automático** desde Settings → Practice |
| **Planes médicos** | Editor (acepta o no acepta, lista de planes) |
| **Preguntas frecuentes** | Editor |
| Horario y ubicación | Editor |
| Aviso de crisis | **Automático** (mismas líneas que los documentos y la nota de sesión) |
| Imagen | Subida validada por sus primeros bytes (nunca SVG) |
| **Formulario** | Constructor de formularios |

**El bloque de formulario** usa un constructor de campos con más tipos: texto, área de texto, lista, opciones, casillas, **casilla obligatoria de "lo leí"** y **selector de horario** (modalidad, días, franjas). Ya existe un constructor con tipos más ricos en Documentos (`src/features/documents/FieldBuilder.tsx`, `server/lib/document-vocab.ts`) que se puede reutilizar. Cada formulario tiene un **destino**:

- **Bandeja de solicitudes** (por defecto, el modo seguro): nada se vuelve cliente.
- **Crear cliente**: solo si el formulario incluye fecha de nacimiento y pasa por la misma validación de las invitaciones.
- Nunca un contacto sin fecha de nacimiento.

**Reglas que no se negocian** (ya cumplidas por la página pública, y que cualquier bloque nuevo debe mantener):
- Todo lo que escribe la terapeuta se escapa; no hay HTML libre ni scripts ajenos ni píxeles de seguimiento.
- Política de seguridad propia con *nonce*; el único script es el del formulario.
- Campo oculto, límite de intentos por dirección y por página, tope de tamaño.
- Las solicitudes son datos sensibles: bandeja aparte, auditoría solo con la forma de la solicitud (nunca nombre, correo ni texto), sin campos clínicos.
- La página no existe hasta publicarla; dirección y vista previa.
- Español primero; el inglés entra con el soporte bilingüe (C2).

## Etapas

| Etapa | Qué | Tamaño |
|---|---|---|
| 1 | **Modelo de bloques** y **conversión automática** de la página actual (la doctora no pierde nada). Un solo renderizador | Mediana |
| 2 | **Editor de bloques**: agregar, quitar, ordenar y vista previa | Mediana |
| 3 | **Constructor de campos** del formulario (casilla de "lo leí", selector de horario, opciones) y destino configurable | Mediana |
| 4 | Más páginas por práctica, imágenes en bloques, subdominio propio (`citas.dramaritzamartinez.com`) e inglés | Según uso |

Los constructores viejos (`sites`, `forms`, `surveys`) pueden quedarse apagados; retirarlos es opcional y va después.

## Decisiones pendientes

- ¿Se necesitan **más páginas pronto** (adolescentes, recursos, un servicio concreto)? Eso decide cuánto invertir en las etapas 2 a 4.
- ¿Hace falta **una página por terapeuta** desde ya (varias consultas en el mismo sistema)? Cambia cómo se reparten las direcciones.
- ¿La web actual de la doctora (en Network Solutions) debe **enlazar** a esta página, o la sustituimos?

## Relación con otras ideas del plan

- **C2 (páginas públicas y correos bilingües):** el constructor es lo que hace barato el inglés; sin él, cada página se duplica a mano.
- **A3 (autoagendamiento con cribado):** el bloque de formulario con selector de horario es el cimiento; la reserva en vivo vendría después.
- **B9 (multiusuario con roles):** quién puede editar y publicar páginas pasa a ser un permiso.
