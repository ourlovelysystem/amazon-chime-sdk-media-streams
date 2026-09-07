/* eslint-disable import/no-extraneous-dependencies */
/*eslint import/no-unresolved: 0 */
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'crypto';
import {
  ChimeSDKMeetingsClient,
  DeleteMeetingCommand,
  CreateMeetingWithAttendeesCommand,
  CreateMeetingWithAttendeesCommandOutput,
} from '@aws-sdk/client-chime-sdk-meetings';

import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

import {
  ActionTypes,
  InvocationEventType,
  SchemaVersion,
  SipMediaApplicationEvent,
  SipMediaApplicationResponse,
  Actions,
  PollyLanguageCodes,
  Engine,
  TextType,
  PollyVoiceIds,
  PlayAudioActionParameters,
} from './sip-media-application';

const MEETING_TABLE = process.env.MEETING_TABLE;
const CALL_COUNT_TABLE = process.env.CALL_COUNT_TABLE;
const WAV_BUCKET = process.env.WAV_BUCKET || '';
const TELEPHONE_CALLS_TABLE = process.env.TELEPHONE_CALLS_TABLE || '';
const TELEPHONE_AUTH_SECRET_NAME = process.env.TELEPHONE_AUTH_SECRET_NAME || '';
const MAX_PIN_ATTEMPTS = 3;
const ASSERTION_SECONDS = 900;
const secretsClient = new SecretsManagerClient({ region: 'us-east-1' });

