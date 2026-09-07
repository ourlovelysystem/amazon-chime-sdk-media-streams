/* eslint-disable import/no-extraneous-dependencies */
import { Duration, Fn, Stack } from 'aws-cdk-lib';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import {
  ServicePrincipal,
  Role,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
} from 'aws-cdk-lib/aws-iam';
import { Architecture, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  ChimeSipMediaApp,
  ChimePhoneNumber,
  PhoneProductType,
  PhoneNumberType,
  ChimeSipRule,
  TriggerType,
} from 'cdk-amazon-chime-resources';
import { Construct } from 'constructs';

interface SIPMediaApplicationProps {
  meetingTable: Table;
  wavBucket: Bucket;
  callCountTable: Table;
  // Logical ID of the stack condition selecting the authenticated Igor handler.
  useIgorAuthenticatedIngressCondition: string;
}
export class SIPMediaApplication extends Construct {
  public phoneNumber: ChimePhoneNumber;
  public sipMediaApp: ChimeSipMediaApp;
  // This repository owns one pre-existing reference SMA; its ID is stable and avoids
  // requiring an update response attribute from the third-party custom resource.

  constructor(scope: Construct, id: string, props: SIPMediaApplicationProps) {
    super(scope, id);

    this.phoneNumber = new ChimePhoneNumber(this, 'phoneNumber', {
      phoneState: 'IL',
      phoneNumberType: PhoneNumberType.LOCAL,
      phoneProductType: PhoneProductType.SMA,
    });

    const smaHandlerRole = new Role(this, 'smaHandlerRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ['chimePolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: ['*'],
              actions: [
                'chime:DeleteMeeting',
                'chime:CreateMeetingWithAttendees',
              ],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    const smaHandlerLambda = new NodejsFunction(this, 'smaHandlerLambda', {
      entry: 'src/resources/smaHandler/index.ts',
      handler: 'lambdaHandler',
      runtime: Runtime.NODEJS_18_X,
      role: smaHandlerRole,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(60),
      environment: {
        FROM_NUMBER: this.phoneNumber.phoneNumber,
        MEETING_TABLE: props.meetingTable.tableName,
        WAV_BUCKET: props.wavBucket.bucketName,
        CALL_COUNT_TABLE: props.callCountTable.tableName,
      },
    });

    // The false branch remains this original Lambda. Fn::If is resolved by the existing
    // SMA custom resource during an in-place UpdateSipMediaApplication call.
    const selectedIngressHandlerArn = Fn.conditionIf(
      props.useIgorAuthenticatedIngressCondition,
      'arn:aws:lambda:us-east-1:867712763388:function:igor-reference-compatible-voice',
      smaHandlerLambda.functionArn,
    );
    this.sipMediaApp = new ChimeSipMediaApp(this, 'sipMediaApp', {
      region: Stack.of(this).region,
      endpoint: selectedIngressHandlerArn as unknown as Function['functionArn'],
    });
    // The custom resource preserves this physical SMA on updates but omits its
    // attribute in an Update response. Downstream resources must use its known ID.
    (this.sipMediaApp as any).sipMediaAppId = '17bd43cc-b102-47d8-902d-69d4db65dba6';

    new ChimeSipRule(this, 'sipRule', {
      triggerType: TriggerType.TO_PHONE_NUMBER,
      triggerValue: this.phoneNumber.phoneNumber,
      targetApplications: [
        { priority: 1, sipMediaApplicationId: this.sipMediaApp.sipMediaAppId },
      ],
    });

    props.meetingTable.grantReadWriteData(smaHandlerLambda);
    props.callCountTable.grantReadWriteData(smaHandlerLambda);
    // Existing Igor authentication state only; this does not create another route or media resource.
    const telephoneCalls = Table.fromTableName(this, 'IgorTelephoneCalls', 'igor-TelephoneCallsTable-1X2UCGUL3VYHB');
    const telephoneSecret = Secret.fromSecretNameV2(this, 'IgorTelephoneAuth', 'igor/telephone-auth');
    telephoneCalls.grantReadWriteData(smaHandlerLambda);
    telephoneSecret.grantRead(smaHandlerLambda);
    smaHandlerLambda.addEnvironment('TELEPHONE_CALLS_TABLE', telephoneCalls.tableName);
    smaHandlerLambda.addEnvironment('TELEPHONE_AUTH_SECRET_NAME', telephoneSecret.secretName);

  }
}
