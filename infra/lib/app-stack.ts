import { Aws, Duration } from 'aws-cdk-lib'
import * as cw from 'aws-cdk-lib/aws-cloudwatch'
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import { Construct } from 'constructs'
import type { DataStack } from './data-stack'
import type { DomainConstruct } from './domain'
import type { FoundationStack } from './foundation-stack'
import { NAMES, type Settings } from './settings'

const PORT = 8790

/** The public service: the ALB, the Fargate task, and the alarms. Needs a domain and its certificate. */
export class AppStack extends Construct {
  constructor(scope: Construct, id: string, foundation: FoundationStack, data: DataStack, settings: Settings, domain?: DomainConstruct) {
    super(scope, id)
    const publicBaseUrl = settings.publicBaseUrl ?? domain?.publicBaseUrl
    const certificateArn = settings.certificateArn ?? domain?.certificate?.certificateArn
    const sesFromAddress = settings.sesFromAddress ?? domain?.fromAddress
    const sesConfigurationSet = settings.sesConfigurationSet ?? domain?.sesConfigurationSet.configurationSetName
    if (!publicBaseUrl?.startsWith('https://')) throw new Error('PsycrmApp needs -c publicBaseUrl=https://app.<domain> (the server refuses to start in production without it)')
    if (!certificateArn) throw new Error('PsycrmApp needs a certificate: -c enableCertificate=true (after delegating the domain) or -c certificateArn=<ACM certificate>')
    const { vpc, repo, sgAlb, sgApp, appLogGroup, topic } = foundation

    // ---- roles: the execution role starts the task; the task role is what the code itself may do
    const execRole = new iam.Role(this, 'ExecRole', { roleName: NAMES.execRole, assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') })
    repo.grantPull(execRole)
    appLogGroup.grantWrite(execRole)
    data.databaseUrl.grantRead(execRole)
    data.sessionSecret.grantRead(execRole)

    const taskRole = new iam.Role(this, 'TaskRole', { roleName: NAMES.taskRole, assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') })
    if (sesFromAddress) {
      const resources = [`arn:${Aws.PARTITION}:ses:${Aws.REGION}:${Aws.ACCOUNT_ID}:identity/${domain?.name ?? '*'}`]
      if (sesConfigurationSet) resources.push(`arn:${Aws.PARTITION}:ses:${Aws.REGION}:${Aws.ACCOUNT_ID}:configuration-set/${sesConfigurationSet}`)
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail'],
          resources,
          conditions: { StringEquals: { 'ses:FromAddress': sesFromAddress } },
        }),
      )
    }

    // ---- task: 0.5 vCPU / 1 GB, ARM64, non-root, read-only root filesystem with a scratch /tmp
    const task = new ecs.FargateTaskDefinition(this, 'Task', {
      family: NAMES.appFamily,
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: execRole,
      taskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    })
    task.addVolume({ name: 'tmp' })
    const container = task.addContainer('app', {
      image: ecs.ContainerImage.fromEcrRepository(repo, settings.imageTag),
      readonlyRootFilesystem: true,
      user: 'node',
      logging: ecs.LogDrivers.awsLogs({ logGroup: appLogGroup, streamPrefix: 'app' }),
      portMappings: [{ containerPort: PORT }],
      environment: {
        NODE_ENV: 'production',
        PORT: String(PORT),
        ENABLED_INTEGRATIONS: 'calendar_sync', // only calendar_sync (no BAA needed: only time blocks cross, never client data); every other one needs a signed BAA first (docs/psycrm/INTEGRACIONES.md)
        AWS_REGION: settings.region,
        PGBOSS_CREATE_SCHEMA: 'false', // db/roles.sql created the schema; the app's role may not create schemas
        PUBLIC_BASE_URL: publicBaseUrl,
        ...(sesFromAddress ? { SES_FROM_ADDRESS: sesFromAddress, SES_REGION: settings.region } : {}),
        ...(sesConfigurationSet ? { SES_CONFIGURATION_SET: sesConfigurationSet } : {}),
      },
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(data.databaseUrl),
        SESSION_SECRET: ecs.Secret.fromSecretsManager(data.sessionSecret),
      },
      healthCheck: {
        command: ['CMD-SHELL', `node -e "fetch('http://127.0.0.1:${PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
    })
    container.addMountPoints({ containerPath: '/tmp', sourceVolume: 'tmp', readOnly: false })

    // ---- ALB: 443 with the certificate, 80 redirects to it
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: sgAlb,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
      deletionProtection: true,
    })
    const service = new ecs.FargateService(this, 'Service', {
      serviceName: NAMES.service,
      cluster: data.cluster,
      taskDefinition: task,
      desiredCount: settings.desiredCount,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
      securityGroups: [sgApp],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true, // no NAT: the task reaches ECR, Secrets Manager, SES and CloudWatch directly
      healthCheckGracePeriod: Duration.seconds(60),
    })
    const https = alb.addListener('Https', {
      port: 443,
      certificates: [acm.Certificate.fromCertificateArn(this, 'Cert', certificateArn)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      open: false,
    })
    const tg = https.addTargets('App', {
      port: PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(30) },
      deregistrationDelay: Duration.seconds(30),
    })
    alb.addListener('Http', {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
    })

    if (domain) new route53.ARecord(this, 'AppRecord', { zone: domain.zone, target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)) })

    // ---- alarms → SNS → the therapist and the admin
    const action = new cwActions.SnsAction(topic)
    const alarm = (id: string, a: cw.Alarm) => {
      a.addAlarmAction(action)
      a.addOkAction(action)
      return a
    }
    alarm('NoHealthyHosts', new cw.Alarm(this, 'NoHealthyHosts', {
      alarmName: 'psycrm-no-healthy-hosts',
      alarmDescription: 'The app has no healthy task behind the load balancer (down, or restarting)',
      metric: tg.metrics.healthyHostCount({ statistic: 'Minimum', period: Duration.minutes(1) }),
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 3,
      treatMissingData: cw.TreatMissingData.BREACHING,
    }))
    alarm('Alb5xx', new cw.Alarm(this, 'Alb5xx', {
      alarmName: 'psycrm-alb-5xx',
      alarmDescription: 'The app is answering with server errors',
      metric: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { statistic: 'Sum', period: Duration.minutes(5) }),
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    }))
    alarm('RdsCpu', new cw.Alarm(this, 'RdsCpu', {
      alarmName: 'psycrm-rds-cpu',
      alarmDescription: 'Database CPU above 80% for 15 minutes',
      metric: data.db.metricCPUUtilization({ period: Duration.minutes(5) }),
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 80,
      evaluationPeriods: 3,
    }))
    alarm('RdsStorage', new cw.Alarm(this, 'RdsStorage', {
      alarmName: 'psycrm-rds-free-storage',
      alarmDescription: 'Database has under 4 GB free (20% of the starting disk)',
      metric: data.db.metricFreeStorageSpace({ period: Duration.minutes(5) }),
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: 4 * 1024 ** 3,
      evaluationPeriods: 1,
    }))
    alarm('RdsConnections', new cw.Alarm(this, 'RdsConnections', {
      alarmName: 'psycrm-rds-connections',
      alarmDescription: 'Unusually many database connections',
      metric: data.db.metricDatabaseConnections({ period: Duration.minutes(5) }),
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 60,
      evaluationPeriods: 2,
    }))
    const sesRate = (name: string, metricName: string, threshold: number) =>
      alarm(name, new cw.Alarm(this, name, {
        alarmName: `psycrm-ses-${metricName.toLowerCase()}`,
        alarmDescription: `SES ${metricName} is high: AWS can pause sending above 10% bounces or 0.5% complaints`,
        metric: new cw.Metric({ namespace: 'AWS/SES', metricName, statistic: 'Maximum', period: Duration.hours(1) }),
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        threshold,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }))
    sesRate('SesBounce', 'Reputation.BounceRate', 0.05)
    sesRate('SesComplaint', 'Reputation.ComplaintRate', 0.001)
  }
}
