# PsyCRM: infraestructura en AWS

> Decisiones tomadas: **AWS**, cuenta hija dentro de la organización existente, **ECS Fargate + balanceador (ALB)**, **RDS PostgreSQL 16**, **SES** para correo, región `us-east-1`. Las otras apps de la dueña siguen en Vercel y no se tocan.
>
> Este documento es el mapa de lo que hay que crear, cómo se conecta y en qué orden. Los costos son estimados **sin cotizar**. Todos los servicios deben confirmarse en la lista oficial *AWS HIPAA Eligible Services* antes de guardar datos reales (ver §8, tarea 1.4).

---

## 1. Diagrama

```
                             INTERNET
        ┌──────────────────────┼───────────────────────┐
        │                      │                       │
   Terapeuta              Cliente / tutor          (SES envía)
   (app web)         (página pública de firma)          ▲
        │                      │                       │
        └──────────┬───────────┘                       │
                   │ HTTPS 443  (dominio TBD)          │
                   ▼                                   │
        ┌─────────────────────┐   Route 53 (DNS) ──────┤ DKIM/SPF
        │  Certificado (ACM)  │                        │
        └──────────┬──────────┘                        │
                   │                                   │
═══ CUENTA AWS "psycrm-prod" (cuenta hija de la organización) ═══════════
                   │                                   │
┌──────────────────┼───────────────────────────────────┼───────────────┐
│ VPC 10.20.0.0/16 (us-east-1, 2 zonas de disponibilidad)              │
│                  │                                   │               │
│  SUBREDES PÚBLICAS (2)                               │               │
│  ┌───────────────▼───────────────┐                   │               │
│  │ Application Load Balancer     │                   │               │
│  │ SG-alb: entra 443/80 de todos │                   │               │
│  │ 80 → redirige a 443           │                   │               │
│  └───────────────┬───────────────┘                   │               │
│                  │ HTTP 8790 (solo desde SG-alb)     │               │
│  ┌───────────────▼───────────────┐                   │               │
│  │ ECS Fargate · servicio        │ ── sale a ────────┘               │
│  │ "psycrm-app" (1 tarea)        │    SES · Secrets Manager · ECR    │
│  │ API Hono + SPA + pg-boss      │    · CloudWatch                   │
│  │ SG-app: entra solo de SG-alb  │                                   │
│  └───────────────┬───────────────┘                                   │
│                  │ PostgreSQL 5432 + SSL (solo desde SG-app/SG-mig)  │
│  SUBREDES PRIVADAS (2, sin salida a internet)                        │
│  ┌───────────────▼───────────────┐                                   │
│  │ RDS PostgreSQL 16             │                                   │
│  │ cifrado KMS · backups 30 días │                                   │
│  │ SG-db                         │                                   │
│  └───────────────────────────────┘                                   │
└──────────────────────────────────────────────────────────────────────┘

Servicios regionales fuera de la VPC (todos en la misma cuenta):
  ECR (imagen) · Secrets Manager (secretos) · KMS (llave de cifrado)
  CloudWatch Logs + Alarmas · CloudTrail (auditoría de AWS) · SES

CI/CD:  GitHub (repo) ──Actions──► [OIDC] ──► ECR (push) ──► ECS (deploy)
        └─ antes de cada deploy: tarea única de ECS que corre `npm run migrate`
```

**Flujo de una petición:** navegador → Route 53 → ALB (termina TLS con el certificado de ACM) → tarea de Fargate (puerto 8790) → RDS. El servidor sirve tanto la API (`/api/*`) como la app web (archivos de `dist/`); no hay servidor aparte para el front-end.

**Flujo del correo:** la app llama a SES (`lib/sending/ses-adapter.ts`, por escribir en el día 6) → SES envía el email al cliente con el enlace de firma. El cuerpo nunca lleva datos clínicos.

---

## 2. Organización de cuentas

| Cuenta | Qué contiene | Quién entra |
|---|---|---|
| **Cuenta actual** (administradora de la organización) | Lo que ya tienen (incluido el RDS viejo, mientras exista). Recibe la **factura única** de toda la organización | Dueño del negocio / admin |
| **`psycrm-prod`** (cuenta hija, nueva) | Todo PsyCRM y nada más | Solo el admin técnico. La terapeuta **no** entra a la consola de AWS |
| *(opcional, después)* `psycrm-dev` | Pruebas con datos ficticios | Admin técnico |

