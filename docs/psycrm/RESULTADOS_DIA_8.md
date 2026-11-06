# Resultados del día 8: prueba completa, endurecimiento y salida a producción

Spec: [`specs/day-08-e2e-golive.md`](specs/day-08-e2e-golive.md). Operación: [`OPERACIONES.md`](OPERACIONES.md). Guía: [`GUIA_RAPIDA.md`](GUIA_RAPIDA.md).

## 1. Prueba E2E (`node scripts/e2e-psycrm.mjs`) — pasa, 13 pasos
En un navegador real, con datos ficticios y el correo falso del servidor de desarrollo. Capturas en [`e2e/`](e2e/).

| # | Paso | Resultado |
|---|---|---|
| 1 | Inicio de sesión; la navegación solo muestra los módulos de la práctica | ✅ |
| 2 | La doctora invita; el cliente se registra en su celular → contacto creado, paquete adulto enviado, tarjeta en "Documents sent"; auditoría de `contact.created`, `packet.sent`, `invite.completed`, `pipeline.stage_changed` | ✅ |
| 3 | El correo trae un enlace, saluda solo por el nombre de pila y no nombra documentos ni términos clínicos | ✅ |
| 4 | En un iPhone 13: código por correo, 6 documentos firmados con firma dibujada; los datos llegan al expediente | ✅ |
| 5 | Tarjeta en "Documents signed" y la tarea "Schedule first appointment" | ✅ |
| 6 | Una cita creada por la terapeuta mueve la tarjeta a "First appointment booked" | ✅ (arreglado en este día) |
| 7 | Check-in → Start note abre el asistente con la cita cargada | ✅ |
| 8 | Sin riesgo: "Sign note" deshabilitado y la API responde 422 | ✅ |
| 9 | Riesgo moderado + justificación + acción → firma: insignia ámbar, "Elevated risk", tarjeta "Active client", cita `completed` | ✅ |
| 10 | El reporte se exporta a PDF (1 página) con membrete, riesgo y firma | ✅ |
| 11 | Pasadas las 72 h: sin Edit, `PATCH` 409, el anexo funciona | ✅ |
| 12 | Auditoría: verificación de integridad y CSV con todos los eventos del ciclo (82 filas) | ✅ |
| 13 | Una sesión inactiva se cierra (servidor aparte con límite de 3 s) | ✅ |
| — | Sin errores inesperados en el navegador | ✅ |

## 2. Pruebas contra PostgreSQL 16 real
Se levantó un servidor real y se corrió `server/db/real-postgres.test.ts` (se omite si no hay `PG_TEST_URL`):
- El esquema se aplica **dos veces** sin error, y el *seed* es idempotente.
- **60 escrituras de auditoría simultáneas** producen una cadena `1…N` sin huecos ni duplicados, y `audit_log_verify` da 0.
- La persona que actúa (`psycrm.actor`) **no se filtra** a la siguiente transacción de la misma conexión.
- **12 ediciones simultáneas** de una nota se serializan: todas quedan registradas y las revisiones son contiguas.
- La **misma firma enviada 6 veces a la vez** es una sola, y todas las llamadas devuelven la misma.
- **Dos firmantes terminando a la vez** completan el paquete **una sola vez** (un solo `packet.completed`, un solo aviso).
- Una invitación completada desde 6 pestañas a la vez crea **un solo cliente**.
- La base de datos rechaza lo que la aplicación rechazaría (firmas, auditoría, notas), y las fechas vuelven como texto.

## 3. Revisión de seguridad
| Ítem | Estado |
|---|---|
| Aislamiento entre prácticas: notas, plantillas, solicitudes, firmados, invitaciones y auditoría de otra práctica dan 404 o listas vacías (prueba transversal) | ✅ |
| Sin datos de clientes en los registros: toda llamada `console.*` del servidor se verifica contra una lista; **`app.onError` nuevo** registra solo método y código | ✅ (hallazgo corregido) |
| Sin datos de clientes en URLs (solo ids y tokens) ni en `localStorage`/`sessionStorage` (solo la práctica elegida) | ✅ |
| Cabeceras: CSP estricta en la app; CSP con *nonce* en las páginas públicas; HSTS, `no-store`, `X-Frame-Options`, `Referrer-Policy`, `nosniff` en todas | ✅ (prueba automática; falta confirmarlas con `curl -I` en producción) |
| Límites de tasa: inicio de sesión, envío de código, verificación, **firma y guardado (nuevo)**, registro por invitación | ✅ |
| Secretos: `SESSION_SECRET` ≥ 32 y distinto del de desarrollo; **`PUBLIC_BASE_URL` https obligatoria (nuevo)**; sin `.env` en el repositorio | ✅ (falta cargarlos en Secrets Manager) |
| Integraciones apagadas: sin `ENABLED_INTEGRATIONS`, las rutas de Chatwoot, páginas públicas, pagos, voz y federación no existen (404) | ✅ |
| `npm audit --omit=dev` | ✅ de 10 (7 altas) a **0** |
| Revisión dirigida de las superficies públicas (`/d`, `/i`): HTML escapado, tokens de 256 bits solo como *hash*, un solo uso, intentos de código acumulados (reenviar un código no los reinicia), propiedad de plantilla y firmante comprobada en cada firma, sin redirecciones abiertas, rutas de desarrollo ausentes de producción | ✅ |
| Skill `/security-review` | ⚠️ no se pudo ejecutar (el repositorio no tiene `origin/HEAD`); sustituida por la revisión dirigida de arriba |

