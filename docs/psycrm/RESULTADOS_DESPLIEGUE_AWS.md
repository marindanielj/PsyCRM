# Resultados: primer despliegue en AWS (9 de noviembre de 2026)

Registro de lo que se desplegó, en qué orden, qué falló y cómo se arregló. Sin secretos: los nombres de secretos y roles sí aparecen, sus valores no.

## Cuentas e identidades

| Qué | Dónde | Valor |
|---|---|---|
| Organización | cuenta administradora | `o-0wtymyq41x` (todas las funciones) |
| Cuenta administradora | Daniel Marin | `432914184044` (paga la factura; no corre cargas) |
| Cuenta de PsyCRM | `psycrm-prod` | `450549238631`, correo raíz `marin.danielj+psycrm@gmail.com` |
| Acceso humano | IAM Identity Center | usuario `daniel`, conjunto `PsycrmAdmin` (AdministratorAccess, sesiones de 4 h), asignado solo a `psycrm-prod` |
| Rol de despliegue (GitHub OIDC) | `psycrm-prod` | `psycrm-github-deploy` |
| BAA de AWS | cuenta administradora (Artifact) | aceptado |
| Presupuesto | cuenta administradora | `psycrm-prod-monthly`: USD 100/mes, alertas al 80 % y 100 %, filtrado a `psycrm-prod` |

Nota: la cuenta raíz de `psycrm-prod` no tiene llaves de acceso y no se usa para operar. Pendiente: confirmar que su contraseña y MFA estén configurados.

## Línea de tiempo

1. **Pila `Psycrm` (fase 1, sin certificado):** falló el presupuesto (`linked account ... ask the payer account to enable budgets`). CloudFormation revirtió. El bucket de auditoría se eliminó con el rollback. Se quitó el presupuesto de la pila y se creó a mano en la cuenta administradora.
2. **Fase 1 de nuevo:** la pila se creó: llave KMS, red sin NAT, grupos de seguridad, ECR inmutable, CloudTrail, RDS PostgreSQL 16 privado, secretos, clúster, zona de Route 53 de `app.dramaritzamartinez.com` e identidad de SES.
3. **Delegación DNS:** en Network Solutions se crearon 4 registros NS con host `app` hacia los servidores de AWS. Verificado con DNS público: resuelven los 4.
4. **Fase 2 (certificado, balanceador, servicio):** `cdk deploy` con `enableCertificate=true`. El servicio quedó con 0 tareas: CDK fija `desiredCount` en cada despliegue, así que hay que pasar `-c desiredCount=1` siempre.
5. **Roles de la base (`psycrm-bootstrap`):** `db/roles.sql` ejecutado como usuario maestro de RDS. Creó `psycrm_migrator`, `psycrm_app` y el esquema `pgboss`. Dos ejecuciones, las dos sin error.
6. **Primer workflow de GitHub:** falló en `Could not assume role with OIDC` (ver problemas 1).
7. **Migraciones (`psycrm-migrate`):** falló con `EACCES` en `/tmp` (ver problema 2). Tras el arreglo, `exit code: 0`.
8. **Datos iniciales (`psycrm-seed`):** práctica "Dra. Maritza Martinez Soto" y cuenta de la doctora creadas, `exit code: 0`. La contraseña inicial es un secreto de Secrets Manager (`psycrm/owner-initial-password`); no se escribe en comandos ni en el chat.
9. **Encendido:** `aws ecs update-service --desired-count 1`. El log muestra `psycrm api listening on :8790` e `integrations enabled: none`.
10. **Verificación externa:** `https://app.dramaritzamartinez.com/health` responde `200 {"ok":true,"service":"psycrm"}`, con HSTS, CSP estricta y `nosniff`.

## Problemas del primer despliegue y su arreglo

| # | Síntoma | Causa | Arreglo | Dónde |
|---|---|---|---|---|
| 1 | `Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity` | GitHub envía el `sub` con ids numéricos: `repo:marindanielj@304752011/PsyCRM@1447179066:environment:production`. La política pedía la forma antigua. | Política actualizada a mano con `aws iam update-assume-role-policy` (acepta las dos formas) y el mismo cambio en `infra/lib/foundation-stack.ts`, con `githubOwnerId`/`githubRepoId` en `settings.ts`. | PR #4 |
| 2 | `EACCES: permission denied, mkdir '/tmp/tsx-1000'` en la tarea de migración | ECS monta `/tmp` como `root:root 0755`. El usuario `node` no puede escribir. | `Dockerfile`: `chown node:node /tmp && chmod 1777 /tmp` y `VOLUME ["/tmp"]` antes de `USER node`. Afecta a todas las tareas. | PR #4 |
| 3 | La pila no creaba el presupuesto | AWS no permite presupuestos en cuentas hijas sin que el pagador lo habilite. | Presupuesto fuera de la pila; creado en la cuenta administradora. | PR #2 |
| 4 | El servidor no arrancaría con el rol `psycrm_app` (pg-boss) | pg-boss intenta crear su esquema y ese rol no puede. | `PGBOSS_CREATE_SCHEMA=false` en producción; `db/roles.sql` crea el esquema. | PR #2 |
| 5 | Falta la tarea de datos iniciales | El código con `psycrm-seed` no estaba desplegado. | Zip con el código nuevo, `cdk deploy` con la etiqueta de imagen actual. | PR #5 |
| 6 | `TaskDefinition not found` al lanzar `psycrm-seed` | Mismo motivo que la 5: fusionar no crea recursos, solo `cdk deploy`. | Ídem. | — |

## Lecciones operativas

- **Fusionar un PR no despliega la infraestructura.** Solo `cdk deploy` crea o cambia recursos de AWS. Fusionar sí dispara el workflow de la aplicación.
- **CDK revierte `desiredCount` si no se pasa.** Siempre incluir `-c desiredCount=1` y `-c imageTag=<etiqueta actual>` en cada `cdk deploy`.
- **CloudShell no reemplaza archivos con el mismo nombre al subir.** Borrar el zip anterior o usar un nombre nuevo.
- **Los secretos generados no van en comandos.** `RunTask` deja los parámetros en CloudTrail. Por eso la contraseña inicial sale de Secrets Manager.

## Pendientes de esta fase

- [ ] **Solicitud de salida del sandbox de SES**: sin confirmar. El texto está en `CORREO_SES.md`.
- [ ] **Confirmación de la suscripción de alertas** en `marin.danielj@gmail.com` (correo de AWS Notifications).
- [ ] **Quitar el paso de depuración** "Show the OIDC claims this job presents" de `deploy.yml` (ya cumplió su función).
- [ ] **Prueba de restauración** de un respaldo de RDS (fase 5.5 de `INFRA_AWS.md`).
- [ ] **Entregar la contraseña inicial** a la doctora por canal seguro y que la cambie en Settings → Account.
- [ ] **Confirmar MFA y contraseña** de la cuenta raíz de `psycrm-prod`.
- [ ] **Cerrar o conservar el RDS viejo** (tarea 6.7): hoy no existe ninguno en la cuenta; se puede marcar como no aplicable.