Por qué una cuenta aparte: menos gente con acceso a los datos de salud, menos servicios que revisar en una auditoría, y si algo se compromete en otra app no alcanza a PsyCRM. La organización mantiene una sola factura.

---

## 3. Piezas, una por una

### 3.1 Red (VPC)
| Elemento | Configuración |
|---|---|
| VPC | `10.20.0.0/16`, DNS habilitado |
| Subredes públicas | 2 (una por zona), `10.20.0.0/24` y `10.20.1.0/24`. Alojan el ALB y las tareas de Fargate |
| Subredes privadas | 2, `10.20.10.0/24` y `10.20.11.0/24`. Solo RDS. **Sin ruta a internet** |
| Internet Gateway | 1, asociado a las subredes públicas |
| NAT Gateway | **No** en el MVP (ahorra ~USD 32/mes). Ver nota abajo |
| VPC Flow Logs | Activados hacia CloudWatch (retención 90 días) |

> **Nota (tareas en subred pública):** la tarea necesita IP pública para llegar a ECR, Secrets Manager, SES y CloudWatch sin NAT. Es aceptable porque su grupo de seguridad **no permite ninguna entrada** salvo desde el ALB. Si la política de seguridad futura lo exige, se mueve a subredes privadas con NAT o *VPC endpoints* sin tocar la app.

### 3.2 Grupos de seguridad
| Grupo | Entrada | Salida |
|---|---|---|
| `SG-alb` | TCP 443 y 80 desde `0.0.0.0/0` | TCP 8790 hacia `SG-app` |
| `SG-app` | TCP 8790 **solo** desde `SG-alb` | TCP 5432 hacia `SG-db`; TCP 443 a internet (ECR, SES, Secrets Manager, CloudWatch) |
| `SG-db` | TCP 5432 **solo** desde `SG-app` | ninguna necesaria |
| `SG-mig` (tarea de migración) | ninguna | igual que `SG-app`. Puede reutilizar `SG-app` |

### 3.3 Base de datos: RDS PostgreSQL
| Parámetro | Valor |
|---|---|
| Motor | PostgreSQL 16 |
| Clase | `db.t4g.micro` (empezar) → `db.t4g.small` si hace falta |
| Zonas | Una sola (Single-AZ). Multi-AZ duplica el costo y se deja para después |
| Almacenamiento | 20 GB `gp3`, con autoescalado hasta 100 GB |
| Cifrado | **Sí, con KMS desde la creación** (no se puede activar después). Recomendado: llave administrada por el cliente (`alias/psycrm-data`, ~USD 1/mes) |
| Acceso público | **No** |
| Subredes | Grupo de subredes privadas |
| Backups automáticos | **30 días**, con restauración a un punto en el tiempo |
| Protección contra borrado | **Activada**. Instantánea final obligatoria al borrar |
| SSL | Obligatorio: parámetro `rds.force_ssl = 1` |
| Parámetro útil | `log_min_duration_statement = 2000` para ver consultas lentas |
| Logs a CloudWatch | `postgresql` y `upgrade`. **No** activar `log_statement = all` (volcaría PHI a los logs) |
| Mantenimiento | Ventana de madrugada (AST) y actualizaciones menores automáticas |

**Dos usuarios de base de datos:**
| Rol | Permisos | Se usa en |
|---|---|---|
| `psycrm_migrator` | Dueño del esquema (crear tablas, triggers, funciones) | Solo la tarea de migración |
| `psycrm_app` | `SELECT/INSERT/UPDATE/DELETE` en las tablas; **sin** `TRUNCATE` sobre `audit_log` ni sobre las tablas clínicas, y sin permiso para alterar el esquema | El servidor |

Esto es parte de la protección del log de auditoría (día 2): el rol de la app no puede vaciar ni modificar la estructura. `pg-boss` crea su propio esquema `pgboss`: darle a `psycrm_app` permiso de crear en ese esquema (o dejar que lo cree el migrador una vez).

