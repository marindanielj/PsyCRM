# PsyCRM: specs del MVP, día por día

Cada spec se puede implementar por sí solo y en orden. Parte de [`../PLAN_MVP.md`](../PLAN_MVP.md) (decisiones en §6).

| Día | Spec | Depende de |
|---|---|---|
| 1 | [Base: deploy, módulos, sesión, seed](day-01-foundation.md) · ✅ hecho | — |
| 2 | [Log de auditoría](day-02-audit-log.md) · ✅ hecho | 1 |
| 3 | [Notas de sesión: backend](day-03-session-notes-backend.md) · ✅ hecho | 2 |
| 4 | [Notas de sesión: UI, reporte, riesgo y check-in](day-04-session-notes-ui.md) · ✅ hecho | 3 |
| 5 | [Plantillas y paquetes de documentos](day-05-document-templates.md) · ✅ hecho | 2 |
| 6 | [Firma pública de documentos](day-06-public-signing.md) · ✅ hecho | 5 |
| 7 | [Automatización del pipeline de onboarding](day-07-onboarding-automation.md) · ✅ hecho | 2, 4, 6 |
| 8 | [Prueba completa, endurecimiento y salida a producción](day-08-e2e-golive.md) · ✅ hecho (software); la salida a producción depende de la lista go/no-go | todos |

Extras posteriores al día 7: [invitación al cliente](extra-client-invite.md) · [marca por práctica](extra-branding.md) · [página pública y solicitudes](../RESULTADOS_PAGINA_PUBLICA.md).

Ideas futuras con spec: [constructor de páginas por bloques (A12)](future-page-builder.md).

**Resultados:** [días 1 y 2](../RESULTADOS_DIAS_1_2.md) · [día 3](../RESULTADOS_DIA_3.md) · [día 4](../RESULTADOS_DIA_4.md) · [día 5](../RESULTADOS_DIA_5.md) · [día 6](../RESULTADOS_DIA_6.md) · [día 7](../RESULTADOS_DIA_7.md) · [invitación](../RESULTADOS_INVITACION.md) · [día 8](../RESULTADOS_DIA_8.md) · [marca](../RESULTADOS_MARCA.md) · [correo SES](../RESULTADOS_SES.md). Operación: [`OPERACIONES.md`](../OPERACIONES.md) · guía: [`GUIA_RAPIDA.md`](../GUIA_RAPIDA.md).

## Convenciones para todos los días

- **Idioma:** el código, los identificadores y la **UI de la terapeuta en inglés**. Las páginas públicas, los emails y los documentos para clientes en **español**. Los specs están en español.
- **Esquema:** todo cambio va en `db/schema.sql` y debe ser **idempotente**: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`. Correr `npm run migrate` dos veces no debe fallar.
- **Tenancy:** todo repo nuevo extiende `LocationScopedRepo` (`server/repos/base-repo.ts`) y toda ruta operativa se monta bajo `/api/loc/:loc/*` (pasa por `operatorAuth` + `locationAccess`).
- **Tests:**
  - lógica de rutas y repos con `FakeDatabase`, siguiendo el patrón de `server/routes/contacts.test.ts`;
  - **triggers y CHECK de Postgres con PGlite** cargando `db/schema.sql`: helper nuevo `server/test-utils/pglite.ts` (se crea el día 2).
- **Auditoría:** desde el día 2, toda feature nueva escribe en `audit_log` con `audit()` (`server/lib/audit.ts`).
- **Infraestructura:** ver [`../INFRA_AWS.md`](../INFRA_AWS.md) (diagrama, piezas y tareas).
- **Zona horaria:** `America/Puerto_Rico` para mostrar fechas. Se guarda siempre en `timestamptz` (UTC).
- **PHI:** nunca en logs (`console.log`), en URLs ni en el cuerpo de emails o SMS.
- **Definition of done** de cada día:
  1. `npm run typecheck` y `npm test` en verde;
  2. el esquema migra sobre una BD vacía y sobre la del día anterior;
  3. se cumplen los criterios de aceptación del spec;
  4. commit `feat(psycrm): day N – <tema>`.
