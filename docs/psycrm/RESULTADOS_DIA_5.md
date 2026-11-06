# Resultados del día 5: plantillas y paquetes de documentos

Spec: [`specs/day-05-document-templates.md`](specs/day-05-document-templates.md).

## Qué se construyó
- **Esquema** (`db/schema.sql`): `document_templates` y `document_packets`. Un trigger hace inmutable cualquier versión `active` o `retired` (contenido, firma, firmantes, versión), solo permite `active → retired`, y prohíbe borrarlas. Un índice parcial garantiza **una sola versión activa por familia**. Todo idempotente.
- **Vocabulario y validación** (`document-vocab.ts`): 14 tipos de campo, claves únicas, opciones obligatorias donde hacen falta, `showIf` solo hacia atrás, `mapsTo` limitado a campos del cliente o `custom:`.
- **Renderer** (`document-render.ts`): markdown restringido sin HTML crudo, campos de combinación (cliente, práctica, honorarios, política, fecha larga en español), los 14 tipos de campo en modo `preview`/`fill`/`signed`, condicionales y colocación de campos en el texto.
- **API** `/api/loc/:loc/documents` (módulo `documents`): plantillas (listar, detalle, historial, crear, editar borrador, nueva versión, activar, retirar, vista previa) y paquetes (CRUD, archivar, vista previa de todo el paquete). Cada cambio y su auditoría van en una sola transacción; la auditoría nombra ids y campos, nunca el texto.
- **Semilla en español**: 9 plantillas en borrador (consentimiento informado, privacidad HIPAA, cancelación, honorarios, telepsicología, comunicaciones, admisión, consentimiento del tutor, asentimiento del menor) y 2 paquetes (adulto, adolescente).
- **Interfaz (inglés)**: **Documents** con pestañas Templates/Packets, editor en dos columnas con vista previa en vivo y selector "Preview as", constructor de campos, versiones, y editor de paquetes con orden y vista previa de la secuencia.

## Verificación
- `npm run typecheck` limpio; `npx vitest run`: **204 archivos, 1814 pruebas**.
- BD real (PGlite): inmutabilidad, una activa por familia, borrado, CHECK de roles/idioma/tipo, y el esquema aplicado dos veces.
- Rutas: flujo crear → activar → 409 al editar → nueva versión → activar retira la anterior (y la v1 sigue idéntica); tenancy; paquetes; auditoría sin texto; semilla idempotente que conserva ediciones; las 9 plantillas se renderizan sin campos desconocidos.
- Navegador (Playwright): lista de 9, editor con aviso legal, autoguardado y vista previa, `<script>` mostrado como texto, activar → solo lectura, nueva versión → activar → v1 retirada, paquete con 6 documentos y reordenar, móvil sin scroll horizontal, sin errores de página.

## Diferencias y pendientes
Ver "Estado de implementación (día 5)" en el spec. Lo más importante: **los textos semilla requieren revisión legal**, los números de crisis siguen sin verificar, y `mapsTo` se aplica recién en el día 6.