### 3.4 Contenedor y servidor (ECR + ECS Fargate)
| Elemento | Configuración |
|---|---|
| Repositorio ECR | `psycrm-app`, **inmutabilidad de etiquetas** activada, escaneo de vulnerabilidades al subir, cifrado KMS, política de ciclo de vida (conservar las últimas 20 imágenes) |
| Clúster ECS | `psycrm` (Fargate) |
| Definición de tarea | 0.5 vCPU, 1 GB RAM, Linux ARM64 (más barato; construir la imagen para `linux/arm64`), puerto 8790, usuario no root, sistema de archivos raíz de solo lectura **con un volumen efímero montado en `/tmp`** (el servidor lo usa para su caché de ejecución) |
| Servicio | `psycrm-app`, **`desiredCount = 1`**, mínimo de salud 100 % y máximo 200 % (despliegue sin corte), *circuit breaker* con reversión automática |
| Verificación de salud | ALB → `GET /health` (200). Contenedor: el mismo |
| Escalado | **Ninguno** en el MVP. Con una sola tarea, las esperas en memoria del motor de workflows funcionan como hoy (ver día 7) |
| Logs | Driver `awslogs` → grupo `/psycrm/app`, retención 90 días |

**Variables de entorno de la tarea** (las sensibles vienen de Secrets Manager, no se escriben en la definición):

| Variable | Origen | Valor / nota |
|---|---|---|
| `NODE_ENV` | texto | `production` |
| `PORT` | texto | `8790` |
| `PSYCRM_MODE` | texto | `true` (apaga IA, Chatwoot, voz, social, federation y SMS; día 1) |
| `DATABASE_URL` | **Secrets Manager** | `postgres://psycrm_app:…@<endpoint-rds>:5432/psycrm?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem` |
| `SESSION_SECRET` | **Secrets Manager** | ≥ 32 caracteres aleatorios |
| `CHATWOOT_WEBHOOK_SECRET` | **Secrets Manager** | Cualquier valor largo; `config.ts` lo exige aunque no se use |
| `STATIC_DIR` | imagen | `/app/dist` (ya viene en el `Dockerfile`; el servidor sirve la app web desde ahí) |
| `TMPDIR` | imagen | `/tmp` (ya viene en el `Dockerfile`) |
| `AWS_REGION` | texto | `us-east-1` |
| `SES_FROM_ADDRESS` | texto | Remitente verificado, p. ej. `no-reply@<dominio>` (día 6) |
| `PUBLIC_BASE_URL` | texto | URL pública (dominio o DNS del ALB), para los enlaces de los emails |

> **SSL a la base (resuelto en el día 1):** `pg` y `pg-boss` leen `sslmode` y `sslrootcert` de la propia `DATABASE_URL`, así que no hizo falta cambiar la conexión. El `Dockerfile` descarga el certificado raíz de RDS a `/app/certs/rds-global-bundle.pem`, y la URL del secreto debe terminar en `?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem`. Con `PSYCRM_MODE=true` en producción, el servidor **se niega a arrancar** si la URL no usa `sslmode=verify-full` (o `verify-ca`).

### 3.5 Entrada: ALB, certificado y DNS
| Elemento | Configuración |
|---|---|
| ALB | Público, en las 2 subredes públicas, `SG-alb`. Escucha 443 (certificado ACM, política TLS 1.2+ moderna) y 80 (redirige a 443) |
| Grupo de destino | Tipo IP (requerido por Fargate), puerto 8790, salud `/health` |
| Logs de acceso del ALB | **Desactivados en el MVP** (requieren un bucket S3 y las URL pueden llevar tokens); si se activan, S3 cifrado y con ciclo de vida de 90 días |
| Certificado ACM | Para `app.<dominio>`, validado por DNS |
| Route 53 | Zona hospedada del dominio. Registro `A` (alias) → ALB. Registros de SES (DKIM, SPF, MAIL FROM) |
| **Sin dominio aún** | Se usa el nombre DNS del ALB (`*.elb.amazonaws.com`) solo con **datos ficticios**: no hay certificado válido para ese nombre. **El dominio es requisito antes del primer cliente real** |

### 3.6 Correo: SES
| Elemento | Configuración |
|---|---|
| Identidad | El dominio completo (con DKIM de 2048 bits). Mientras no haya dominio: una dirección de email verificada, solo para pruebas |
| Salir del *sandbox* | Pedir **acceso a producción** en SES (formulario; suele tardar ~1 día). En el sandbox solo envía a direcciones verificadas |
| Remitente | `no-reply@<dominio>`; MAIL FROM propio para SPF alineado |
| Conjunto de configuración | Con eventos de rebote y queja hacia CloudWatch; lista de supresión activada |
| Permiso | El rol de la tarea puede `ses:SendEmail` **solo** desde la identidad del dominio |
| Contenido | **Sin PHI** en asunto ni cuerpo; solo el enlace (regla de los días 6–7) |

