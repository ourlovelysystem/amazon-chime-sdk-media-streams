/* eslint-disable import/no-extraneous-dependencies */
import { App, CfnCondition, CfnOutput, CfnParameter, Fn, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { config } from 'dotenv';
import {
  KinesisVideoStreamPoolResources,
  CreateCallResources,
  EventBridgeResources,
  Cognito,
  SIPMediaApplication,
  DatabaseResources,
  S3Resources,
  ECSResources,
  VPCResources,
  CloudWatchResources,
} from './index';

config();

export interface AmazonChimeSDKMediaStreamsProps extends StackProps {
  logLevel: string;
}

export class AmazonChimeSDKMediaStreams extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: AmazonChimeSDKMediaStreamsProps,
  ) {
    super(scope, id, props);

    const sourceRevision = new CfnParameter(this, 'SourceRevisionParameter', {
      type: 'String',
      default: 'UNSET',
      description: 'Immutable Git revision used for this deployment.',
    });
    // CloudFormation stack tag gives deployment verification an immutable source identity.
    Tags.of(this).add('SourceRevision', sourceRevision.valueAsString);

    const responseRoute = new CfnParameter(this, 'ResponseRouteParameter', {
      type: 'String',
      default: 'bedrock',
      allowedValues: ['bedrock', 'igor_bridge'],
      description: 'Final transcript route; bedrock is the immediate rollback option.',
    });

    const ingressHandler = new CfnParameter(this, 'IngressHandlerParameter', {
      type: 'String',
      default: 'reference',
      allowedValues: ['reference', 'igor_authenticated'],
      description: 'SMA ingress selection; reference is the immediate rollback option.',
    });
    const useIgorAuthenticatedIngress = new CfnCondition(this, 'UseIgorAuthenticatedIngress', {
      expression: Fn.conditionEquals(ingressHandler.valueAsString, 'igor_authenticated'),
    });

    const kinesisVideoPoolStreamResources = new KinesisVideoStreamPoolResources(
      this,
      'KinesisVideoStreamPoolResources',
    );

    const cognitoResources = new Cognito(this, 'Cognito', {
      allowedDomain: '',
    });
    const cloudWatchResources = new CloudWatchResources(
      this,
      'cloudWatchResources',
    );

    const databaseResources = new DatabaseResources(this, 'databaseResources');
    const s3Resources = new S3Resources(this, 's3Resources');

    const vpcResources = new VPCResources(this, 'vpcResources');

    const sipMediaApplication = new SIPMediaApplication(
      this,
      'sipMediaApplication',
      {
        meetingTable: databaseResources.meetingTable,
        wavBucket: s3Resources.outgoingWav,
        callCountTable: databaseResources.callCountTable,
        useIgorAuthenticatedIngressCondition: useIgorAuthenticatedIngress.logicalId,
        sourceRevision: sourceRevision.valueAsString,
      },
    );

    const kvsConsumer = new ECSResources(this, 'kvsConsumer', {
      sipMediaApplication: sipMediaApplication.sipMediaApp,
      meetingTable: databaseResources.meetingTable,
      vpc: vpcResources.vpc,
      albSecurityGroup: vpcResources.albSecurityGroup,
      callsPerTaskMetric: cloudWatchResources.callsPerTaskMetric,
      igorBridgeFunctionArn: 'arn:aws:lambda:us-east-1:867712763388:function:igor-reference-compatible-igor-bridge',
      responseRoute: responseRoute.valueAsString,
    });

    new EventBridgeResources(this, 'eventBridgeResources', {
      kinesisVideoStreamPool:
        kinesisVideoPoolStreamResources.kinesisVideoStreamPool,
      kvsConsumer: kvsConsumer.fargateService,
      meetingTable: databaseResources.meetingTable,
      vpc: vpcResources.vpc,
      albSecurityGroup: vpcResources.albSecurityGroup,
      callCountTable: databaseResources.callCountTable,
      fargateCluster: kvsConsumer.fargateService.cluster,
    });

    new CreateCallResources(this, 'createCallResources', {
      fromPhoneNumber: sipMediaApplication.phoneNumber,
      smaId: sipMediaApplication.sipMediaApp,
      userPool: cognitoResources.userPool,
      meetingTable: databaseResources.meetingTable,
    });

    new CfnOutput(this, 'SourceRevisionOutput', { value: sourceRevision.valueAsString });
    new CfnOutput(this, 'IngressHandlerSelection', { value: ingressHandler.valueAsString });
    new CfnOutput(this, 'AuthenticatedIgorIngressHandlerArn', {
      value: 'arn:aws:lambda:us-east-1:867712763388:function:igor-reference-compatible-voice',
    });

    new CfnOutput(this, 'PhoneNumber', {
      value: sipMediaApplication.phoneNumber.phoneNumber,
    });

    new CfnOutput(this, 'LogGroup', {
      value: kvsConsumer.logGroup.logGroupName,
    });
  }
}

const props = {
  logLevel: process.env.LOG_LEVEL || '',
};
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new AmazonChimeSDKMediaStreams(app, 'AmazonChimeSDKMediaStreams', {
  ...props,
  env: devEnv,
});

app.synth();
