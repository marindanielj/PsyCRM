# Día 8: prueba completa, endurecimiento y salida a producción

## Objetivo
Comprobar con **datos ficticios** que el ciclo completo funciona en producción, cerrar los huecos de seguridad y dejar a la terapeuta lista para usarlo con su primer cliente real.

---

## 1. Prueba E2E automatizada (Playwright)

`scripts/e2e-psycrm.mjs` corre contra `npm run dev:local` (PGlite + seed de la práctica). Playwright y Chromium ya están instalados en el entorno. Pasos:

| # | Paso | Verificación |
|---|---|---|
| 1 | Login como la terapeuta | Aterriza en `/calendars` y la navegación solo muestra los módulos del MVP |
| 2 | Crear el contacto "Ana Prueba" con email | Tarjeta en "Documents sent"; existe un request del paquete adulto; audit `contact.created`, `packet.sent` y `pipeline.stage_changed` ×2 |
| 3 | Leer el link y el OTP desde un **sender falso** (el dev-server inyecta un `EmailSender` que guarda los mensajes en memoria y los expone en `GET /__dev/outbox`, solo en dev) | El email no contiene PHI (assert: no aparecen nombres de documentos ni "psicoterapia") |
| 4 | Abrir `/d/:token` en un contexto móvil (iPhone 13), verificar el OTP y completar los 6 documentos con la firma dibujada (trazos simulados en el canvas) | Hay 6 `signed_documents`, y la fecha de nacimiento y el contacto de emergencia aparecen en el contacto |
| 5 | De vuelta como la terapeuta | Tarjeta en "Documents signed" y la tarea "Schedule first appointment" creada |
| 6 | Crear una cita para hoy | Tarjeta en "First appointment booked" |
| 7 | Check-in → Start session note | Wizard con la cita precargada |
| 8 | Intentar firmar sin riesgo | Botón deshabilitado; la API devuelve 422 si se fuerza |
| 9 | Completar el riesgo con nivel Moderate, el rationale y la acción "safety_plan_reviewed", y luego DAP → Sign | Nota firmada; RiskBadge ámbar en el contacto; aparece en "Elevated risk"; la tarjeta pasa a "Active client"; la cita pasa a `completed` |
| 10 | Abrir el reporte → Print | `page.pdf()` genera un PDF con el membrete, la sección de riesgo y la firma |
| 11 | Simular las 72 h: `UPDATE session_notes SET locks_at = now() - interval '1 minute'` (solo en el test, con `SET session_replication_role = replica` en esa conexión para saltarse el trigger) | Desaparece "Edit"; `PATCH` devuelve 409; el anexo funciona |
| 12 | Settings → Audit log → Verify integrity | ✅, y la exportación CSV contiene todos los eventos anteriores |
| 13 | Esperar el timeout por inactividad (en el test con `IDLE_TTL_MS` corto) | Vuelve a `/login` |

Hay que guardar las capturas de cada paso en `docs/psycrm/e2e/` (sin datos reales) para revisarlas con la terapeuta.

## 2. Revisión de seguridad (checklist)

- [ ] **Tenancy**: un test que intenta leer notas, documentos y audit de otra `location` recibe 404 (ya cubierto por día; se agrega uno transversal).
- [ ] **Sin PHI en logs**: grep de `console.(log|error)` en `server/`; los errores registran códigos e IDs, nunca cuerpos de request.
- [ ] **Sin PHI en URLs**: las rutas solo usan IDs. Los tokens públicos van en la ruta, con `Referrer-Policy: no-referrer`.
- [ ] **Sin PHI en `localStorage` ni `sessionStorage`** en el SPA (grep).
- [ ] **Cabeceras**: CSP, HSTS, `no-store` y `X-Frame-Options` verificadas con `curl -I` en producción.
- [ ] **Rate limit**: login (existe), OTP, verify y sign.
- [ ] **Secretos**: `SESSION_SECRET` ≥ 32 caracteres en AWS Secrets Manager; ningún `.env` en el repo.
- [ ] **Integraciones apagadas** en `PSYCRM_MODE`: assistant, Chatwoot, voice, social, federation y SMS (rutas en 404 y workers sin registrar).
- [ ] **Dependencias**: `npm audit --omit=dev` sin vulnerabilidades altas ni críticas.
- [ ] Correr el skill `/security-review` sobre la rama antes del merge.

