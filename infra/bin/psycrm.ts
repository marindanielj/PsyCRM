import { App, Stack, Tags } from 'aws-cdk-lib'
import { AppStack } from '../lib/app-stack'
import { DataStack } from '../lib/data-stack'
import { DomainConstruct } from '../lib/domain'
import { FoundationStack } from '../lib/foundation-stack'
import { readSettings } from '../lib/settings'

// One CloudFormation stack, in three parts. (Separate stacks would reference each other's
// roles and key policy and form a cycle.) The public service needs a domain and a
// certificate; until they are given, only the foundation and the data exist.
const app = new App()
const settings = readSettings(app)
const stack = new Stack(app, 'Psycrm', {
  // Region only: the template is account-agnostic, so it synthesizes without credentials and deploys to whichever account you point it at.
  env: { region: settings.region },
  description: 'PsyCRM production: key, network, registry, audit trail, database, service',
})
const foundation = new FoundationStack(stack, 'Foundation', settings)
const data = new DataStack(stack, 'Data', foundation, settings)
const domain = settings.domainName ? new DomainConstruct(stack, 'Domain', settings.domainName, settings) : undefined
if (settings.publicBaseUrl || settings.certificateArn || domain?.certificate) new AppStack(stack, 'App', foundation, data, settings, domain)
Tags.of(app).add('app', 'psycrm')
