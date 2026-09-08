/* eslint-disable import/no-extraneous-dependencies */
import { PassThrough, Readable } from 'stream';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  ChimeSDKVoiceClient,
  UpdateSipMediaApplicationCallCommand,
} from '@aws-sdk/client-chime-sdk-voice';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import {
  KinesisVideoClient,
  GetDataEndpointCommand,
  APIName,
} from '@aws-sdk/client-kinesis-video';
import {
  KinesisVideoMedia,
  GetMediaCommandInput,
  StartSelectorType,
} from '@aws-sdk/client-kinesis-video-media';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  LanguageCode,
  MediaEncoding,
} from '@aws-sdk/client-transcribe-streaming';
import Fastify from 'fastify';
import ffmpeg from 'fluent-ffmpeg';
import { trace } from './observability';
import { handleFinalTranscript, TranscriptDeduplicator } from './routing';

const fastify = Fastify({
  logger: false,
});

const REGION = process.env.REGION || 'us-east-1';
const SIP_MEDIA_APPLICATION_ID = process.env.SIP_MEDIA_APPLICATION_ID || '';
const MEETING_TABLE = process.env.MEETING_TABLE || '';
// anthropic.claude-instant-v1 is retired (ResourceNotFoundException). Current
// Claude models on Bedrock require an inference profile ID for on-demand
// invocation, not a bare model ID.
const BEDROCK_MODEL =
  process.env.BEDROCK_MODEL || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
// Deliberately defaults to the gate1-green-compatible route for rollback safety.
const RESPONSE_ROUTE = process.env.RESPONSE_ROUTE || 'bedrock';
const IGOR_BRIDGE_FUNCTION_NAME = process.env.IGOR_BRIDGE_FUNCTION_NAME || '';

const bedrockClient = new BedrockRuntimeClient({
  region: REGION,
});
const ddbClient = new DynamoDBClient({ region: REGION });
const chimeSdkVoiceClient = new ChimeSDKVoiceClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });
const transcriptDeduplicator = new TranscriptDeduplicator();

interface KVSStreamDetails {
  streamArn: string;
  meetingId: string;
}

interface Event {
  startFragmentNumber: string;
  meetingId: string;
  attendeeId: string;
  callStreamingStartTime: string;
  callerStreamArn: string;
}

fastify.post('/call', async (request, reply) => {
  try {
    const event = request.body as Event;
    trace('consumer_call_received', event.meetingId);

    const streamArn = event.callerStreamArn;
    const meetingId = event.meetingId;
    await reply.send({
      message: 'Request received. Processing in progress...',
    });
    await readKVSConvertWriteAndTranscribe({
      streamArn,
      meetingId,
    });
    trace('consumer_stream_started', meetingId, 'success');
  } catch (error) {
    console.error('call_processing_failed');
    await reply.status(500).send({ error: 'Internal Server Error' });
  }
});

fastify.get('/', async (_request, reply) => {
  await reply.status(200).send('OK');
});

async function readKVSConvertWriteAndTranscribe({
  streamArn,
  meetingId,
}: KVSStreamDetails): Promise<void> {
  trace('kvs_endpoint_requested', meetingId);
  const kvClient = new KinesisVideoClient({ region: REGION });
  const getDataCmd = new GetDataEndpointCommand({
    APIName: APIName.GET_MEDIA,
    StreamARN: streamArn,
  });

  const response = await kvClient.send(getDataCmd);
  trace('kvs_endpoint_received', meetingId);
  const mediaClient = new KinesisVideoMedia({
    region: REGION,
    endpoint: response.DataEndpoint,
  });

  const fragmentSelector: GetMediaCommandInput = {
    StreamARN: streamArn,
    StartSelector: {
      StartSelectorType: StartSelectorType.NOW,
    },
  };
  trace('kvs_media_requested', meetingId);
  const result = await mediaClient.getMedia(fragmentSelector);
  trace('kvs_media_opened', meetingId);
  const readableStream = (await result.Payload) as Readable;
  const outputStream = new PassThrough();
  let observedAudio = false;
  outputStream.on('data', () => {
    if (!observedAudio) {
      observedAudio = true;
      trace('audio_received', meetingId);
    }
  });

  ffmpeg(readableStream)
    // .on('stderr', (data) => {
    //   console.log(data);
    // })
    .audioCodec('pcm_s16le')
    .format('s16le')
    .output(outputStream, { end: true })
    .run();

  startTranscription(outputStream, meetingId).catch(() => {
    console.error('transcription_stream_failed');
  });
}

