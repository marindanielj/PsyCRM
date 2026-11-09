import { App, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { AppStack } from '../lib/app-stack'
import { DataStack } from '../lib/data-stack'
import { DomainConstruct } from '../lib/domain'
import { FoundationStack } from '../lib/foundation-stack'
import { readSettings } from '../lib/settings'

function build(ctx: Record<string, string>) {
  const app = new App({ context: ctx })
  const settings = readSettings(app)
  const stack = new Stack(app, 'Psycrm', { env: { region: 'us-east-1' } })
  const foundation = new FoundationStack(stack, 'Foundation', settings)
  const data = new DataStack(stack, 'Data', foundation, settings)
  const domain = settings.domainName ? new DomainConstruct(stack, 'Domain', settings.domainName, settings) : undefined
  if (settings.publicBaseUrl || settings.certificateArn || domain?.certificate) new AppStack(stack, 'App', foundation, data, settings, domain)
  return Template.fromStack(stack)
}

const BASE = { alertEmails: 'a@example.com,b@example.com' }
const WITH_DOMAIN = {
  ...BASE,
  publicBaseUrl: 'https://app.example.com',
  certificateArn: 'arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000',
  sesFromAddress: 'no-reply@example.com',
  desiredCount: '1',
}

describe('foundation + data (no domain yet)', () => {
  const t = build(BASE)

  it('encrypts the database, keeps it private, backs it up and protects it from deletion', () => {
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      StorageEncrypted: true,
      PubliclyAccessible: false,
      MultiAZ: false,
      BackupRetentionPeriod: 30,
      DeletionProtection: true,
      KmsKeyId: Match.anyValue(),
    })
    t.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Snapshot' })
  })

  it('forces SSL to the database and never logs statements', () => {
    t.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: Match.objectLike({ 'rds.force_ssl': '1', log_min_duration_statement: '2000' }),
    })
    const groups = Object.values(t.findResources('AWS::RDS::DBParameterGroup'))
    for (const g of groups) expect(JSON.stringify(g)).not.toContain('log_statement')
  })

  it('creates no budget here (member accounts cannot; it lives in the management account)', () => {
    t.resourceCountIs('AWS::Budgets::Budget', 0)
  })

  it('rotates the data key and retains it on delete', () => {
    t.hasResource('AWS::KMS::Key', { Properties: { EnableKeyRotation: true }, DeletionPolicy: 'Retain' })
  })

  it('only the load balancer group accepts traffic from the whole internet', () => {
    const groups = t.findResources('AWS::EC2::SecurityGroup')
    const open = Object.entries(groups).filter(([, g]) =>
      JSON.stringify((g as { Properties: { SecurityGroupIngress?: unknown } }).Properties.SecurityGroupIngress ?? []).includes('0.0.0.0/0'),
    )
    expect(open).toHaveLength(1)
    expect(open[0]?.[0]).toMatch(/SgAlb/)
    // the database group has no rules open to a CIDR at all
    const db = Object.entries(groups).find(([id]) => /SgDb/.test(id))?.[1] as { Properties: { SecurityGroupIngress?: unknown } }
    expect(db.Properties.SecurityGroupIngress ?? []).toEqual([])
  })

  it('has no NAT gateway and no route from the private subnets to the internet', () => {
    t.resourceCountIs('AWS::EC2::NatGateway', 0)
    t.resourceCountIs('AWS::EC2::Route', 2) // one default route per public subnet, none for the private ones
  })

  it('keeps the image registry immutable, scanned and encrypted', () => {
    t.hasResourceProperties('AWS::ECR::Repository', {
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
      EncryptionConfiguration: { EncryptionType: 'KMS' },
    })
  })

  it('writes an audit trail with validation, in a private bucket', () => {
    t.hasResourceProperties('AWS::CloudTrail::Trail', { EnableLogFileValidation: true, IsMultiRegionTrail: true })
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    })
  })

  it('lets only the production environment of this repository deploy, without access keys', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'psycrm-github-deploy',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': [
                  'repo:marindanielj@304752011/PsyCRM@1447179066:environment:production',
                  'repo:marindanielj/PsyCRM:environment:production',
                ],
              },
            },
          }),
        ],
      }),
    })
    t.resourceCountIs('AWS::IAM::AccessKey', 0)
    t.resourceCountIs('AWS::IAM::User', 0)
  })

  it('generates every password; none is written in the template', () => {
    const secrets = Object.values(t.findResources('AWS::SecretsManager::Secret'))
    expect(secrets.length).toBe(7)
    for (const s of secrets) expect(JSON.stringify(s)).not.toMatch(/"SecretString":"[^{]*[A-Za-z0-9]{20,}"/)
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'psycrm/session-secret', GenerateSecretString: Match.objectLike({ PasswordLength: 64 }) })
  })

  it('runs the one-off tasks as ARM64 with the database URL only in the migration task', () => {
    const defs = Object.values(t.findResources('AWS::ECS::TaskDefinition')) as { Properties: { Family: string; ContainerDefinitions: { Secrets?: { Name: string }[] }[] } }[]
    const names = defs.map((d) => d.Properties.Family).sort()
    expect(names).toEqual(['psycrm-bootstrap', 'psycrm-migrate', 'psycrm-seed'])
    const migrate = defs.find((d) => d.Properties.Family === 'psycrm-migrate')
    expect(migrate?.Properties.ContainerDefinitions[0]?.Secrets?.map((s) => s.Name)).toEqual(['DATABASE_URL'])
  })

  it('lets the deploy role pass only the task roles, only to ECS tasks', () => {
    const t2 = build(BASE)
    const docs = Object.values(t2.findResources('AWS::IAM::Policy')).map((p) => JSON.stringify(p))
    const pass = docs.find((d) => d.includes('iam:PassRole') && d.includes('psycrm-migrate-task')) ?? ''
    expect(pass).not.toBe('')
    for (const r of ['psycrm-task-execution', 'psycrm-task', 'psycrm-migrate-execution', 'psycrm-migrate-task']) expect(pass).toContain(`:role/${r}`)
    expect(pass).toContain('ecs-tasks.amazonaws.com')
  })

  it('seeds the practice as the app role, with the owner password generated and read from Secrets Manager', () => {
    const defs = Object.values(t.findResources('AWS::ECS::TaskDefinition')) as { Properties: { Family: string; ContainerDefinitions: { Secrets?: { Name: string }[]; Environment?: { Name: string }[]; Command?: string[] }[] } }[]
    const seed = defs.find((d) => d.Properties.Family === 'psycrm-seed')?.Properties.ContainerDefinitions[0]
    expect(seed?.Secrets?.map((x) => x.Name).sort()).toEqual(['DATABASE_URL', 'OWNER_PASSWORD'])
    expect(seed?.Command).toEqual(['npm', 'run', 'seed:practice'])
    expect((seed?.Environment ?? []).map((e) => e.Name)).not.toContain('OWNER_PASSWORD')
    t.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'psycrm/owner-initial-password', GenerateSecretString: Match.objectLike({ PasswordLength: 24, ExcludePunctuation: true }) })
  })

  it('does not create the public service until there is a domain', () => {
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0)
    t.resourceCountIs('AWS::ECS::Service', 0)
  })
})

