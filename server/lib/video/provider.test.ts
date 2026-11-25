import { chimeProvider, fakeVideoProvider } from './provider'

test('chime: a meeting is created with our id and region, and nothing about the client', async () => {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = []
  const p = chimeProvider({
    region: 'us-east-1',
    client: { send: (async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input })
      return { Meeting: { MeetingId: 'cm1' } }
    }) as never },
  })
  const m = await p.createMeeting('vm_1')
  expect(m.MeetingId).toBe('cm1')
  expect(sent[0]).toMatchObject({ name: 'CreateMeetingCommand', input: { ExternalMeetingId: 'vm_1', ClientRequestToken: 'vm_1', MediaRegion: 'us-east-1' } })
})

test('chime: ending a room that is already gone is not an error, any other failure is', async () => {
  const gone = chimeProvider({ region: 'us-east-1', client: { send: (async () => { throw Object.assign(new Error('x'), { name: 'NotFoundException' }) }) as never } })
  await expect(gone.endMeeting('cm1')).resolves.toBeUndefined()
  const broken = chimeProvider({ region: 'us-east-1', client: { send: (async () => { throw Object.assign(new Error('x'), { name: 'ServiceUnavailableException' }) }) as never } })
  await expect(broken.endMeeting('cm1')).rejects.toThrow()
})

test('the fake records what the app asks for', async () => {
  const f = fakeVideoProvider()
  const m = await f.createMeeting('vm_1')
  await f.createAttendee(m.MeetingId!, 'client')
  await f.endMeeting(m.MeetingId!)
  expect(f.meetings).toEqual(['vm_1'])
  expect(f.attendees).toEqual([{ meetingId: 'chime_vm_1', externalUserId: 'client' }])
  expect(f.ended).toEqual(['chime_vm_1'])
})
