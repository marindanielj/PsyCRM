import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CfnOutput, Duration, Fn, RemovalPolicy, SecretValue } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import type { FoundationStack } from './foundation-stack'
import { NAMES, type Settings } from './settings'

const DB_NAME = 'psycrm'
const CA_BUNDLE = '/app/certs/rds-global-bundle.pem'

/**
 * The database, its secrets, and the two one-off tasks that prepare and migrate it.
 * None of this needs a domain, so it can be deployed first.
 */
export class DataStack extends Construct {
  readonly db: rds.DatabaseInstance
  readonly cluster: ecs.Cluster
  readonly databaseUrl: secretsmanager.Secret
  readonly sessionSecret: secretsmanager.Secret
  readonly migratorUrl: secretsmanager.Secret

  constructor(scope: Construct, id: string, foundation: FoundationStack, readonly settings: Settings) {
    super(scope, id)
    const { vpc, key, repo, sgDb } = foundation

    // ---- RDS PostgreSQL 16: private, encrypted, 30 days of backups, protected from deletion
    const params = new rds.ParameterGroup(this, 'Params', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      description: 'PsyCRM: force SSL, log slow queries (never log statements: they would carry PHI)',
      parameters: { 'rds.force_ssl': '1', log_min_duration_statement: '2000' },
    })
    this.db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [sgDb],
      publiclyAccessible: false,
      multiAz: false,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      storageEncryptionKey: key,
      databaseName: DB_NAME,
      credentials: rds.Credentials.fromGeneratedSecret('psycrm_admin', { secretName: 'psycrm/db-master', encryptionKey: key, excludeCharacters: '"@/\\\'%:?#[]' }),
      backupRetention: Duration.days(30),
      deleteAutomatedBackups: false,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      autoMinorVersionUpgrade: true,
      preferredBackupWindow: '06:00-07:00', // 02:00–03:00 in Puerto Rico
      preferredMaintenanceWindow: 'sun:07:30-sun:08:30', // Sunday 03:30–04:30 in Puerto Rico
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
      cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS,
      parameterGroup: params,
      enablePerformanceInsights: false,
      copyTagsToSnapshot: true,
    })
    const master = this.db.secret
    if (!master) throw new Error('RDS master secret missing')

    // ---- secrets: passwords are generated here and never typed by anyone
    const password = (id: string, name: string, username: string) =>
      new secretsmanager.Secret(this, id, {
        secretName: name,
        encryptionKey: key,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username }),
          generateStringKey: 'password',
          passwordLength: 40,
          excludePunctuation: true, // the password goes inside a URL
        },
      })
    const appPw = password('AppPassword', 'psycrm/db-app-password', 'psycrm_app')
    const migPw = password('MigratorPassword', 'psycrm/db-migrator-password', 'psycrm_migrator')

    const url = (id: string, name: string, user: string, pw: secretsmanager.Secret) =>
      new secretsmanager.Secret(this, id, {
        secretName: name,
        encryptionKey: key,
        secretStringValue: SecretValue.unsafePlainText(
          Fn.join('', [
            `postgres://${user}:`,
            pw.secretValueFromJson('password').unsafeUnwrap(),
            '@',
            this.db.dbInstanceEndpointAddress,
            ':',
            this.db.dbInstanceEndpointPort,
            `/${DB_NAME}?sslmode=verify-full&sslrootcert=${CA_BUNDLE}`,
          ]),
        ),
      })
    this.databaseUrl = url('DatabaseUrl', 'psycrm/database-url', 'psycrm_app', appPw)
    this.migratorUrl = url('MigratorUrl', 'psycrm/database-url-migrator', 'psycrm_migrator', migPw)
    this.sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      secretName: 'psycrm/session-secret',
      encryptionKey: key,
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    })

    new CfnOutput(this, 'DbEndpoint', { value: this.db.dbInstanceEndpointAddress })
    new CfnOutput(this, 'DbMasterSecretArn', { value: master.secretArn, description: 'RDS master credentials (psycrm_admin): break-glass only' })

    // ---- cluster and one-off tasks (they run in the public subnets, like the app, with no inbound access)
    this.cluster = new ecs.Cluster(this, 'Cluster', { clusterName: NAMES.cluster, vpc })

    const execRole = (id: string, roleName: string) =>
      new iam.Role(this, id, { roleName, assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') })

    // psycrm-bootstrap: runs db/roles.sql once as the master user, from the public postgres image.
    const bootstrapExec = execRole('BootstrapExec', NAMES.bootstrapExecRole)
    const bootstrap = new ecs.FargateTaskDefinition(this, 'BootstrapTask', {
      family: NAMES.bootstrapFamily,
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: bootstrapExec,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    })
    const rolesSql = readFileSync(join(__dirname, '..', '..', 'db', 'roles.sql'), 'utf8')
    bootstrap.addContainer('psql', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/postgres:16'),
      readonlyRootFilesystem: false,
      logging: ecs.LogDrivers.awsLogs({ logGroup: foundation.appLogGroup, streamPrefix: 'bootstrap' }),
      environment: { PGHOST: this.db.dbInstanceEndpointAddress, PGPORT: this.db.dbInstanceEndpointPort, PGDATABASE: DB_NAME, PGSSLMODE: 'require' },
      secrets: {
        PGUSER: ecs.Secret.fromSecretsManager(master, 'username'),
        PGPASSWORD: ecs.Secret.fromSecretsManager(master, 'password'),
        APP_PW: ecs.Secret.fromSecretsManager(appPw, 'password'),
        MIG_PW: ecs.Secret.fromSecretsManager(migPw, 'password'),
      },
      entryPoint: ['sh', '-c'],
      command: [`psql -v ON_ERROR_STOP=1 -v app_pw="$APP_PW" -v mig_pw="$MIG_PW" <<'PSYCRM_SQL'\n${rolesSql}\nPSYCRM_SQL`],
    })
    for (const s of [master, appPw, migPw]) s.grantRead(bootstrapExec)
    foundation.appLogGroup.grantWrite(bootstrapExec)

    // psycrm-migrate: the app image, connecting as the schema owner. Command is overridden per run
    // (`npm run migrate`, `npm run seed:practice`).
    const migrateExec = execRole('MigrateExec', NAMES.migrateExecRole)
    const migrate = new ecs.FargateTaskDefinition(this, 'MigrateTask', {
      family: NAMES.migrateFamily,
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: migrateExec,
      taskRole: new iam.Role(this, 'MigrateTaskRole', { roleName: NAMES.migrateTaskRole, assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') }), // no permissions at all
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    })
    migrate.addVolume({ name: 'tmp' })
    const migrateContainer = migrate.addContainer('migrate', {
      image: ecs.ContainerImage.fromEcrRepository(repo, settings.imageTag),
      readonlyRootFilesystem: true,
      user: 'node',
      logging: ecs.LogDrivers.awsLogs({ logGroup: foundation.appLogGroup, streamPrefix: 'migrate' }),
      environment: { NODE_ENV: 'production', AWS_REGION: settings.region },
      secrets: { DATABASE_URL: ecs.Secret.fromSecretsManager(this.migratorUrl) },
      command: ['npm', 'run', 'migrate'],
    })
    migrateContainer.addMountPoints({ containerPath: '/tmp', sourceVolume: 'tmp', readOnly: false })
    this.migratorUrl.grantRead(migrateExec)
    repo.grantPull(migrateExec)
    foundation.appLogGroup.grantWrite(migrateExec)
  }
}