### 3.7 Secretos y llaves
| Elemento | Detalle |
|---|---|
| Secrets Manager | Tres secretos (`psycrm/database-url`, `psycrm/session-secret`, `psycrm/chatwoot-webhook-secret`), cifrados con la llave KMS `psycrm-data`. El rol de ejecución de la tarea tiene permiso de lectura solo sobre estos |
| Contraseñas de BD | Guardadas aquí. Rotación automática de la contraseña de RDS: **después del MVP** |
| KMS | Una llave administrada por el cliente para RDS, Secrets Manager, ECR y CloudWatch Logs. Rotación anual activada |

### 3.8 IAM
| Rol | Para qué | Permisos principales |
|---|---|---|
| `psycrm-task-execution` | Que ECS arranque la tarea | Descargar de ECR, escribir logs, leer los 3 secretos |
| `psycrm-task` | Lo que el código puede hacer | `ses:SendEmail` (solo la identidad del dominio). Nada más en el MVP |
| `psycrm-github-deploy` | GitHub Actions | Federado por **OIDC** (sin llaves guardadas): subir a ECR, registrar la definición de tarea, `ecs:UpdateService`, `ecs:RunTask` (migración), `iam:PassRole` solo de los dos roles de arriba |
| Acceso humano | Administrador técnico | **IAM Identity Center** (SSO) con MFA. Sin usuarios IAM con llaves de acceso permanentes |

La cuenta raíz de `psycrm-prod` queda con MFA (llave física o app) y **sin uso diario**.

### 3.9 Observabilidad y auditoría de AWS
| Elemento | Configuración |
|---|---|
| CloudTrail | Registro de eventos de administración en toda la cuenta, en un bucket S3 cifrado y con bloqueo de acceso público. **Preferible un *trail* de la organización** desde la cuenta administradora |
| CloudWatch Logs | `/psycrm/app` (90 días), flow logs de la VPC, logs de RDS |
| Alarmas → SNS → email (terapeuta y admin) | (1) `/health` fallando (chequeo de salud de Route 53 o *canary*); (2) RDS: CPU > 80 % sostenido, espacio libre < 20 %, conexiones; (3) ECS: tarea detenida o `RunningTaskCount < 1`; (4) ALB: 5xx; (5) SES: tasa de rebote/queja; (6) mensajes en la cola de fallos de pg-boss (`workflow_dispatch_dlq`); (7) **presupuesto mensual** (ver §5) |
| GuardDuty | Activar en la cuenta (revisar si está cubierto por el BAA y su costo; ~USD 5–10/mes). Recomendado, no bloqueante |

> El **registro de auditoría clínico** (quién vio o cambió qué dato de un cliente) vive en la tabla `audit_log` de la base de datos (día 2), no en CloudWatch. Los logs de aplicación **no deben contener PHI**.

### 3.10 Lo que NO hace falta en el MVP
S3 para archivos (la firma dibujada se guarda como imagen pequeña en la base de datos), NAT Gateway, WAF (la app ya limita intentos de login/OTP; evaluar después), Multi-AZ, autoescalado, CloudFront, Cognito, SQS (el proyecto usa `pg-boss` sobre Postgres), un segundo ambiente (`psycrm-dev`), copia de backups a otra región.

---

## 4. Pipeline de despliegue (GitHub Actions)

```
push a main ──► build (npm ci · typecheck · test · vite build)
            ──► docker build (linux/arm64) ──► push a ECR (etiqueta = SHA del commit)
            ──► ecs run-task  "psycrm-migrate" (npm run migrate)  ← espera código de salida 0
            ──► ecs update-service  (nueva definición de tarea con la imagen nueva)
            ──► espera estabilidad ──► si falla /health, el circuit breaker revierte
```
- Autenticación por OIDC con el rol `psycrm-github-deploy`, limitado al repositorio y a la rama `main` (condición `sub` en la política de confianza).
- Aprobación manual (entorno protegido de GitHub) antes del paso de migración en producción.
- **Rollback:** apuntar el servicio a la definición de tarea anterior. El esquema es aditivo e idempotente, así que no se revierte la base.
- El repositorio no debe contener ningún secreto ni `.env`.