const start = async () => {
  try {
    await fastify.listen({ port: 80, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
void start();

async function startTranscription(stream: Readable, meetingId: string) {
  const client = new TranscribeStreamingClient({ region: REGION });
  trace('transcribe_started', meetingId);

  const audioStream = async function* () {
    for await (const chunk of stream) {
      yield { AudioEvent: { AudioChunk: chunk } };
    }
  };

  try {
    const command = new StartStreamTranscriptionCommand({
      LanguageCode: LanguageCode.EN_US,
      MediaEncoding: MediaEncoding.PCM,
      MediaSampleRateHertz: 48000,
      AudioStream: audioStream(),
    });

    const response = await client.send(command);
    trace('transcribe_connected', meetingId);

    if (response.TranscriptResultStream) {
      for await (const event of response.TranscriptResultStream) {
        // console.log(event);
        if (
          event.TranscriptEvent &&
          event.TranscriptEvent &&
          event.TranscriptEvent.Transcript &&
          event.TranscriptEvent.Transcript.Results &&
          event.TranscriptEvent.Transcript.Results.length > 0 &&
          event.TranscriptEvent.Transcript.Results[0].IsPartial == false
        ) {
          const transcript = event.TranscriptEvent.Transcript.Results[0].Alternatives![0].Transcript!;
          trace('final_transcript_received', meetingId);
          const databaseResponse = await readMeetingInfoFromDB(meetingId);
          if (!databaseResponse?.transactionId?.S) {
            trace('meeting_lookup_completed', meetingId, 'missing');
            continue;
          }
          trace('meeting_lookup_completed', meetingId, 'success');
          try {
            const status = await handleFinalTranscript({
              route: RESPONSE_ROUTE,
              meetingId,
              transcript,
              deduplicator: transcriptDeduplicator,
              sendThinking: async () => updateSIPMediaApplication({
                transactionId: databaseResponse.transactionId!.S!, action: 'Thinking', meetingId,
              }),
              invokeBedrock: async (requestTranscript) => invokeBedrock(requestTranscript),
              invokeIgorBridge: async (requestTranscript, requestMeetingId) =>
                invokeIgorBridge(requestTranscript, requestMeetingId),
              sendResponse: async (text) => updateSIPMediaApplication({
                transactionId: databaseResponse.transactionId!.S!, action: 'Response', text, meetingId,
              }),
            });
            console.log(`final_transcript_${status} route=${RESPONSE_ROUTE}`);
            trace('response_flow_completed', meetingId, status);
          } catch (error) {
            // Do not log caller content, identity, audio, credentials, or provider payloads.
            const code = error instanceof Error && error.message === 'invalid response route configuration'
              ? 'INVALID_ROUTE' : 'ROUTING_FAILED';
            console.error(`final_transcript_failed route=${RESPONSE_ROUTE} code=${code}`);
            trace('response_flow_completed', meetingId, 'failure');
          }
        }
      }
      trace('transcribe_completed', meetingId, 'success');
    } else {
      trace('transcribe_completed', meetingId, 'missing_result_stream');
    }
  } catch (error) {
    trace('transcribe_completed', meetingId, 'failure');
  }
}

async function invokeBedrock(transcript: string): Promise<string> {
  const bedrockResponse = await bedrockClient.send(
    new InvokeModelCommand(preparePrompt(transcript)),
  );
  return JSON.parse(new TextDecoder().decode(bedrockResponse.body)).content[0].text;
}

async function invokeIgorBridge(transcript: string, meetingId: string): Promise<string> {
  if (!IGOR_BRIDGE_FUNCTION_NAME) throw new Error('igor bridge is not configured');
  trace('igor_bridge_invocation_started', meetingId);
  const result = await lambdaClient.send(new InvokeCommand({
    FunctionName: IGOR_BRIDGE_FUNCTION_NAME,
    InvocationType: 'RequestResponse',
    Payload: new TextEncoder().encode(JSON.stringify({ transcript, meeting_id: meetingId })),
  }));
  if (result.FunctionError || !result.Payload) {
    trace('igor_bridge_invocation_completed', meetingId, 'failure');
    throw new Error('igor bridge invocation failed');
  }
  const response = JSON.parse(new TextDecoder().decode(result.Payload));
  if (typeof response.response !== 'string' || !response.response) {
    trace('igor_bridge_invocation_completed', meetingId, 'invalid_response');
    throw new Error('igor bridge returned no response');
  }
  trace('igor_bridge_invocation_completed', meetingId, 'success');
  return response.response;
}

function preparePrompt(promptRequest: string) {
  return {
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'This is a question from a caller.  In a few sentences provide an answer to this question.\n\n' +
                promptRequest,
            },
          ],
        },
      ],
      max_tokens: 4000,
    }),
    modelId: BEDROCK_MODEL,
    accept: 'application/json',
    contentType: 'application/json',
  };
}

async function readMeetingInfoFromDB(meetingId: string) {
  const params = {
    TableName: MEETING_TABLE,
    Key: {
      meetingId: { S: meetingId },
    },
  };

  try {
    const data = await ddbClient.send(new GetItemCommand(params));
    if (data.Item) {
      console.log('meeting_info_found');
      return data.Item;
    } else {
      console.log('meeting_info_missing');
      return null;
    }
  } catch (error) {
    console.error('meeting_info_read_failed');
    throw error;
  }
}

interface UpdateSIPMediaApplicationOptions {
  transactionId: string;
  action: string;
  text?: string;
  meetingId?: string;
}

async function updateSIPMediaApplication(
  options: UpdateSIPMediaApplicationOptions,
) {
  const { transactionId, action, text } = options;

  const params = {
    SipMediaApplicationId: SIP_MEDIA_APPLICATION_ID,
    TransactionId: transactionId,
    Arguments: { Function: action, ...(text ? { Text: text } : null) },
  };
  console.log(`sip_update action=${action}`);
  const meetingId = options.meetingId;
  if (meetingId) trace('sip_update_started', meetingId, action.toLowerCase());
  try {
    await chimeSdkVoiceClient.send(
      new UpdateSipMediaApplicationCallCommand(params),
    );
    if (meetingId) trace('sip_update_completed', meetingId, 'success');
  } catch (error) {
    console.error('sip_update_failed');
    if (meetingId) trace('sip_update_completed', meetingId, 'failure');
    throw error;
  }
}
