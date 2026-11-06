import type { Database } from '../server/db/database'
import { PRACTICE_TZ, todayIn } from '../server/lib/age'
import { seedPractice } from '../server/lib/practice-seed'
import { ContactsRepo } from '../server/repos/contacts-repo'
import { SessionNotesRepo } from '../server/repos/session-notes-repo'

/**
 * A believable demo practice for LOCAL development only (`npm run dev:local`): the
 * practice from seedPractice() plus four fictional clients spread across the
 * onboarding pipeline, one of them a minor, three upcoming appointments, a few
 * session notes (signed, one with moderate risk, one draft) and a session without a note. Every name,
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
  const { locationId, onboarding, operatorId } = await seedPractice(db, {
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

  // A session that already happened but has no note yet (shows in "Sessions without a note").
  const yesterday = new Date(Date.now() - 26 * 3_600_000).toISOString()
  await db.query(
    `INSERT INTO appointments (id, location_id, calendar_id, contact_id, title, starts_at, ends_at, status)
     VALUES ('appt_demo_4',$1,$2,$3,'Individual session — Luis Mora',$4::timestamptz,$4::timestamptz + interval '50 minutes','completed') ON CONFLICT DO NOTHING`,
    [locationId, calendar!.id, ids['Luis Mora'], yesterday],
  )

  // Session notes, written through the real repository so every rule applies (and the audit log
  // fills in). Skipped when the practice already has any, so re-running the seed changes nothing.
  const [existing] = await db.query<{ n: string | number }>('SELECT count(*) AS n FROM session_notes WHERE location_id = $1', [locationId])
  if (Number(existing?.n ?? 0) > 0) return
  const notes = new SessionNotesRepo(db, locationId)
  const actor = { operatorId, ip: null, userAgent: null }
  const daysAgo = (n: number) => {
    const d = new Date(`${today}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - n)
    return d.toISOString().slice(0, 10)
  }
  const low = { riskSuicidal: 'denied', riskSelfHarm: 'denied', riskHarmOthers: 'denied', riskLevel: 'low' }
  const demoNote = async (who: string, input: Record<string, unknown>, sign: boolean) => {
    const created = await notes.create({ contactId: ids[who]!, modality: 'in_person', sessionType: 'individual', durationMin: 50, ...input } as never, actor)
    if (!created.ok) throw new Error(`demo note failed: ${created.error}`)
    if (sign) {
      const r = await notes.sign(created.note.id, actor)
      if (!r.ok) throw new Error(`demo note could not be signed: ${r.error}`)
    }
  }
  await demoNote('Carlos Vega', {
    sessionDate: daysAgo(14), moodRating: 5, ...low, riskFactors: ['isolation'], protectiveFactors: ['social_support', 'engaged_in_treatment'], riskActions: ['none'],
    mse: { mood_reported: 'Tired but hopeful', affect: { values: ['congruent'] }, insight: { values: ['good'] } },
    dataSubjective: 'Reports improved sleep after starting a wind-down routine. Still avoiding Sunday family dinners.',
    dataObjective: 'Presented on time, engaged, good eye contact.', assessment: 'Gradual improvement in sleep; avoidance persists.',
    plan: 'Continue behavioral activation; schedule one family dinner this month.', interventions: ['behavioral_activation', 'psychoeducation'],
  }, true)
  await demoNote('Carlos Vega', {
    sessionDate: daysAgo(7), moodRating: 7, ...low, riskActions: ['none'], protectiveFactors: ['social_support'],
    mse: { mood_reported: 'Better', affect: { values: ['full', 'congruent'] } },
    dataSubjective: 'Attended the family dinner and stayed for an hour.', dataObjective: 'Brighter affect, spontaneous humor.',
    assessment: 'Meaningful progress toward the goal of re-engaging socially.', plan: 'Add a weekly social activity; review in two weeks.', interventions: ['behavioral_activation'],
  }, true)
  await demoNote('Luis Mora', {
    sessionDate: daysAgo(3), moodRating: 3, riskSuicidal: 'passive', riskSelfHarm: 'denied', riskHarmOthers: 'denied', riskLevel: 'moderate',
    riskFactors: ['recent_loss', 'isolation'], protectiveFactors: ['children_dependents'], riskActions: ['safety_plan_created', 'crisis_line_provided'],
    riskNotes: 'Passive thoughts ("it would be easier not to be here") since the loss of his job. No plan or intent. Safety plan written together; 988 and Línea PAS provided.',
    mse: { mood_reported: 'Heavy', affect: { values: ['restricted'] }, thought_content: { values: ['hopelessness', 'worries'] } },
    dataSubjective: 'Lost his job two weeks ago; sleeping poorly and withdrawing from friends.', dataObjective: 'Psychomotor slowing, tearful at times.',
    assessment: 'Acute adjustment reaction with passive suicidal ideation; protective factors include his two children.', plan: 'Weekly sessions, call in 48 hours, review the safety plan next visit.',
    interventions: ['supportive', 'problem_solving'],
  }, true)
  await demoNote('Ana Rivera', { sessionDate: today, moodRating: 6, dataSubjective: 'First session: reports work-related anxiety.' }, false)
}
