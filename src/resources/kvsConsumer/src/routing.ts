export type ResponseRoute = 'bedrock' | 'igor_bridge';

export interface FinalTranscriptDependencies {
  route: string;
  meetingId: string;
  transcript: string;
  sendThinking: () => Promise<void>;
  invokeBedrock: (transcript: string) => Promise<string>;
  invokeIgorBridge: (transcript: string, meetingId: string) => Promise<string>;
  sendResponse: (text: string) => Promise<void>;
  deduplicator: TranscriptDeduplicator;
}

/** Bounded, in-process replay guard for duplicate final Transcribe events. */
export class TranscriptDeduplicator {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 120000) {}

  claim(meetingId: string, transcript: string, now = Date.now()): boolean {
    for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key);
    const key = `${meetingId}\u0000${transcript}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, now + this.ttlMs);
    return true;
  }
}

export function normalizeResponse(text: string): string {
  return text.replace(/'/g, '’').replace(/:/g, '.').replace(/\n/g, ' ').slice(0, 3000);
}

/** Routes one final transcript to the existing response delivery callback exactly once. */
export async function handleFinalTranscript(
  dependencies: FinalTranscriptDependencies,
): Promise<'delivered' | 'duplicate'> {
  if (!dependencies.deduplicator.claim(dependencies.meetingId, dependencies.transcript)) {
    return 'duplicate';
  }
  const route = dependencies.route as ResponseRoute;
  if (route !== 'bedrock' && route !== 'igor_bridge') {
    throw new Error('invalid response route configuration');
  }
  await dependencies.sendThinking();
  const answer = route === 'igor_bridge'
    ? await dependencies.invokeIgorBridge(dependencies.transcript, dependencies.meetingId)
    : await dependencies.invokeBedrock(dependencies.transcript);
  await dependencies.sendResponse(normalizeResponse(answer));
  return 'delivered';
}
