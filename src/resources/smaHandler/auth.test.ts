import * as assert from 'assert';
import { test } from 'node:test';
import { assertion, pinPrompt } from './index';
import { ActionTypes } from './sip-media-application';

void test('live ingress prompt is before JoinChimeMeeting and terminates only with pound', () => {
  const prompt: any = pinPrompt('leg-a');
  assert.equal(prompt.Type, ActionTypes.SPEAK_AND_GET_DIGITS);
  assert.equal(prompt.Parameters.InputDigitsRegex, '^[0-9]{1,32}#$');
  assert.deepEqual(prompt.Parameters.TerminatorDigits, ['#']);
  assert.match(prompt.Parameters.SpeechParameters.Text, /Enter your PIN/);
  assert.equal(JSON.stringify(prompt).includes('JoinChimeMeeting'), false);
});

void test('successful verification assertion is call/conversation scoped and short-lived', () => {
  const encoded = assertion('a'.repeat(32), 'b'.repeat(32), 'test-pin').split('.')[0];
  const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  assert.equal(claims.call_id, 'a'.repeat(32));
  assert.equal(claims.conversation_id, 'b'.repeat(32));
  assert.equal(claims.v, 1);
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));
  assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 901);
});