type AuthSecret = { allow_any_caller?: boolean; pin?: string };
const opaque = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const digits = (event: SipMediaApplicationEvent) => String((event.ActionData as any)?.ReceivedDigits || (event.ActionData as any)?.Parameters?.ReceivedDigits || '').replace(/#$/, '');
export const pinPrompt = (callId: string, retry = false) => ({ Type: ActionTypes.SPEAK_AND_GET_DIGITS, Parameters: { CallId: callId, InputDigitsRegex: '^[0-9]{1,32}#$', SpeechParameters: { Text: retry ? 'PIN was not accepted. Enter your PIN followed by pound.' : 'Welcome to Igor. Enter your PIN followed by pound.', Engine: Engine.NEURAL, LanguageCode: PollyLanguageCodes.EN_US, TextType: TextType.TEXT, VoiceId: PollyVoiceIds.JOANNA }, FailureSpeechParameters: { Text: 'Authentication failed. Goodbye.', Engine: Engine.NEURAL, LanguageCode: PollyLanguageCodes.EN_US, TextType: TextType.TEXT, VoiceId: PollyVoiceIds.JOANNA }, MinNumberOfDigits: 1, MaxNumberOfDigits: 32, TerminatorDigits: ['#'], InBetweenDigitsDurationInMilliseconds: 5000, Repeat: 0, RepeatDurationInMilliseconds: 0 } } as Actions);
async function authSecret(): Promise<AuthSecret> { if (!TELEPHONE_AUTH_SECRET_NAME) return {}; const out = await secretsClient.send(new GetSecretValueCommand({ SecretId: TELEPHONE_AUTH_SECRET_NAME })); return JSON.parse(out.SecretString || '{}') as AuthSecret; }
async function putAuth(callId: string, fields: Record<string, any>) { await ddbClient.send(new PutItemCommand({ TableName: TELEPHONE_CALLS_TABLE, Item: { call_id: { S: callId }, record_key: { S: 'CALL' }, raw_audio_retained: { BOOL: false }, ...fields } })); }
export function assertion(callId: string, conversationId: string, pin: string) { const raw = JSON.stringify({ v: 1, call_id: callId, conversation_id: conversationId, exp: Math.floor(Date.now() / 1000) + ASSERTION_SECONDS }); return `${Buffer.from(raw).toString('base64url')}.${createHmac('sha256', pin).update(raw).digest('hex')}`; }


const ddbClient = new DynamoDBClient({ region: 'us-east-1' });
const chimeSDKMeetingClient = new ChimeSDKMeetingsClient({
  region: 'us-east-1',
});

export const lambdaHandler = async (
  event: SipMediaApplicationEvent,
): Promise<SipMediaApplicationResponse> => {
  console.log('Lambda is invoked with call details:' + JSON.stringify(event));
  let actions: Actions[] = [];
  let transactionAttributes;
  let meetingInfo: CreateMeetingWithAttendeesCommandOutput | undefined;
  if (event.CallDetails.TransactionAttributes) {
    transactionAttributes = event.CallDetails.TransactionAttributes;
  } else {
    transactionAttributes = {
      MeetingId: '',
      CallIdLegA: '',
      CallIdLegB: '',
    };
  }

  switch (event.InvocationEventType) {
    case InvocationEventType.NEW_OUTBOUND_CALL:
      console.log('OUTBOUND CALL');
      actions = [];
      break;
    case InvocationEventType.RINGING:
      console.log('RINGING');
      actions = [];
      break;
    case InvocationEventType.NEW_INBOUND_CALL: {
      // Never join media or issue an assertion until the existing telephone PIN verifies.
      const secret = await authSecret();
      const callId = opaque(event.CallDetails.TransactionId);
      const leg = event.CallDetails.Participants.find((p) => p.ParticipantTag === 'LEG-A')?.CallId || '';
      if (secret.allow_any_caller !== true || !secret.pin || !TELEPHONE_CALLS_TABLE) {
        actions = [speakAction('Telephone authentication is unavailable.', leg), hangupAction(leg)];
      } else {
        await putAuth(callId, { authentication: { S: 'PIN_REQUIRED' }, pin_attempts: { N: '0' } });
        transactionAttributes.IgorAuthState = 'PIN_REQUIRED';
        actions = [pinPrompt(leg)];
      }
      break;
    }

    case InvocationEventType.ACTION_SUCCESSFUL: {
      const legAParticipant = event.CallDetails.Participants.find((participant) => participant.ParticipantTag === 'LEG-A');
      const legBParticipant = event.CallDetails.Participants.find((participant) => participant.ParticipantTag === 'LEG-B');
      transactionAttributes.CallIdLegA = legAParticipant ? legAParticipant.CallId : '';
      transactionAttributes.CallIdLegB = legBParticipant ? legBParticipant.CallId : '';
      const callId = opaque(event.CallDetails.TransactionId);
      if (event.ActionData!.Type === ActionTypes.SPEAK_AND_GET_DIGITS || digits(event)) {
        const secret = await authSecret();
        const call = await ddbClient.send(new GetItemCommand({ TableName: TELEPHONE_CALLS_TABLE, Key: { call_id: { S: callId }, record_key: { S: 'CALL' } }, ConsistentRead: true }));
        const attempts = Number(call.Item?.pin_attempts?.N || '0');
        const submitted = digits(event);
        const expected = secret.pin ? Buffer.from(secret.pin) : Buffer.alloc(0);
        const received = Buffer.from(submitted);
        const ok = call.Item?.authentication?.S === 'PIN_REQUIRED' && expected.length > 0 && expected.length === received.length && timingSafeEqual(expected, received);
        if (!ok) {
          if (attempts + 1 >= MAX_PIN_ATTEMPTS) {actions = [speakAction('Authentication failed. Goodbye.', transactionAttributes.CallIdLegA), hangupAction(transactionAttributes.CallIdLegA)];} else { await putAuth(callId, { authentication: { S: 'PIN_REQUIRED' }, pin_attempts: { N: String(attempts + 1) } }); actions = [pinPrompt(transactionAttributes.CallIdLegA, true)]; }
          break;
        }
        meetingInfo = await createMeeting();
        const meetingId = meetingInfo.Meeting!.MeetingId!;
        const conversationId = opaque(event.CallDetails.TransactionId);
        const signed = assertion(callId, conversationId, secret.pin!);
        await writeMeetingInfoToDB(meetingId, event.CallDetails.TransactionId);
        await putAuth(callId, { authentication: { S: 'AUTHENTICATED' }, meeting_id: { S: meetingId }, conversation_id: { S: conversationId }, authenticated_assertion: { S: signed }, assertion_expires_at: { N: String(Math.floor(Date.now() / 1000) + ASSERTION_SECONDS) } });
        await updateCallCount(1);
        transactionAttributes.MeetingId = meetingId;
        transactionAttributes.IgorConversationId = conversationId;
        actions = [joinChimeMeetingAction(meetingInfo, transactionAttributes.CallIdLegA)];
        break;
      }
      switch (event.ActionData!.Type) {
        case ActionTypes.JOIN_CHIME_MEETING:
          actions = [speakAction('Please wait while we connect you with Igor.', transactionAttributes.CallIdLegA)];
          break;
        default: break;
      }
      break;
    }

    case InvocationEventType.CALL_UPDATE_REQUESTED:
      console.log('CALL_UPDATE_REQUESTED');
      switch (event.ActionData?.Parameters.Arguments.Function) {
        case 'Response':
          actions = [
            speakAction(
              event.ActionData!.Parameters.Arguments.Text,
              transactionAttributes.CallIdLegA,
            ),
          ];
          break;
        case 'Thinking':
          actions = [playAudioAction(transactionAttributes.CallIdLegA)];
          break;
        default:
          break;
      }
      break;

    case InvocationEventType.HANGUP:
      console.log('HANGUP ACTION');

      if (event.ActionData?.Parameters.ParticipantTag === 'LEG-A') {
        console.log('Hangup from Leg A - Hangup Leg B');

        actions = [hangupAction(transactionAttributes.CallIdLegB)];
      } else {
        actions = [];
      }
      await chimeSDKMeetingClient.send(
        new DeleteMeetingCommand({
          MeetingId: transactionAttributes.MeetingId,
        }),
      );
      await updateCallCount(-1);
      break;
    case InvocationEventType.CALL_ANSWERED:
      console.log('CALL ANSWERED');
      meetingInfo = await createMeeting();
      await writeMeetingInfoToDB(
        meetingInfo.Meeting!.MeetingId!,
        event.CallDetails.TransactionId,
      );
      transactionAttributes.MeetingId = meetingInfo.Meeting!.MeetingId!;
      actions = [
        joinChimeMeetingAction(
          meetingInfo,
          event.CallDetails.Participants[0].CallId,
        ),
      ];
      break;
    default:
      console.log('FAILED ACTION');
      actions = [];
  }

  const response: SipMediaApplicationResponse = {
    SchemaVersion: SchemaVersion.VERSION_1_0,
    Actions: actions,
    TransactionAttributes: transactionAttributes,
  };

  console.log('Sending response:' + JSON.stringify(response));
  return response;
};

function hangupAction(callId: string) {
  return {
    Type: ActionTypes.HANGUP,
    Parameters: {
      SipResponseCode: '0',
      CallId: callId,
    },
  };
}

function speakAction(text: string, callId: string) {
  return {
    Type: ActionTypes.SPEAK,
    Parameters: {
      Text: text,
      CallId: callId,
      Engine: Engine.NEURAL,
      LanguageCode: PollyLanguageCodes.EN_US,
      TextType: TextType.TEXT,
      VoiceId: PollyVoiceIds.JOANNA,
    },
  };
}

function joinChimeMeetingAction(
  meetingInfo: CreateMeetingWithAttendeesCommandOutput,
  callId: string,
) {
  return {
    Type: ActionTypes.JOIN_CHIME_MEETING,
    Parameters: {
      JoinToken: meetingInfo.Attendees![0].JoinToken!,
      CallId: callId,
      MeetingId: meetingInfo.Meeting!.MeetingId!,
    },
  };
}

function playAudioAction(callId: string) {
  return {
    Type: ActionTypes.PLAY_AUDIO,
    CallId: callId,
    Parameters: {
      Repeat: 2,
      AudioSource: {
        Type: 'S3',
        BucketName: WAV_BUCKET,
        Key: 'timer.wav',
      },
    } as PlayAudioActionParameters,
  };
}

async function createMeeting() {
  console.log('Creating Meeting for Request ID');
  try {
    const meetingInfo = await chimeSDKMeetingClient.send(
      new CreateMeetingWithAttendeesCommand({
        ClientRequestToken: randomUUID(),
        MediaRegion: 'us-east-1',
        ExternalMeetingId: 'MediaStreams',
        Attendees: [{ ExternalUserId: randomUUID() }],
      }),
    );
    return meetingInfo;
  } catch (error) {
    console.info(`Error: ${error}`);
    throw error;
  }
}

async function writeMeetingInfoToDB(meetingId: string, transactionId: string) {
  const params = {
    TableName: MEETING_TABLE,
    Item: {
      meetingId: { S: meetingId },
      transactionId: { S: transactionId },
    },
  };

  try {
    await ddbClient.send(new PutItemCommand(params));
    console.log(`Meeting info written to DB for meetingId: ${meetingId}`);
  } catch (error) {
    console.error(`Error writing to DB: ${error}`);
    throw error;
  }
}

async function updateCallCount(value: number) {
  console.log(`Updating call count with : ${value}`);
  try {
    const updateParams = {
      TableName: CALL_COUNT_TABLE,
      Key: { pk: { S: 'currentCalls' } },
      UpdateExpression: 'ADD #calls :val',
      ExpressionAttributeNames: {
        '#calls': 'calls',
      },
      ExpressionAttributeValues: {
        ':val': { N: value.toString() },
      },
    };

    const response = await ddbClient.send(new UpdateItemCommand(updateParams));
    console.log(response);
  } catch (error) {
    console.error('Error:', error);
  }
}
