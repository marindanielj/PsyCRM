# Infraestructura de PsyCRM (AWS CDK)

Define en código lo que describe [`docs/psycrm/INFRA_AWS.md`](../docs/psycrm/INFRA_AWS.md). Una sola pila de CloudFormation (`Psycrm`) en tres partes:

| Parte | Qué crea | Necesita dominio |
|---|---|---|
| `Foundation` | llave KMS `alias/psycrm-data`, tema SNS `psycrm-alerts`, VPC (2 públicas, 2 privadas sin salida, sin NAT) con flow logs, grupos de seguridad, repositorio ECR `psycrm-app`, CloudTrail de la cuenta, proveedor OIDC y rol `psycrm-github-deploy` | No |
| `Data` | RDS PostgreSQL 16 (cifrado, privado, 30 días de backups, protegido contra borrado), los secretos (contraseñas generadas), clúster ECS y las tareas de una sola vez `psycrm-bootstrap` y `psycrm-migrate` | No |
| `App` | ALB (443 con certificado, 80 redirige), servicio Fargate `psycrm-app`, roles de tarea, alarmas | **Sí** (`publicBaseUrl` + `certificateArn`) |

La plantilla **no lleva el ID de cuenta**: se sintetiza sin credenciales y se despliega en la cuenta a la que apunten tus credenciales (`psycrm-prod`).

## Pruebas (sin credenciales)

```bash
cd infra && npm ci --legacy-peer-deps
npx tsc --noEmit && npx vitest run     # 17 pruebas sobre la plantilla: cifrado, RDS privado, un solo grupo abierto a internet, OIDC acotado, sin llaves de acceso…
npx cdk synth -c alertEmails=a@x.com   # escribe cdk.out/Psycrm.template.json
```

## Desplegar

Credenciales de `psycrm-prod` (IAM Identity Center o `OrganizationAccountAccessRole`), región `us-east-1`:

```bash
cd infra
npx cdk bootstrap                                   # una vez por cuenta
npx cdk deploy -c alertEmails=terapeuta@x.com,admin@x.com
```

Con eso existen `Foundation` y `Data`. Después, **en este orden**:

1. **Roles de la base** (una vez): `aws ecs run-task --cluster psycrm --launch-type FARGATE --task-definition psycrm-bootstrap --network-configuration …` (subredes públicas y el grupo `SG-app`; las ves en la consola de ECS). Ejecuta [`db/roles.sql`](../db/roles.sql) como usuario maestro: crea `psycrm_migrator` y `psycrm_app`, y el esquema `pgboss`.
2. **Imagen** (primer despliegue): el workflow `.github/workflows/deploy.yml` la construye y la sube al hacer *push* a `main`, o a mano: `docker buildx build --platform linux/arm64 -t <RepositoryUri>:<tag> --push .`
3. **Migraciones**: tarea `psycrm-migrate` (el workflow la corre solo; a mano, `command: npm run migrate`).
   **Datos iniciales de la práctica** (una vez), con la tarea `psycrm-seed`. La contraseña de la doctora la genera Secrets Manager (`psycrm/owner-initial-password`) y la tarea la lee de ahí: no se escribe en ningún comando, porque CloudTrail lo registraría. La app aún no tiene función de cambiar contraseña, así que esta es su contraseña real.

```bash
aws ecs run-task --cluster psycrm --launch-type FARGATE --task-definition psycrm-seed \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"seed","environment":[
      {"name":"PRACTICE_NAME","value":"<nombre de la consulta>"},
      {"name":"OWNER_EMAIL","value":"<correo de la doctora>"},
      {"name":"OWNER_NAME","value":"<su nombre>"},
      {"name":"SES_FROM_ADDRESS","value":"no-reply@app.dramaritzamartinez.com"}]}]}'
```

   Para entregar la contraseña: `aws secretsmanager get-secret-value --secret-id psycrm/owner-initial-password --query SecretString --output text` (una vez, y se la pasas por un canal seguro; no la pegues en chats ni correos).