## 3. Operación

- **Backups**: hacer una **prueba de restauración** de RDS a una instancia temporal, verificar que `audit/verify` da `ok` en la copia y luego borrar la instancia. Documentar la fecha.
- **Monitoreo**: un chequeo de CloudWatch (Route 53 health check o canary) sobre `/health` con alerta por email a la terapeuta y al admin. Alerta si llegan jobs a la DLQ de pg-boss (`workflow_dispatch_dlq`).
- **Deploy**: `npm run migrate` y luego desplegar la nueva imagen en App Runner (`aws apprunner start-deployment`). Rollback = desplegar la revisión anterior (el esquema es aditivo e idempotente, así que no hace falta revertir la BD).
- **Cuenta**: la contraseña de la terapeuta (larga, en un gestor de contraseñas), con la recuperación documentada. **MFA es lo primero de la semana 2.**

## 4. Lista de salida a producción (go / no-go)

| # | Ítem | Responsable |
|---|---|---|
| 1 | BAA de AWS aceptado en Artifact y guardado, y servicios verificados contra la lista HIPAA Eligible Services | Admin |
| 2 | Si se usa un proveedor de email: BAA firmado, o confirmación de que los emails no contienen PHI (solo links) y la política de riesgo aceptada por escrito | Admin + terapeuta |
| 3 | **Plantillas revisadas por la terapeuta y por un asesor legal en PR** (consentimiento informado, límites de confidencialidad, Ley 408-2000 para menores, retención de expedientes) y **activadas** | Terapeuta |
| 4 | Datos de la práctica, la licencia, los honorarios y la política de cancelación cargados en Settings → Practice | Terapeuta |
| 5 | Números de crisis verificados (988, Línea PAS) | Terapeuta |
| 6 | E2E (§1) en verde **en producción** con un contacto ficticio, luego archivado | Admin |
| 7 | Restauración de backup probada | Admin |
| 8 | Política interna de una página (acceso, retención, respuesta a brechas) | Terapeuta |
| 9 | Sesión de 30 min de entrenamiento con la guía rápida (§5) | Admin + terapeuta |

## 5. Guía rápida para la terapeuta (`docs/psycrm/GUIA_RAPIDA.md`, en español)
Una página con capturas:
1. Cliente nuevo: Add contact → el paquete sale solo → seguir el progreso en la pestaña Documents.
2. Adolescente (menor de 18): poner la fecha de nacimiento y los datos del tutor → Send onboarding packet (se preselecciona Adolescent).
3. Día de la sesión: Calendars → Check in → Start session note.
4. La nota: los 5 pasos; el riesgo es obligatorio; tiene 72 h para corregir; después, solo anexos.
5. Imprimir o exportar una nota: abrir la nota → Print / Save as PDF.
6. Ver qué pasó: Settings → Audit log, o la pestaña Audit del cliente.
7. Qué hacer si se le olvidó la contraseña o algo falla.

## 6. Pendientes priorizados para la semana 2
1. **MFA (TOTP)** para el login de la terapeuta.
2. Esperas durables en workflows (base para **A1: recordatorios de citas**).
3. **C1**: versiones en inglés de los documentos de onboarding (selector de idioma en la página pública).
4. **Reconsentimiento al cumplir 18**: un cliente que empezó como menor (con el consentimiento del tutor) y cumple 18 debe firmar por sí mismo.
   - Reporte **"Clients turning 18 in 60 days"**, calculado de `date_of_birth`, en el panel de inicio.
   - Paquete sembrado **"Re-consent – turned 18"** (consentimiento informado, privacidad y honorarios a nombre del cliente), con `audience = adult`.
   - Un trigger de workflow `client_turned_18` (job diario) que crea la tarea "Send re-consent packet to {client}" y, si ella lo activa, envía el paquete solo.
   - A partir de los 18, el tutor deja de tener acceso a la información: el sistema desactiva sus enlaces pendientes y lo registra en el audit.
5. PDF del lado del servidor (Puppeteer) para exportar el expediente completo.

---

## Criterios de aceptación
1. El E2E pasa completo en local y una vez en producción.
2. La checklist de seguridad está completa (los ítems que no apliquen, justificados).
3. La lista go/no-go está en verde o con una excepción aceptada por escrito.
4. La guía rápida está entregada y la terapeuta completó el ciclo una vez por sí misma.
