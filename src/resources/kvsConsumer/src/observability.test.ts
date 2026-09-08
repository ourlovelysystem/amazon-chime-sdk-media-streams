import assert from 'assert';
import { meetingCorrelation, trace } from './observability';

const meetingId = 'sensitive-meeting-identifier';
const correlation = meetingCorrelation(meetingId);

assert.match(correlation, /^[0-9a-f]{24}$/);
assert.strictEqual(meetingCorrelation(meetingId), correlation);
assert.notStrictEqual(meetingCorrelation('another-meeting'), correlation);

const messages: string[] = [];
const originalLog = console.log;
console.log = (message?: unknown) => messages.push(String(message));
try {
  trace('audio_received', meetingId, 'success');
} finally {
  console.log = originalLog;
}

assert.deepStrictEqual(messages, [
  `media_trace stage=audio_received meeting_hash=${correlation} outcome=success`,
]);
assert.ok(!messages[0].includes(meetingId));
