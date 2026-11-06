# Extra: marca por práctica (nombre, color y logo)

## Visión
Cada terapeuta puede dejar el sistema con **su propia marca**: nombre, color y logo, configurados en **Settings → Branding**, sin tocar código. Lo que ve ella y lo que ve su cliente cambia según su práctica. Este extra construye el primer escalón; la "marca macro" (dominio propio, correos y login por práctica) queda para cuando haya más de una.

## Qué se puede configurar
| Ajuste | Dónde se ve |
|---|---|
| **Nombre mostrado** (opcional; si está vacío se usa el nombre de la práctica) | La barra lateral, la pestaña del navegador, las páginas de firma y registro del cliente, y el asunto de los correos que recibe |
| **Color de acento** (`#rrggbb`) | Todos los botones y acentos de la app, y los botones de las páginas del cliente |
| **Logo** (PNG, JPEG o WebP, hasta 300 KB) | La barra lateral y la cabecera de las páginas del cliente. Sin logo, la app muestra las iniciales sobre el color de acento |

**No cambia** el *nombre de la práctica* de **Settings → Practice**: ese sigue siendo el nombre legal que aparece en los documentos, en la carta de las notas impresas y en `{{practice.name}}`.

## Decisiones
- **Un solo color, diez tonos.** De un color se genera la paleta completa (`brand-50…900`, que es lo que usa Tailwind) con variables CSS en caliente, sin recargar. El color elegido pasa a ser el `600` (el de los botones).
- **El texto blanco siempre se lee.** Si el color es demasiado claro (un amarillo, por ejemplo), el sistema usa una versión **apenas más oscura** hasta llegar a contraste 4.5:1 y se lo dice a la terapeuta ("Buttons use a slightly darker shade…"). La regla es la misma en el servidor y en la web (una prueba verifica que no se desvíen).
- **El logo es una imagen, nunca un SVG.** Un SVG puede llevar código, así que solo se aceptan PNG, JPEG y WebP, y **el tipo se decide por los primeros bytes**, no por lo que el archivo dice ser (un HTML renombrado como `.png` se rechaza). Máximo 300 KB, impuesto también por la base de datos.
- **El logo vive aparte** (`location_logos`), para que las consultas normales de una práctica nunca arrastren bytes de imagen. La dirección lleva una huella (`/brand/<práctica>/logo?v=ab12cd34`), así un logo nuevo es una dirección nueva y se puede cachear una hora.
- **El logo es público** (`/brand/:práctica/logo`), porque lo muestran las páginas que ve el cliente sin iniciar sesión. Se sirve con `nosniff` y no expone nada más de la práctica.
- **Auditoría sin contenido**: `practice.branding_updated` registra qué campo cambió (`name`, `color`, `logo`, `logo_removed`), nunca el valor ni la imagen.
- **Antes de iniciar sesión no hay práctica**, así que la pantalla de entrada usa el nombre del producto del despliegue (`VITE_APP_NAME` al construir; por omisión "PsyCRM").

## Implementación
- `locations.branding` (jsonb, ya existía) guarda `name`, `color` y `logoVersion`; el resto de sus claves no se toca.
- Servidor: `server/lib/branding.ts` (reglas, tipo por bytes, color legible), `server/repos/branding-repo.ts`, `server/routes/branding.ts` (`GET/PUT /api/loc/:loc/branding`, `PUT/DELETE /logo`, y la ruta pública `/brand/:loc/logo`). Las páginas públicas (`/d`, `/i`) y los correos usan el nombre, el color y el logo de la práctica; su CSP permite imágenes propias (`img-src 'self' data:`).
- Web: `src/lib/brand.ts` (paleta y regla de contraste), `AppShell.tsx`, `BrandingSettingsPage.tsx` (con vista previa) y `refresh()` en el contexto de la práctica.

## Estado de implementación
**Hecho y verificado** (typecheck limpio; 216 archivos, 1906 pruebas en verde; recorrido en navegador: se sube un logo, se elige un color y un nombre, la app y la página del cliente cambian al instante y al quitarlos vuelve el aspecto por omisión).

**Pendiente / fuera de este extra**
- **Marca macro por práctica**: dominio propio, correos "de" su dominio y pantalla de acceso con su marca. Requiere identificar la práctica antes de iniciar sesión (por dominio) y un remitente de correo propio (SES) por práctica.
- Un ícono de pestaña (favicon) propio y los colores de la barra lateral (hoy fija en oscuro).
- Los textos en la interfaz de la terapeuta siguen siendo del producto; solo el nombre y el logo cambian.
- Los **correos usan el nombre mostrado** pero llevan texto sin imágenes (a propósito, por privacidad y por entregabilidad).