---

## 5. Costos mensuales estimados (sin cotizar)

| Concepto | Estimado (USD) |
|---|---|
| RDS `db.t4g.micro` + 20 GB + backups | 15–30 |
| Application Load Balancer | 18–25 |
| Fargate 0.5 vCPU / 1 GB, 24×7 | ~18 |
| Secrets Manager (3 secretos) | ~1.5 |
| KMS (1 llave) | ~1 |
| CloudWatch (logs, alarmas) | 3–10 |
| Route 53 (zona + chequeo de salud) | ~1.5–2 |
| SES (volumen mínimo) | < 1 |
| CloudTrail (primer *trail* de eventos de administración) | ~0 |
| Dominio (anual, aparte) | ~12–15 al año |
| **Total aproximado** | **~60–90** |

Si se cierra el RDS actual, parte de este gasto se compensa. Crear un **AWS Budget** de la cuenta `psycrm-prod` con alerta al 80 % y al 100 % de, por ejemplo, USD 100/mes.

---

## 6. Seguridad: resumen de controles

- Datos cifrados en reposo (RDS, ECR, logs, secretos) con KMS y en tránsito (TLS 1.2+ en el ALB, SSL verificado hacia RDS).
- RDS sin acceso público y con grupo de seguridad restringido al servidor.
- Ninguna llave de acceso permanente: SSO con MFA para humanos y roles para el resto.
- Secretos fuera del código y de la definición de tarea.
- Imagen no root, sistema de archivos de solo lectura, escaneo de vulnerabilidades en ECR.
- CloudTrail activo; alarmas de salud y de costo.
- Backups de 30 días con restauración a un punto en el tiempo, **probada** antes de salir a producción (día 8).
- Acuerdo HIPAA (BAA) de AWS aceptado para la organización.

---

## 7. Decisiones pendientes

| # | Decisión | Cuándo hace falta |
|---|---|---|
| 1 | **Dominio** (nombre y dónde se registra; recomendado: Route 53 por simplicidad) | Antes del primer cliente real |
| 2 | ¿Reusar el RDS viejo o crear uno nuevo? Recomendado: **nuevo** (ver tarea 3.1) | Antes de la fase 3 |
| 3 | Correo del administrador de la cuenta hija y de las alarmas | Fase 1 |
| 4 | Si se activa GuardDuty | Fase 5 |
| 5 | Si se quiere una segunda cuenta de pruebas | Después del MVP |

---

## 8. Tareas

Leyenda: **[Tú]** = acción en la consola o la cuenta de AWS (requiere ser dueño/administrador) · **[Claude]** = código o documentación en el repositorio · **[Ambos]** = se coordina. Las fases 1–5 son infraestructura; la 6 conecta la aplicación.

### Fase 1: cuenta y organización  (≈ 1–2 h)
- [ ] **1.1 [Tú]** Entrar a la cuenta administradora de AWS Organizations (o activarla si no existe: *AWS Organizations → Create organization*, con todas las funciones habilitadas).
- [ ] **1.2 [Tú]** Crear la cuenta hija: *Add an AWS account → Create* con el nombre `psycrm-prod` y un correo único (un alias, p. ej. `aws+psycrm@<correo>`). Dejar el rol de acceso por defecto `OrganizationAccountAccessRole`.
- [ ] **1.3 [Tú]** Aceptar el **BAA de AWS** en *AWS Artifact → Agreements*. Preferible el acuerdo **de la organización** (cubre las cuentas hijas); si solo ofrece el de cuenta, aceptarlo también dentro de `psycrm-prod`. Descargar el PDF firmado y guardarlo fuera del repositorio.
- [ ] **1.4 [Tú]** Abrir la lista oficial *AWS HIPAA Eligible Services* y confirmar que estén incluidos: VPC, EC2 (red), ECS, Fargate, ECR, Elastic Load Balancing, ACM, Route 53, RDS, KMS, Secrets Manager, SES, CloudWatch, CloudTrail, SNS, IAM/Identity Center, GuardDuty. Anotar fecha y resultado. **Si alguno no está, parar y avisarme.**
- [ ] **1.5 [Tú]** En `psycrm-prod`: asegurar la cuenta raíz (contraseña larga y MFA, sin llaves de acceso).
- [ ] **1.6 [Tú]** Activar **IAM Identity Center** (en la cuenta administradora), crear tu usuario con MFA y asignarle acceso administrador a `psycrm-prod`. Configurar el perfil de la CLI (`aws configure sso`).
- [ ] **1.7 [Tú]** Crear el **AWS Budget** de `psycrm-prod` (USD 100/mes, alertas 80 % y 100 %) y activar *Cost Anomaly Detection*.
- [ ] **1.8 [Tú]** Elegir la región `us-east-1` y trabajar solo en ella. Opcional: una política de control de servicios (SCP) de la organización que impida usar otras regiones en `psycrm-prod`.