## 4. Lista de salida a producción (go / no-go)
| # | Ítem | Responsable | Estado |
|---|---|---|---|
| 1 | BAA de AWS aceptado en Artifact y servicios verificados contra la lista HIPAA Eligible (incluido **SES**) | Admin | ⬜ pendiente |
| 2 | **Proveedor de correo con BAA** (hoy solo existe el adaptador de Brevo, sin BAA). Sin él, ni las invitaciones, ni los paquetes, ni los códigos de verificación llegan al cliente. Hace falta el adaptador de SES | Admin + terapeuta | ⬜ **bloquea el uso con clientes reales** |
| 3 | Plantillas revisadas por la terapeuta y un asesor legal (Ley 408-2000, confidencialidad, retención) y **activadas**; luego **encender los workflows** | Terapeuta | ⬜ pendiente |
| 4 | Datos de la práctica, licencia, honorarios y política de cancelación en Settings → Practice | Terapeuta | ⬜ pendiente |
| 5 | Números de crisis verificados (988, Línea PAS 1-800-981-0023, 911) | Terapeuta | ⬜ pendiente |
| 6 | E2E en producción con un cliente ficticio, luego archivado (mismos 13 pasos) | Admin | ⬜ pendiente |
| 7 | Prueba de restauración de RDS (procedimiento en `OPERACIONES.md`) | Admin | ⬜ pendiente |
| 8 | Política interna de una página (borrador en `POLITICA_INTERNA_BORRADOR.md`) | Terapeuta | ⬜ borrador listo, falta revisión |
| 9 | Sesión de 30 minutos con la guía rápida y que ella complete el ciclo una vez | Admin + terapeuta | ⬜ pendiente |
| 10 | Variables de producción cargadas (`SESSION_SECRET`, `DATABASE_URL`, `PUBLIC_BASE_URL`; `ENABLED_INTEGRATIONS` vacía) y cabeceras confirmadas con `curl -I` | Admin | ⬜ pendiente |
| 11 | Monitoreo: chequeo de `/health` y alarmas (procedimiento en `OPERACIONES.md`) | Admin | ⬜ pendiente |
| 12 | Cuenta de la terapeuta: contraseña larga en un gestor de contraseñas. **MFA es lo primero de la semana 2** | Terapeuta | ⬜ pendiente |

**Veredicto:** el software está listo para la prueba en producción con datos ficticios. **No se debe usar con un cliente real** hasta resolver, como mínimo, los ítems **1, 2, 3, 5 y 12**.

## 5. Lo que cambió en el producto este día
- Una cita creada por la terapeuta emite `appointment_booked` (hallazgo del E2E).
- `app.onError`: los errores inesperados se registran solo por código.
- `PUBLIC_BASE_URL` obligatoria y https en producción.
- Límite de tasa por firmante en firma y guardado.
- Dependencias actualizadas (0 vulnerabilidades en producción); `npm ci` funciona con el `package-lock.json` nuevo.
- Correos de desarrollo en `/__dev/outbox` (solo en el servidor de desarrollo).

## 6. Pendientes priorizados para la semana 2 (sin cambios, más lo aprendido)
1. **Adaptador de correo con BAA (SES)** — desbloquea todo lo demás.
2. **MFA (TOTP)** para el inicio de sesión.
3. Esperas durables en las automatizaciones (base de los recordatorios de citas).
4. **Entrega del asentimiento del menor** (hoy el paquete adolescente va solo al tutor).
5. Páginas y documentos en inglés (C1) y **reconsentimiento al cumplir 18**.
6. Sincronización de calendario `.ics` (ver `INTEGRACIONES.md` §3.1).
7. PDF del lado del servidor para exportar el expediente.