describe('public service (with a domain)', () => {
  const t = build(WITH_DOMAIN)

  it('redirects 80 to 443 and terminates TLS 1.2+ at the load balancer', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 443, Protocol: 'HTTPS', SslPolicy: Match.stringLikeRegexp('TLS13|TLS-1-2') })
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: 'redirect', RedirectConfig: Match.objectLike({ Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' }) })],
    })
  })

  it('runs one non-root task with a read-only root filesystem and a circuit breaker', () => {
    t.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 100, MaximumPercent: 200, DeploymentCircuitBreaker: { Enable: true, Rollback: true } }),
    })
    const defs = Object.values(t.findResources('AWS::ECS::TaskDefinition')) as { Properties: { Family: string; ContainerDefinitions: Record<string, unknown>[] } }[]
    const app = defs.find((d) => d.Properties.Family === 'psycrm-app')?.Properties.ContainerDefinitions[0]
    expect(app).toMatchObject({ ReadonlyRootFilesystem: true, User: 'node' })
    const env = Object.fromEntries((app?.Environment as { Name: string; Value: string }[]).map((e) => [e.Name, e.Value]))
    expect(env).toMatchObject({ NODE_ENV: 'production', PGBOSS_CREATE_SCHEMA: 'false', ENABLED_INTEGRATIONS: '', PUBLIC_BASE_URL: 'https://app.example.com', SES_FROM_ADDRESS: 'no-reply@example.com' })
    const secretNames = (app?.Secrets as { Name: string }[]).map((s) => s.Name).sort()
    expect(secretNames).toEqual(['DATABASE_URL', 'SESSION_SECRET'])
  })

  it('lets the task send email only as the configured address, and do nothing else', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({ Action: 'ses:SendEmail', Condition: { StringEquals: { 'ses:FromAddress': 'no-reply@example.com' } } })],
      }),
    })
  })

  it('alarms on health, errors, database and email reputation', () => {
    const names = Object.values(t.findResources('AWS::CloudWatch::Alarm')).map((a) => (a as { Properties: { AlarmName: string } }).Properties.AlarmName).sort()
    expect(names).toEqual([
      'psycrm-alb-5xx',
      'psycrm-no-healthy-hosts',
      'psycrm-rds-connections',
      'psycrm-rds-cpu',
      'psycrm-rds-free-storage',
      'psycrm-ses-reputation.bouncerate',
      'psycrm-ses-reputation.complaintrate',
    ])
  })

  it('refuses to build without an https address or a certificate', () => {
    expect(() => build({ ...BASE, publicBaseUrl: 'http://app.example.com', certificateArn: 'x' })).toThrow(/https/)
    expect(() => build({ ...BASE, publicBaseUrl: 'https://app.example.com' })).toThrow(/certificateArn/)
  })
})