### Fase 2: auditoría y base de la cuenta  (≈ 1 h)
- [ ] **2.1 [Tú]** Activar CloudTrail: preferiblemente un *trail* de la organización con su bucket S3 cifrado y sin acceso público. Si no, uno en `psycrm-prod`.
- [ ] **2.2 [Tú]** Crear la llave KMS `alias/psycrm-data` (simétrica, rotación anual). Administradores: tu rol de SSO. Uso: RDS, Secrets Manager, ECR y CloudWatch Logs.
- [ ] **2.3 [Tú]** Crear el tema SNS `psycrm-alerts` y suscribir los correos de la terapeuta y del administrador (confirmar las suscripciones).
- [ ] **2.4 [Opcional, Tú]** Activar GuardDuty en `psycrm-prod`.

### Fase 3: red y base de datos  (≈ 2 h)
- [ ] **3.1 [Tú]** Decidir RDS nuevo vs. viejo. **Recomendación: nuevo.** Solo se reutiliza el viejo si ya está cifrado, es privado, es PostgreSQL 16+, tiene 30 días de backups, y nadie más lo usa. Si el RDS actual está en la cuenta administradora, **no se puede mover** a `psycrm-prod` directamente (habría que restaurarlo desde una instantánea compartida); por eso nuevo.
- [ ] **3.2 [Tú]** Crear la VPC con 2 subredes públicas y 2 privadas, el Internet Gateway, las tablas de rutas y los *flow logs* (§3.1). La opción del asistente "VPC and more" lo hace de una vez (elegir **0 NAT gateways**).
- [ ] **3.3 [Tú]** Crear los grupos de seguridad (§3.2).
- [ ] **3.4 [Tú]** Crear el grupo de parámetros de RDS (`rds.force_ssl=1`, `log_min_duration_statement`).
- [ ] **3.5 [Tú]** Crear la instancia RDS (§3.3): cifrado con `psycrm-data`, privada, 30 días de backups, protección contra borrado, logs a CloudWatch. Usuario maestro con contraseña generada y guardada en Secrets Manager.
- [ ] **3.6 [Ambos]** Crear la base `psycrm` y los roles `psycrm_migrator` y `psycrm_app`. Yo escribo el SQL (`db/roles.sql`); tú lo ejecutas una vez con una tarea de ECS o un túnel SSM temporal (la base no es pública).
- [ ] **3.7 [Tú]** Crear los secretos (§3.7): `database-url` (con `psycrm_app`), `session-secret` (generar con `openssl rand -base64 48`) y `chatwoot-webhook-secret`. Guardar también la URL del migrador en un secreto aparte (`psycrm/database-url-migrator`) que solo la tarea de migración puede leer.

### Fase 4: contenedor, servidor y entrada  (≈ 2–3 h)
- [x] **4.1 [Claude]** *(hecho en el día 1)* `Dockerfile` multi-stage para ARM64 con el certificado raíz de RDS, `.dockerignore`, y `server/index.ts` sirviendo `dist/` con fallback de la SPA. **Sin probar el build de la imagen aún** (hace falta Docker; se prueba en el primer despliegue).
- [ ] **4.2 [Tú]** Crear el repositorio ECR `psycrm-app` (§3.4).
- [ ] **4.3 [Tú]** Crear los roles IAM `psycrm-task-execution` y `psycrm-task` (§3.8).
- [ ] **4.4 [Tú]** Crear el clúster ECS, el grupo de logs `/psycrm/app` y las dos definiciones de tarea: `psycrm-app` (servidor) y `psycrm-migrate` (misma imagen, comando `npm run migrate`, usa el secreto del migrador).
- [ ] **4.5 [Tú]** Pedir el certificado de ACM. Con dominio: `app.<dominio>`, validación por DNS. **Sin dominio, se pospone** y el ALB se crea solo con el listener 80 (temporal, solo datos ficticios).
- [ ] **4.6 [Tú]** Crear el ALB, el grupo de destino (tipo IP, `/health`) y los listeners (§3.5).
- [ ] **4.7 [Tú]** Crear el servicio ECS `psycrm-app` (`desiredCount=1`, circuit breaker, asociado al ALB, en subredes públicas con IP pública, `SG-app`).
- [ ] **4.8 [Ambos]** Primer despliegue manual: construyo y subo la imagen (o la subes desde tu máquina), corres la tarea de migración y verificas `GET /health`.

