import assert from 'assert';
import { handleFinalTranscript, TranscriptDeduplicator } from './routing';

async function testBedrockRoute(): Promise<void> {
  const calls: string[] = [];
  const result = await handleFinalTranscript({
    route: 'bedrock', meetingId: 'synthetic-meeting', transcript: 'synthetic question',
    deduplicator: new TranscriptDeduplicator(),
    sendThinking: async () => { calls.push('thinking'); },
    invokeBedrock: async () => { calls.push('bedrock'); return 'Bedrock: answer\n'; },
    invokeIgorBridge: async () => { throw new Error('Igor must not be called'); },
    sendResponse: async (text) => { calls.push(`response:${text}`); },
  });
  assert.strictEqual(result, 'delivered');
  assert.deepStrictEqual(calls, ['thinking', 'bedrock', 'response:Bedrock. answer ']);
}

async function testIgorRouteAndDeduplication(): Promise<void> {
  const calls: string[] = [];
  const deduplicator = new TranscriptDeduplicator();
  const dependencies = {
    route: 'igor_bridge', meetingId: 'synthetic-meeting', transcript: 'synthetic question', deduplicator,
    sendThinking: async () => { calls.push('thinking'); },
    invokeBedrock: async () => { throw new Error('Bedrock must not be called'); },
    invokeIgorBridge: async (text: string, meetingId: string) => {
      calls.push(`igor:${meetingId}:${text}`); return 'Igor answer';
    },
    sendResponse: async (text: string) => { calls.push(`response:${text}`); },
  };
  assert.strictEqual(await handleFinalTranscript(dependencies), 'delivered');
  assert.strictEqual(await handleFinalTranscript(dependencies), 'duplicate');
  assert.deepStrictEqual(calls, ['thinking', 'igor:synthetic-meeting:synthetic question', 'response:Igor answer']);
}

async function testFailureDoesNotRespond(): Promise<void> {
  let delivered = false;
  await assert.rejects(handleFinalTranscript({
    route: 'igor_bridge', meetingId: 'synthetic-meeting', transcript: 'synthetic question',
    deduplicator: new TranscriptDeduplicator(), sendThinking: async () => undefined,
    invokeBedrock: async () => 'unused', invokeIgorBridge: async () => { throw new Error('bridge unavailable'); },
    sendResponse: async () => { delivered = true; },
  }));
  assert.strictEqual(delivered, false);
}

void (async () => { await testBedrockRoute(); await testIgorRouteAndDeduplication(); await testFailureDoesNotRespond(); })();
