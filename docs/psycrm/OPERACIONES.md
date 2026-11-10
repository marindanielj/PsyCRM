# Operación de PsyCRM

Para quien administra el sistema (no para la terapeuta; para ella está [`GUIA_RAPIDA.md`](GUIA_RAPIDA.md)). La infraestructura está en [`INFRA_AWS.md`](INFRA_AWS.md).

## 1. Variables obligatorias en producción
El servidor **no arranca** si falta o está mal alguna (`server/lib/config.ts`):

| Variable | Regla |
|---|---|
| `SESSION_SECRET` | 32 caracteres o más, distinta del valor de desarrollo; en AWS Secrets Manager |
| `DATABASE_URL` | con `sslmode=verify-full` y el certificado raíz de RDS (`/app/certs/rds-global-bundle.pem`) |
| `PUBLIC_BASE_URL` | la dirección **https** de la aplicación. Se usa en los enlaces de los correos (firma e invitación); sin ella el servidor no arranca |
| `SES_FROM_ADDRESS` / `SES_REGION` | El remitente verificado en SES y su región (ver [`CORREO_SES.md`](CORREO_SES.md)) |
| `ENABLED_INTEGRATIONS` | **vacía**. El registro de arranque debe decir `integrations enabled: none` |
| `STATIC_DIR` | `/app/dist` (ya fijada en la imagen) |

## 2. Despliegue
1. Construir la imagen (`docker buildx build --platform linux/arm64 -t psycrm-app .`) y subirla a ECR.
2. **Migrar** como tarea única de ECS: `aws ecs run-task … --overrides '{"containerOverrides":[{"name":"app","command":["npm","run","migrate"]}]}'`. Esperar a que termine con código 0. El esquema es **aditivo e idempotente** (se aplicó dos veces contra un PostgreSQL 16 real en las pruebas del día 8): repetirla es seguro.
3. `aws ecs update-service --force-new-deployment`. El *circuit breaker* del servicio debe estar activado (revierte si la tarea nueva no pasa `/health`).
4. **Revertir** = apuntar el servicio a la definición de tarea anterior. No hace falta deshacer la base de datos.
5. Antes de un despliegue con cambios de esquema: **instantánea manual de RDS**.

### 2.1 Tareas de una sola vez contra la base de producción
La base está en una red privada, sin acceso directo: todo lo que hay que ejecutar contra ella se corre como tarea única de ECS con la definición `psycrm-migrate` (misma red, mismo secreto de conexión) y un `command` distinto. La imagen contiene `server/` y `db/` (no `scripts/`), así que lo que se ejecute así debe vivir en `db/` y tener su comando en `package.json`.

Ejemplo, encender un módulo para una práctica (`npm run enable-module`):

```bash
aws ecs run-task --cluster psycrm --launch-type FARGATE --task-definition psycrm-migrate \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["npm","run","enable-module"],"environment":[
      {"name":"PRACTICE_SLUG","value":"<slug de la práctica>"},
      {"name":"MODULE","value":"billing"}]}]}'
```

El resultado (qué hizo y la lista de módulos que quedó) sale en los registros de CloudWatch de la tarea; **no** contiene datos de clientes. Una tarea que termina con código distinto de 0 no cambió nada.

## 3. Primer arranque de una práctica nueva
1. `npm run migrate`, luego `npm run seed:practice` (crea la práctica, la dueña, el pipeline Onboarding, el calendario, los campos y **las 9 plantillas y 2 paquetes en borrador**, y **los 4 workflows de onboarding apagados**).
2. Cambiar la contraseña de la dueña por una larga (`scripts/rotate-op-password.ts`, variables de entorno, nunca argumentos).
3. La terapeuta completa **Settings → Practice** (nombre, licencia, dirección, honorarios, política de cancelación).
4. La terapeuta **revisa y adapta** cada plantilla (con asesoría legal) y las **activa** en Documents.
5. Solo entonces enciende los **workflows** en Automations. Hasta ese momento, registrar a un cliente no envía nada.
6. Prueba con un cliente ficticio de punta a punta (sección 7) y archivarlo.