### Fase 5: dominio, correo y alarmas  (≈ 1–2 h; el dominio puede esperar)
- [ ] **5.1 [Tú]** Registrar o transferir el dominio a Route 53 y crear la zona.
- [ ] **5.2 [Tú]** Pedir/validar el certificado de ACM, añadir el listener 443 al ALB (el 80 pasa a redirigir) y crear el registro `A` (alias) hacia el ALB.
- [ ] **5.3 [Tú]** SES: verificar el dominio (DKIM, SPF, MAIL FROM), crear el conjunto de configuración con eventos de rebote/queja y **solicitar acceso de producción**.
- [ ] **5.4 [Tú]** Crear las alarmas de CloudWatch (§3.9) hacia `psycrm-alerts` y el chequeo de salud de `/health`.
- [ ] **5.5 [Tú]** Probar la **restauración de un backup** de RDS a una instancia temporal, comprobar que arranca, y eliminarla (se repite en el día 8).

### Fase 6: CI/CD y conexión con la aplicación
- [ ] **6.1 [Tú]** Crear el proveedor OIDC de GitHub en IAM y el rol `psycrm-github-deploy` (§3.8), limitado al repositorio `marindanielj/PsyCRM` y la rama `main`.
- [ ] **6.2 [Claude]** Workflow de GitHub Actions (`.github/workflows/deploy.yml`): pruebas → imagen → ECR → tarea de migración → actualización del servicio (§4).
- [ ] **6.3 [Tú]** Configurar en GitHub el entorno `production` con aprobación manual.
- [x] **6.4 [Claude]** *(hecho en el día 1)* SSL verificado por la URL de la base y variables nuevas en `config.ts` (`PSYCRM_MODE`, `PUBLIC_BASE_URL`, `STATIC_DIR`). Falta `SES_FROM_ADDRESS` (día 6).
- [ ] **6.5 [Claude]** `lib/sending/ses-adapter.ts` y su registro en `lib/sending/resolve.ts` (día 6). Prueba de envío real a una dirección verificada.
- [ ] **6.6 [Ambos]** Ejecutar `npm run seed:practice` una vez en producción (tarea única) para crear la práctica, el usuario de la terapeuta y el pipeline (día 1).
- [ ] **6.7 [Ambos]** Cerrar o conservar el RDS viejo: **no apagarlo** hasta confirmar que no depende nada de él; entonces crear una instantánea final y eliminarlo.

### Antes del primer cliente real (se repite en el día 8)
- [ ] Dominio activo con HTTPS válido y SES fuera del sandbox.
- [ ] Restauración de backup probada y `audit/verify` en verde en la copia.
- [ ] Alarmas probadas (provocar una a propósito).
- [ ] Revisión de la lista HIPAA Eligible Services repetida (la lista cambia).
- [ ] Acceso a `psycrm-prod` revisado: solo el admin técnico, con MFA.

---

## 9. Orden recomendado y trabajo en paralelo

```
Semana 0 (ahora)   Fase 1 + 2 [Tú]   ║  Día 1 de código [Claude]: Dockerfile, sesión, módulos, seed
Semana 0-1         Fase 3 + 4 [Tú]   ║  Días 2–4 de código (auditoría y notas)
Semana 1           Fase 5 (dominio)  ║  Días 5–7 de código (documentos, firma, automatización)
Semana 1 (final)   Fase 6            ║  Día 8: prueba completa en producción
```
El código se desarrolla y se prueba en local (`npm run dev:local`, con PGlite) sin depender de AWS; la infraestructura solo bloquea el **despliegue**, no el desarrollo.