4. **Dominio y correo** (`app.dramaritzamartinez.com`; el sitio web de la doctora en `dramaritzamartinez.com` no se toca). Solo ese nombre se delega a AWS, en dos fases porque el certificado solo se puede validar cuando la delegación ya existe:

```bash
# Fase 1: zona de Route 53 + identidad de SES (DKIM, MAIL FROM, DMARC). Sin certificado todavía.
npx cdk deploy -c alertEmails=… -c domainName=app.dramaritzamartinez.com
```

   Copia la salida `DomainZoneNameServers` (4 servidores) y, en **Network Solutions → Administrar dominio → DNS avanzado**, crea registros **NS** para el host `app` apuntando a esos 4 servidores (si el panel no permite NS en subdominios, ver "Plan B" abajo). Espera a que resuelva (`nslookup -type=NS app.dramaritzamartinez.com`; suele tardar minutos) y entonces:

```bash
# Fase 2: certificado validado por DNS, servicio, balanceador y registro `app`
npx cdk deploy -c alertEmails=… -c domainName=app.dramaritzamartinez.com \
  -c enableCertificate=true -c imageTag=<sha de la imagen> -c desiredCount=1
```

   Con `domainName`, la URL pública (`https://app.dramaritzamartinez.com`), el remitente (`no-reply@app.dramaritzamartinez.com`) y el conjunto de configuración de SES salen solos. Después, pide la salida del *sandbox* de SES (texto listo en [`CORREO_SES.md`](../docs/psycrm/CORREO_SES.md)).

   **Plan B** (si Network Solutions no admite NS en subdominios): no delegar; crear a mano en Network Solutions los CNAME de DKIM, el MX/TXT de `bounce.app`, el CNAME de validación del certificado y un CNAME `app` → DNS del ALB. Dímelo y ajusto el código para que no cree la zona y te dé la lista exacta de registros.

5. **Servicio público con un dominio ajeno al CDK** (alternativa; si el DNS lo manejas tú):

```bash
npx cdk deploy -c alertEmails=… \
  -c publicBaseUrl=https://app.<dominio> -c certificateArn=arn:aws:acm:us-east-1:<cuenta>:certificate/<id> \
  -c sesFromAddress=no-reply@<dominio> -c imageTag=<sha de la imagen> -c desiredCount=1
```

Contexto opcional: `enableGuardDuty` (false), `githubRepo`, `githubEnvironment`, `sesConfigurationSet`.

**CI/CD**: crea el entorno `production` en GitHub (con aprobación manual) y la variable de repositorio `AWS_DEPLOY_ROLE_ARN` con la salida `DeployRoleArn`. El workflow registra revisiones nuevas de las definiciones de tarea fuera de CDK; por eso, al volver a ejecutar `cdk deploy`, pasa `-c imageTag=<sha en producción>` o volverá a la imagen anterior.

## Verificado y no verificado

- **Verificado**: la plantilla sintetiza y pasa las 17 pruebas; `db/roles.sql` se probó en un PostgreSQL 16 real con un usuario sin privilegios de superusuario (migración como `psycrm_migrator`; `psycrm_app` lee y escribe pero no puede `TRUNCATE`, crear tablas ni alterar el esquema; `pg-boss` arranca con `createSchema: false`).
- **No verificado hasta el primer despliegue**: que CloudFormation acepte la referencia dinámica a las contraseñas dentro de los secretos `database-url`; que la imagen construya para ARM64; el tiempo real de creación del RDS; que `Custom::LogRetention` (logs de RDS) tenga permisos en la cuenta nueva.

## Lo que no está aquí

El **presupuesto** (AWS no deja crearlo desde una cuenta hija): se creó en la cuenta administradora como `psycrm-prod-monthly`. Dominio y zona de Route 53, certificado ACM, identidad de SES (dominio, DKIM, MAIL FROM, salida del *sandbox*), IAM Identity Center, el BAA, y un *trail* de la organización (este crea uno de la cuenta). La alarma de la cola de fallos de `pg-boss` no existe: esa cola vive en la base, no en CloudWatch.