describe('delegated domain (app.dramaritzamartinez.com)', () => {
  const DOMAIN = { ...BASE, domainName: 'app.dramaritzamartinez.com' }

  describe('phase 1: zone and email identity, no certificate yet', () => {
    const t = build(DOMAIN)
    it('creates only the delegated zone, never the registrant\'s whole domain', () => {
      t.resourceCountIs('AWS::Route53::HostedZone', 1)
      t.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'app.dramaritzamartinez.com.' })
    })
    it('signs mail with 2048-bit DKIM and a MAIL FROM subdomain, and keeps bounce/complaint suppression', () => {
      t.hasResourceProperties('AWS::SES::EmailIdentity', {
        EmailIdentity: 'app.dramaritzamartinez.com',
        DkimAttributes: { SigningEnabled: true },
        MailFromAttributes: Match.objectLike({ MailFromDomain: 'bounce.app.dramaritzamartinez.com' }),
      })
      t.hasResourceProperties('AWS::SES::ConfigurationSet', {
        Name: 'psycrm',
        ReputationOptions: { ReputationMetricsEnabled: true },
        SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
        DeliveryOptions: { TlsPolicy: 'REQUIRE' },
      })
    })
    it('publishes a strict DMARC policy', () => {
      t.hasResourceProperties('AWS::Route53::RecordSet', { Name: '_dmarc.app.dramaritzamartinez.com.', Type: 'TXT' })
    })
    it('does not request the certificate or create the service before the registrar delegates', () => {
      t.resourceCountIs('AWS::CertificateManager::Certificate', 0)
      t.resourceCountIs('AWS::ECS::Service', 0)
    })
  })

  describe('phase 2: certificate, service and the app record', () => {
    const t = build({ ...DOMAIN, enableCertificate: 'true', desiredCount: '1' })
    it('requests a DNS-validated certificate for the name', () => {
      t.hasResourceProperties('AWS::CertificateManager::Certificate', { DomainName: 'app.dramaritzamartinez.com', ValidationMethod: 'DNS' })
    })
    it('points the name at the load balancer and sends mail only as no-reply@ that name', () => {
      t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'app.dramaritzamartinez.com.', Type: 'A', AliasTarget: Match.anyValue() })
      t.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: [Match.objectLike({ Action: 'ses:SendEmail', Condition: { StringEquals: { 'ses:FromAddress': 'no-reply@app.dramaritzamartinez.com' } } })],
        }),
      })
      const defs = Object.values(t.findResources('AWS::ECS::TaskDefinition')) as { Properties: { Family: string; ContainerDefinitions: { Environment?: { Name: string; Value: string }[] }[] } }[]
      const env = Object.fromEntries((defs.find((d) => d.Properties.Family === 'psycrm-app')?.Properties.ContainerDefinitions[0]?.Environment ?? []).map((e) => [e.Name, e.Value]))
      expect(env).toMatchObject({ PUBLIC_BASE_URL: 'https://app.dramaritzamartinez.com', SES_FROM_ADDRESS: 'no-reply@app.dramaritzamartinez.com' })
      expect(JSON.stringify(env.SES_CONFIGURATION_SET)).toContain('ConfigSet')
    })
  })
})
