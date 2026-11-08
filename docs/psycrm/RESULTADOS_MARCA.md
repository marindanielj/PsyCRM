# Resultados: marca por práctica

Spec: [`specs/extra-branding.md`](specs/extra-branding.md).

## Qué se construyó
- **Settings → Branding**: nombre mostrado, color de acento y logo, con vista previa y aviso si el color se oscurece para que el texto blanco se lea.
- La **app** toma el nombre, el logo y el color de la práctica (barra lateral, pestaña, todos los botones). Sin logo muestra las iniciales sobre el color.
- Las **páginas del cliente** (verificación, documentos, registro) y los **asuntos de los correos** usan la misma marca.
- La pantalla de entrada usa el nombre del producto del despliegue (`VITE_APP_NAME`, por omisión "PsyCRM"): ya no dice "OpenLevel".

## Seguridad
- Solo PNG, JPEG o WebP; **el tipo sale de los bytes** (un HTML o un SVG disfrazado se rechaza); 300 KB como máximo, impuesto también por la base de datos.
- El color solo acepta `#rrggbb`: no puede romper el CSS de una página.
- La dirección del logo se valida con una forma exacta antes de ponerla en una página; otra práctica no puede ver ni cambiar esta marca; la auditoría registra solo qué campo cambió.

## Verificación
- `npm run typecheck` limpio; `npx vitest run`: **216 archivos, 1906 pruebas** (más 9 de PostgreSQL real que se omiten sin servidor). El recorrido E2E del día 8 sigue pasando completo.
- Pruebas nuevas: tipo por bytes, valores guardados leídos con defensa, cambio y borrado de nombre y color (conservando el resto de `branding`), subir/reemplazar/quitar el logo con encabezados seguros, rechazo de HTML/SVG/URL, aislamiento entre prácticas, auditoría sin contenido, páginas del cliente y correos con la marca, y la regla de contraste idéntica en servidor y web.
- Navegador: se sube un logo, se elige `#0e7490` y "Consultorio Maritza"; la app y la página móvil del cliente cambian; al quitar todo vuelve el aspecto por omisión.

## Pendientes
Ver "Estado de implementación" en el spec. Lo principal: la **marca macro** (dominio propio por práctica, correos desde su dominio y login con su marca) y el favicon.