## 4. Copias de seguridad y prueba de restauración
- RDS con copias automáticas (retención **35 días** recomendada) y cifrado. La recuperación a un instante (PITR) queda cubierta.
- **Prueba de restauración (hacerla antes de abrir al público y repetirla cada trimestre):**
  1. Restaurar la última instantánea a una instancia **temporal** (otro identificador, sin acceso público).
  2. Conectarse y comprobar:
     ```sql
     SELECT id FROM locations;                                -- una por práctica
     SELECT audit_log_verify('<location_id>');                -- debe devolver 0 (cadena íntegra)
     SELECT count(*) FROM session_notes;                      -- coincide con la producción
     SELECT count(*) FROM signed_documents;
     ```
  3. Borrar la instancia temporal.
  4. Anotar la fecha, la persona y el resultado en el registro del final de este documento.

## 5. Monitoreo y alertas
- **Chequeo de salud** (Route 53 o canary de CloudWatch) sobre `GET /health`, con alerta por correo a la terapeuta y al administrador.
- Alarmas de CloudWatch → SNS: tareas de ECS en ejecución < 1, 5xx del ALB, CPU y almacenamiento libre de RDS, conexiones de RDS.
- **Cola de errores de automatizaciones**: si llega un trabajo a `workflow.dispatch.dead` (pg-boss), un paso de onboarding no se pudo ejecutar tras todos los reintentos. Alerta con:
  ```sql
  SELECT count(*) FROM pgboss.job WHERE name = 'workflow.dispatch.dead' AND state = 'created';
  ```
- Los registros de la aplicación **no contienen datos de clientes**: solo códigos de error y mensajes fijos (verificado por una prueba que revisa cada `console.*` del servidor).

## 6. Si algo falla
| Síntoma | Qué mirar |
|---|---|
| El cliente no recibe el correo | Settings → Email & SMS: ¿hay proveedor (Amazon SES)? Use **Send test email**; la guía de errores está en [`CORREO_SES.md`](CORREO_SES.md). ¿Hay proveedor? Sin proveedor la invitación y el paquete **se crean igual** y el enlace aparece en pantalla (Copy link / Resend) para enviarlo a mano |
| Una corrida de automatización aparece como *Failed* | Automations → el flujo → Recent runs: el paso fallido dice por qué (correo sin configurar, plantilla sin versión activa, `PUBLIC_BASE_URL`…). Corregir y volver a enviar desde la ficha del cliente |
| Un paquete "retenido para revisión" | Ficha del cliente → Documents: la fecha de nacimiento respondida no coincide con el expediente. Revisar y **Accept as complete**, o corregir y reenviar |
| Se perdió una contraseña (si aún puede entrar, *Settings → Account*) | `scripts/rotate-op-password.ts` (con `DATABASE_URL`, `ROTATE_OPERATOR_ID` y `ROTATE_NEW_PASSWORD` como variables de entorno). Registrar el cambio |
| Un cliente dice que su enlace "no es válido" | Venció (14 días), se anuló o ya se usó. Reenviar: Resend en la solicitud, o en la invitación |

## 7. Prueba de punta a punta
`node scripts/e2e-psycrm.mjs` levanta la aplicación de desarrollo (PGlite, datos ficticios), recorre el ciclo completo en un navegador real y guarda capturas en [`e2e/`](e2e/). Debe pasar completa antes de cada salida a producción. En producción se repite a mano con un cliente ficticio (que luego se archiva) siguiendo los mismos 13 pasos.

## 8. Pruebas contra un PostgreSQL real
Las pruebas normales usan PGlite (un motor en memoria que atiende una consulta a la vez, así que **no puede mostrar una carrera**). Las de concurrencia corren contra un servidor real:
```bash
PG_TEST_URL=postgres://postgres@localhost:5544/postgres npx vitest run server/db/real-postgres.test.ts
```
Cada ejecución crea y borra su propia base de datos. Sin la variable, la suite se omite.

## Registro
| Fecha | Qué | Quién | Resultado |
|---|---|---|---|
| | Prueba de restauración de RDS | | |
| | Prueba E2E en producción (cliente ficticio) | | |
