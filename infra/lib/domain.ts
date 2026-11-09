import { CfnOutput, Duration, Fn } from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as ses from 'aws-cdk-lib/aws-ses'
import { Construct } from 'constructs'
import type { Settings } from './settings'

/**
 * DNS, certificate and email identity for one delegated domain, e.g. `app.dramaritzamartinez.com`.
 *
 * Only this name is delegated to Route 53 (two NS records at the registrar); the rest of the
 * registrant's domain, website included, stays where it is.
 *
 * Two phases, because the certificate can only validate after the delegation exists:
 *   1. deploy with `-c domainName=…`: zone + SES identity. Read the ZoneNameServers output and
 *      add them as NS records at the registrar.
 *   2. deploy again with `-c enableCertificate=true`: certificate (validated through the zone).
 */
export class DomainConstruct extends Construct {
  readonly zone: route53.PublicHostedZone
  readonly certificate?: acm.Certificate
  readonly sesConfigurationSet: ses.ConfigurationSet
  readonly fromAddress: string
  readonly publicBaseUrl: string

  constructor(scope: Construct, id: string, readonly name: string, settings: Settings) {
    super(scope, id)
    this.fromAddress = settings.sesFromAddress ?? `no-reply@${name}`
    this.publicBaseUrl = `https://${name}`

    this.zone = new route53.PublicHostedZone(this, 'Zone', { zoneName: name, comment: 'PsyCRM: delegated from the registrar' })
    new CfnOutput(this, 'ZoneNameServers', {
      value: Fn.join(' ', this.zone.hostedZoneNameServers ?? []),
      description: `Add these as NS records for ${name} at the registrar`,
    })

    // One configuration set: reputation metrics (the alarms read them) and a suppression list for bounces and complaints.
    this.sesConfigurationSet = new ses.ConfigurationSet(this, 'ConfigSet', {
      configurationSetName: 'psycrm',
      reputationMetrics: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
    })

    // Sending identity for the whole delegated name: 2048-bit DKIM, and a MAIL FROM subdomain so SPF aligns.
    new ses.EmailIdentity(this, 'Identity', {
      identity: ses.Identity.publicHostedZone(this.zone),
      configurationSet: this.sesConfigurationSet,
      dkimSigning: true,
      mailFromDomain: `bounce.${name}`,
      mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
    })

    // Everything sent from this name is signed by SES, so a strict policy is safe.
    new route53.TxtRecord(this, 'Dmarc', {
      zone: this.zone,
      recordName: `_dmarc.${name}`,
      values: ['v=DMARC1; p=quarantine; adkim=s; aspf=s'],
      ttl: Duration.hours(1),
    })

    if (settings.enableCertificate) {
      this.certificate = new acm.Certificate(this, 'Certificate', {
        domainName: name,
        validation: acm.CertificateValidation.fromDns(this.zone),
      })
    }
  }
}
