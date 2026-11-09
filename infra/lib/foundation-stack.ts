import { Aws, CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib'
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as guardduty from 'aws-cdk-lib/aws-guardduty'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions'
import { Construct } from 'constructs'
import { NAMES, type Settings } from './settings'

/**
 * Everything the other stacks stand on: the encryption key, the alert topic, the
 * network, the security groups, the image repository, the account's audit trail,
 * the budget, and the role GitHub Actions deploys with. Nothing here holds data
 * that is hard to recreate except the audit-trail bucket and the ECR repository,
 * both of which are retained on delete.
 */
export class FoundationStack extends Construct {
  readonly key: kms.Key
  readonly topic: sns.Topic
  readonly vpc: ec2.Vpc
  readonly sgAlb: ec2.SecurityGroup
  readonly sgApp: ec2.SecurityGroup
  readonly sgDb: ec2.SecurityGroup
  readonly repo: ecr.Repository
  readonly appLogGroup: logs.LogGroup

  constructor(scope: Construct, id: string, readonly settings: Settings) {
    super(scope, id)

    // ---- KMS: one customer-managed key for RDS, Secrets Manager, ECR, logs and the alert topic
    this.key = new kms.Key(this, 'DataKey', {
      alias: NAMES.keyAlias,
      description: 'PsyCRM data key: RDS, Secrets Manager, ECR, CloudWatch Logs, SNS',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    })
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${Aws.REGION}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*` } },
      }),
    )
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublish',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com'), new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
      }),
    )

    // ---- alerts: therapist + admin. Each address must confirm the subscription email.
    this.topic = new sns.Topic(this, 'Alerts', { topicName: NAMES.topic, masterKey: this.key })
    for (const email of settings.alertEmails) this.topic.addSubscription(new subs.EmailSubscription(email))
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBudgetsToPublish',
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
      }),
    )

    // ---- network: 2 public subnets (ALB + tasks), 2 isolated subnets (RDS, no route to the internet), no NAT
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: false },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    })
    const flowLogs = new logs.LogGroup(this, 'FlowLogs', {
      logGroupName: '/psycrm/vpc-flow',
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: this.key,
      removalPolicy: RemovalPolicy.RETAIN,
    })
    this.vpc.addFlowLog('Flow', { destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogs), trafficType: ec2.FlowLogTrafficType.ALL })

    // ---- security groups: the only way in is internet → ALB → app → database
    this.sgAlb = new ec2.SecurityGroup(this, 'SgAlb', { vpc: this.vpc, description: 'ALB', allowAllOutbound: false })
    this.sgApp = new ec2.SecurityGroup(this, 'SgApp', { vpc: this.vpc, description: 'App and one-off tasks', allowAllOutbound: false })
    this.sgDb = new ec2.SecurityGroup(this, 'SgDb', { vpc: this.vpc, description: 'RDS', allowAllOutbound: false })
    this.sgAlb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS')
    this.sgAlb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP (redirects to HTTPS)')
    this.sgAlb.addEgressRule(this.sgApp, ec2.Port.tcp(8790), 'to the app')
    this.sgApp.addIngressRule(this.sgAlb, ec2.Port.tcp(8790), 'from the ALB only')
    this.sgApp.addEgressRule(this.sgDb, ec2.Port.tcp(5432), 'to the database')
    this.sgApp.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'ECR, Secrets Manager, SES, CloudWatch (no NAT)')
    this.sgDb.addIngressRule(this.sgApp, ec2.Port.tcp(5432), 'from the app and one-off tasks only')

    // ---- images: immutable tags, scan on push, encrypted, last 20 kept
    this.repo = new ecr.Repository(this, 'Repo', {
      repositoryName: NAMES.repo,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: this.key,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 20, description: 'keep the last 20 images' }],
    })

    this.appLogGroup = new logs.LogGroup(this, 'AppLogs', {
      logGroupName: NAMES.logGroup,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: this.key,
      removalPolicy: RemovalPolicy.RETAIN,
    })

    // ---- AWS-side audit: management events for the whole account (an organization trail can replace this later)
    const trailBucket = new s3.Bucket(this, 'TrailBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: Duration.days(2190), noncurrentVersionExpiration: Duration.days(90) }],
    })
    new cloudtrail.Trail(this, 'Trail', {
      trailName: 'psycrm-account-trail',
      bucket: trailBucket,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
    })

    if (settings.enableGuardDuty) new guardduty.CfnDetector(this, 'GuardDuty', { enable: true })

    // ---- spending: the budget lives in the management account, not here. AWS refuses to create
    // budgets inside a member account unless the payer enables it, so `psycrm-prod-monthly`
    // (80% / 100% of USD 100, filtered to this account) was created there.

    // ---- GitHub Actions deploys through OIDC: no access keys stored anywhere
    const oidc = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    })
    const deploy = new iam.Role(this, 'DeployRole', {
      roleName: NAMES.deployRole,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(oidc.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // GitHub's id-qualified subject, and the classic name form (only this repository, only this environment).
          'token.actions.githubusercontent.com:sub': (() => {
            const [owner = '', name = ''] = settings.githubRepo.split('/')
            return [
              `repo:${owner}@${settings.githubOwnerId}/${name}@${settings.githubRepoId}:environment:${settings.githubEnvironment}`,
              `repo:${settings.githubRepo}:environment:${settings.githubEnvironment}`,
            ]
          })(),
        },
      }),
    })
    const arn = (service: string, resource: string) => `arn:${Aws.PARTITION}:${service}:${Aws.REGION}:${Aws.ACCOUNT_ID}:${resource}`
    new CfnOutput(this, 'DeployRoleArn', { value: deploy.roleArn, description: 'GitHub repository variable AWS_DEPLOY_ROLE_ARN' })
    new CfnOutput(this, 'RepositoryUri', { value: this.repo.repositoryUri })
    this.repo.grantPullPush(deploy)
    deploy.addToPolicy(new iam.PolicyStatement({ actions: ['ecs:RegisterTaskDefinition', 'ecs:DescribeTaskDefinition'], resources: ['*'] }))
    deploy.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
        resources: [arn('ecs', `service/${NAMES.cluster}/${NAMES.service}`)],
      }),
    )
    deploy.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [arn('ecs', `task-definition/${NAMES.migrateFamily}:*`)],
        conditions: { ArnEquals: { 'ecs:cluster': arn('ecs', `cluster/${NAMES.cluster}`) } },
      }),
    )
    deploy.addToPolicy(
      new iam.PolicyStatement({ actions: ['ecs:DescribeTasks'], resources: [arn('ecs', `task/${NAMES.cluster}/*`)] }),
    )
    deploy.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [NAMES.execRole, NAMES.taskRole, NAMES.migrateExecRole, NAMES.migrateTaskRole].map((r) => `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/${r}`),
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    )
  }
}
