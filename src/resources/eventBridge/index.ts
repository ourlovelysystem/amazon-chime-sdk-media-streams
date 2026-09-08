/* eslint-disable import/no-extraneous-dependencies */
import {
  ChimeSDKMediaPipelinesClient,
  CreateMediaStreamPipelineCommand,
  MediaPipelineSourceType,
  MediaStreamPipelineSinkType,
  MediaStreamType,
} from '@aws-sdk/client-chime-sdk-media-pipelines';

import { Handler } from 'aws-cdk-lib/aws-lambda';
import axios from 'axios';
import { trace } from './observability';
import {
  MeetingEventType,
  MediaStreamPipelineEventType,
  MeetingEventDetails,
  EventBridge,
  DetailType,
} from './types';

const chimeSdkMediaPipelinesClient = new ChimeSDKMediaPipelinesClient({
  region: 'us-east-1',
});

interface ConsumerInfo {
  startFragmentNumber: string;
  meetingId: string;
  attendeeId: string;
  callStreamingStartTime: string;
  callerStreamArn: string;
}

var KINESIS_VIDEO_STREAM_POOL_ARN = process.env.KINESIS_VIDEO_STREAM_POOL_ARN;
var KVS_CONSUMER_URL = process.env.KVS_CONSUMER_URL || '';
var AWS_REGION = process.env.AWS_REGION;
var AWS_ACCOUNT = process.env.AWS_ACCOUNT;

export const handler: Handler = async (event: EventBridge): Promise<null> => {
  switch (event['detail-type']) {
    case DetailType.CHIME_MEETING_STATE_CHANGE:
      switch (event.detail.eventType) {
        case MeetingEventType.MeetingStarted:
          trace('meeting_event_received', event.detail.meetingId);
          if (event.detail.externalMeetingId === 'MediaStreams') {
            await startMediaStreamPipeline(event.detail);
          }
          break;
        case MeetingEventType.AttendeeDropped:
        case MeetingEventType.AttendeeLeft:
          console.log('Attendee Left');
          break;
      }
      break;
    case DetailType.CHIME_MEDIA_PIPELINE_STATE_CHANGE:
      switch (event.detail.eventType) {
        case MediaStreamPipelineEventType.MediaPipelineKinesisVideoStreamStart:
          trace('kvs_stream_discovered', event.detail.meetingId);
          const consumerInfo = {
            startFragmentNumber: event.detail.startFragmentNumber,
            meetingId: event.detail.meetingId,
            attendeeId: event.detail.attendeeId,
            callStreamingStartTime: event.detail.startTime,
            callerStreamArn: event.detail.kinesisVideoStreamArn,
          };
          await startConsumer(consumerInfo);
          break;
        case MediaStreamPipelineEventType.MediaPipelineKinesisVideoStreamEnd:
          console.log('MediaPipelineKinesisVideoStreamEnd');
          break;
      }
      break;
    case DetailType.CHIME_MEDIA_PIPELINE_KINESIS_VIDEO_POOL_STATE_CHANGE:
      break;
  }
  return null;
};

async function startMediaStreamPipeline(eventDetail: MeetingEventDetails) {
  trace('media_pipeline_create_started', eventDetail.meetingId);
  try {
    const params = {
      Sinks: [
        {
          MediaStreamType: MediaStreamType.IndividualAudio,
          ReservedStreamCapacity: 1,
          SinkArn: KINESIS_VIDEO_STREAM_POOL_ARN,
          SinkType: MediaStreamPipelineSinkType.KinesisVideoStreamPool,
        },
      ],
      Sources: [
        {
          SourceArn: `arn:aws:chime:${AWS_REGION}:${AWS_ACCOUNT}:meeting/${eventDetail.meetingId}`,
          SourceType: MediaPipelineSourceType.ChimeSdkMeeting,
        },
      ],
    };
    await chimeSdkMediaPipelinesClient.send(
      new CreateMediaStreamPipelineCommand(params),
    );
    trace('media_pipeline_create_completed', eventDetail.meetingId, 'success');
  } catch (_error) {
    trace('media_pipeline_create_completed', eventDetail.meetingId, 'failure');
    throw new Error('Error starting Streaming Pipeline');
  }
}

async function startConsumer(consumerInfo: ConsumerInfo) {
  trace('consumer_dispatch_started', consumerInfo.meetingId);
  try {
    await axios.post(
      `http://${KVS_CONSUMER_URL}/call`,
      consumerInfo,
    );
    trace('consumer_dispatch_completed', consumerInfo.meetingId, 'success');
  } catch (_error) {
    trace('consumer_dispatch_completed', consumerInfo.meetingId, 'failure');
    throw new Error('Error starting media consumer');
  }
}
