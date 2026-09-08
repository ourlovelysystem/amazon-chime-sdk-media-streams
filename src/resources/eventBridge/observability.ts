import { createHash } from 'crypto';

/** Correlates one meeting across services without emitting its AWS identifier. */
export function meetingCorrelation(meetingId: string): string {
  return createHash('sha256').update(meetingId, 'utf8').digest('hex').slice(0, 24);
}

export function trace(stage: string, meetingId: string, outcome?: string): void {
  const fields = [`media_trace stage=${stage}`, `meeting_hash=${meetingCorrelation(meetingId)}`];
  if (outcome) fields.push(`outcome=${outcome}`);
  console.log(fields.join(' '));
}
