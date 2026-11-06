import type { Database } from '../server/db/database'
import { PRACTICE_TZ, todayIn } from '../server/lib/age'
import { seedPractice } from '../server/lib/practice-seed'
import { ContactsRepo } from '../server/repos/contacts-repo'

/**
 * A believable demo practice for LOCAL development only (`npm run dev:local`): the
 * practice from seedPractice() plus four fictional clients spread across the
 * onboarding pipeline, one of them a minor, and three upcoming appointments. Every name,
 * email and date is made up. Never run against a real database.
 */
export const DEMO_LOGIN = { email: 'demo@psycrm.test', password: 'psycrm-demo-pass' } as const

interface DemoClient {
  name: string
  email: string
  /** Years before today, plus a month/day, so ages stay right whenever this runs. */
  age: number
  monthDay: string
  stage: 'new' | 'sent' | 'signed' | 'booked' | 'active'
}

const CLIENTS: DemoClient[] = [
  { name: 'Ana Rivera', email: 'ana.rivera@example.com', age: 34, monthDay: '05-17', stage: 'sent' },
  { name: 'Luis Mora', email: 'luis.mora@example.com', age: 41, monthDay: '11-02', stage: 'signed' },
  { name: 'Sofía Díaz (minor)', email: 'guardian.diaz@example.com', age: 16, monthDay: '08-21', stage: 'new' },
  { name: 'Carlos Vega', email: 'carlos.vega@example.com', age: 47, monthDay: '03-09', stage: 'active' },
]

export async function seedPracticeDemo(db: Database): Promise<void> {
  const { locationId, onboarding } = await seedPractice(db, {
    practiceName: 'Consultorio Demo',
    ownerEmail: DEMO_LOGIN.email,
    ownerName: 'Dra. Demo',
    ownerPassword: DEMO_LOGIN.password,
  })
  const [calendar] = await db.query<{ id: string }>('SELECT id FROM calendars WHERE location_id=$1 LIMIT 1', [locationId])
  const today = todayIn(PRACTICE_TZ)
  const thisYear = Number(today.slice(0, 4))
  const ids: Record<string, string> = {}

  const contacts = new ContactsRepo(db, locationId)
  for (const [i, c] of CLIENTS.entries()) {
    // Born `age` years ago on that month/day; if the birthday hasn't come yet this
    // year the person is a year younger, so shift the birth year to keep the age.
    const dob = `${thisYear - c.age - (c.monthDay > today.slice(5) ? 1 : 0)}-${c.monthDay}`
    const { contact } = await contacts.upsertByMatchFlagged({ name: c.name, email: c.email }, 'demo')
    await contacts.setCustomField(contact.id, 'date_of_birth', dob)
    ids[c.name] = contact.id
    await db.query(
      `INSERT INTO opportunities (id, location_id, pipeline_id, stage_id, contact_id, name, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [`opp_demo_${i + 1}`, locationId, onboarding.pipelineId, onboarding.stages[c.stage], contact.id, c.name, i],
    )
  }

  // Sessions that are always UPCOMING whenever the demo boots (the agenda only lists
  // what is still ahead): one an hour from now, two tomorrow (Puerto Rico time, UTC-4
  // all year).
  const tomorrow = new Date(`${today}T12:00:00Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const tomorrowYmd = tomorrow.toISOString().slice(0, 10)
  const inAnHour = new Date(Math.ceil((Date.now() + 60 * 60_000) / (5 * 60_000)) * 5 * 60_000).toISOString()
  const sessions: [string, string][] = [
    ['Carlos Vega', inAnHour],
    ['Ana Rivera', `${tomorrowYmd}T10:00:00-04:00`],
    ['Luis Mora', `${tomorrowYmd}T14:00:00-04:00`],
  ]
  for (const [i, [who, startsAt]] of sessions.entries()) {
    await db.query(
      `INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, starts_at, ends_at)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz + interval '50 minutes') ON CONFLICT DO NOTHING`,
      [`appt_demo_${i + 1}`, locationId, calendar!.id, ids[who], `Individual session — ${who}`, startsAt],
    )
  }
}
