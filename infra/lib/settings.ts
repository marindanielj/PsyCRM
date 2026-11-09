import type { App } from 'aws-cdk-lib'

/** Everything that differs between deployments, read from `cdk.json` context or `-c key=value`. */
export interface Settings {
  region: string
  /** Emails that receive alarms and budget alerts (the therapist and the technical admin). */
  alertEmails: string[]
  /** Monthly budget alert in USD. */
  budgetUsd: number
  /** GitHub repository allowed to deploy (OIDC), as owner/name. */
  githubRepo: string
  /** GitHub environment whose jobs may assume the deploy role. */
  githubEnvironment: string
  /** Turn on GuardDuty (decision #4 in INFRA_AWS.md, off until decided). */
  enableGuardDuty: boolean
  /** ECR image tag the app and migration tasks run. */
  imageTag: string
  /** 0 until the first image is pushed; then 1. */
  desiredCount: number
  /** https:// address of the app (needs a domain). Required to synthesize PsycrmApp. */
  publicBaseUrl?: string
  /** ACM certificate for the ALB's 443 listener. Required with publicBaseUrl. */
  certificateArn?: string
  /** Verified SES sender, e.g. no-reply@example.com. The task role may send only as this address. */
  sesFromAddress?: string
  sesConfigurationSet?: string
}

const str = (app: App, k: string): string | undefined => {
  const v = app.node.tryGetContext(k)
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
const bool = (app: App, k: string, d: boolean): boolean => {
  const v = app.node.tryGetContext(k)
  return v === undefined ? d : v === true || v === 'true'
}
const num = (app: App, k: string, d: number): number => {
  const v = Number(app.node.tryGetContext(k))
  return Number.isFinite(v) && app.node.tryGetContext(k) !== undefined ? v : d
}

export function readSettings(app: App): Settings {
  const emails = str(app, 'alertEmails')
  return {
    region: 'us-east-1',
    alertEmails: emails ? emails.split(',').map((e) => e.trim()).filter(Boolean) : [],
    budgetUsd: num(app, 'budgetUsd', 100),
    githubRepo: str(app, 'githubRepo') ?? 'marindanielj/PsyCRM',
    githubEnvironment: str(app, 'githubEnvironment') ?? 'production',
    enableGuardDuty: bool(app, 'enableGuardDuty', false),
    imageTag: str(app, 'imageTag') ?? 'bootstrap',
    desiredCount: num(app, 'desiredCount', 0),
    publicBaseUrl: str(app, 'publicBaseUrl'),
    certificateArn: str(app, 'certificateArn'),
    sesFromAddress: str(app, 'sesFromAddress'),
    sesConfigurationSet: str(app, 'sesConfigurationSet'),
  }
}

/** Fixed names. The deploy role refers to them by ARN, so they must not drift. */
export const NAMES = {
  cluster: 'psycrm',
  service: 'psycrm-app',
  repo: 'psycrm-app',
  logGroup: '/psycrm/app',
  appFamily: 'psycrm-app',
  migrateFamily: 'psycrm-migrate',
  bootstrapFamily: 'psycrm-bootstrap',
  execRole: 'psycrm-task-execution',
  taskRole: 'psycrm-task',
  migrateExecRole: 'psycrm-migrate-execution',
  migrateTaskRole: 'psycrm-migrate-task',
  bootstrapExecRole: 'psycrm-bootstrap-execution',
  deployRole: 'psycrm-github-deploy',
  keyAlias: 'alias/psycrm-data',
  topic: 'psycrm-alerts',
} as const
