# IGOR-018 enhancement and evidence ledger

**Status: IN PROGRESS.** This change has not been validated by a physical telephone call and must not be relabeled RELEASED until that call succeeds.

## Immutable rollback point

`gate1-green` is preserved and resolves to immutable commit `65d8f45e661914bceeba28eded1d9c961031aa1a`. It is not modified or deleted by IGOR-018.

## Implementation

The existing KVS consumer remains the only consumer of the existing Chime/KVS/Fargate/Transcribe path. At its final-Transcribe-result boundary it now selects `RESPONSE_ROUTE`:

- `bedrock` retains the original Bedrock Messages invocation and is the deployed default.
- `igor_bridge` invokes the deployed `igor-reference-compatible-igor-bridge` Lambda with `{ transcript, meeting_id }`. The live bridge contract returns a nonempty `{ conversation_id, response }`; returned text is passed to the existing `UpdateSipMediaApplicationCall` `Response` action.

No Connect, phone number, KVS stream/pool, Fargate service, VPC/NAT, Transcribe component, or Igor diagnostic route is created, replaced, or altered. The existing ECS task role receives only `lambda:InvokeFunction` on the named bridge. Consumer diagnostics avoid event, transcript, caller, audio, credential, and provider-payload logging. A bounded per-task replay guard suppresses duplicate final transcript events for the same meeting/transcript for two minutes.

## Tests and nonphysical evidence

- `src/resources/kvsConsumer/src/routing.test.ts` proves selected `bedrock` invokes only Bedrock, selected `igor_bridge` invokes only Igor, returned text reaches the existing response callback, a bridge failure does not send a false response, and a repeated event does not duplicate the Igor request.
- Live bridge contract verification uses only a synthetic, non-sensitive transcript and records only the nonempty response length, not content.
- CDK synthesis verifies the existing task definition receives `RESPONSE_ROUTE=bedrock`, bridge function configuration, and the exact invoke policy; it adds no parallel telephone infrastructure.
- Post-deploy evidence must verify the published SHA, CloudFormation `SourceRevisionParameter`, ECS task environment, task-role policy, ECS steady state, and the synthetic bridge-to-response callback test.

## Conservative deployment and rollback

`ResponseRouteParameter` accepts `igor_bridge` and `bedrock`; the parameter default is `bedrock` and its deployed value for IGOR-018 is `igor_bridge`. Bedrock remains immediately available: rollback is a one-value update of the existing stack parameter to `ResponseRouteParameter=bedrock`, retaining `IGOR_BRIDGE_FUNCTION_NAME=igor-reference-compatible-igor-bridge`; do not create any service or telephone resource. If a full source rollback is needed, deploy immutable `gate1-green` commit `65d8f45e661914bceeba28eded1d9c961031aa1a` to the same `AmazonChimeSDKMediaStreams` stack.

## Remaining physical requirement

After all nonphysical checks pass, place **one** authorized test call through the existing reference number, ask one harmless question, and confirm one audible answer; report the observed result without recording caller identity, audio, transcript, PIN, or credentials. Until then IGOR-018 remains **IN PROGRESS**.

## Deployment evidence (2026-09-07)

The existing `AmazonChimeSDKMediaStreams` stack was updated successfully from published source revision `9e62ce0d9762400110e6efb8a6bbceb35b8ea13f` (the source implementation commit). CloudFormation reports `UPDATE_COMPLETE`, `SourceRevisionParameter` and `SourceRevisionOutput` both equal that SHA, and `ResponseRouteParameter=igor_bridge`. The active ECS task definition is revision `:3`; its environment contains `RESPONSE_ROUTE=igor_bridge` and the deployed bridge ARN. The existing task role's `IgorBridgePolicy` allows only `lambda:InvokeFunction` on that bridge ARN. The existing service reached steady state and has a healthy target.

Nonphysical synthetic verification then invoked the live bridge and the same consumer response-delivery callback once each (`thinking_actions=1`, `response_actions=1`); response content was redacted. The original Bedrock path and duplicate/failure handling remain covered by the committed unit test. This is not a physical telephone result. **IGOR-018 remains IN PROGRESS.**

## IGOR-018 ingress selection (IN_PROGRESS / NOT_RELEASED)

`IngressHandlerParameter` is the durable, reversible ingress selector for the existing reference SMA. It accepts `reference` (the original `smaHandlerLambda`) and `igor_authenticated` (`arn:aws:lambda:us-east-1:867712763388:function:igor-reference-compatible-voice`). The selector is an `Fn::If` in the existing `Custom::PSTNResources` SMA request, so changing it updates the existing SMA endpoint in place; it does not create a phone number, SIP rule, SMA, meeting, KVS, ECS, or transcription resource.

The authenticated handler's deployed invocation contract is the reference SMA contract: `NEW_INBOUND_CALL` returns `SchemaVersion: "1.0"`, a `SpeakAndGetDigits` PIN action, and no `JoinChimeMeeting`; `ACTION_SUCCESSFUL` with `SpeakAndGetDigits` rejects an absent/invalid PIN (three failures produce `Speak` + `Hangup`) and only a valid PIN returns `JoinChimeMeeting` with `MeetingId`, `JoinToken`, `CallId`, and authenticated transaction attributes. Its bridge accepts `{ transcript, meeting_id }`, requires the authenticated meeting assertion, and returns `{ conversation_id, response }` to the existing `igor_bridge` response flow.

The target Lambda policy is limited to `voiceconnector.chime.amazonaws.com` performing `lambda:InvokeFunction` on the named Igor ingress Lambda; no Chime action is granted to the reference ECS task beyond its existing `chime:UpdateSipMediaApplicationCall` on this SMA. The existing ECS task remains limited to `lambda:InvokeFunction` on `igor-reference-compatible-igor-bridge` for the response route.

Immediate rollback is an in-place update of the same `AmazonChimeSDKMediaStreams` stack with `IngressHandlerParameter=reference` (and retain `ResponseRouteParameter=igor_bridge`). The pre-IGOR source rollback remains immutable `gate1-green` (`65d8f45e661914bceeba28eded1d9c961031aa1a`) deployed to this same stack. IGOR-018 remains **IN_PROGRESS / NOT_RELEASED**; no physical call is made as part of this evidence.

The SMA custom provider does not return `sipMediaAppId` on an in-place update. Downstream stack resources therefore use the already-owned SMA ID `17bd43cc-b102-47d8-902d-69d4db65dba6`, eliminating that response-attribute dependency while leaving the same existing SMA under the provider's lifecycle control.

## IGOR-018 live-routing repair (IN_PROGRESS / NOT_RELEASED)

**Root cause:** the deployed `IngressHandlerParameter=igor_authenticated` changed the declared endpoint of the existing `Custom::PSTNResources` SMA request, but the third-party PSTN provider treats SMA `Update` as a successful no-op. It never calls Chime `UpdateSipMediaApplication`. Thus CloudFormation reported the selector value while the live reference rule still traversed the legacy endpoint.

Before repair, the active chain was `+17302655549` → SIP rule `f729c706-1960-4a80-a78e-4b9c7a606696` (only priority `1`) → SMA `17bd43cc-b102-47d8-902d-69d4db65dba6` (`AmazonChimeSDKMediaStreamssipMediaApplicationsipMediaAppB2DAE5DC`) → legacy `AmazonChimeSDKMediaStream-sipMediaApplicationsmaHa-uc5QhNJdlKw6`. That legacy SMA handler accepts the unauthenticated media join which the Igor bridge correctly rejects. The legacy **SMA target** is therefore SMA `17bd43cc-b102-47d8-902d-69d4db65dba6` with the legacy Lambda endpoint above; no other SMA is in the reference rule target list.

The repair retains the same number, SIP rule, and SMA, and adds a stack-managed in-place `ChimeSDKVoice.UpdateSipMediaApplication` reconciliation resource. It is dependent on the existing SMA declaration, uses only that SMA ARN, and is revision-keyed so every source deployment reapplies the selected endpoint. With `IngressHandlerParameter=igor_authenticated`, the durable after chain is `+17302655549` → the same SIP rule `f729c706-1960-4a80-a78e-4b9c7a606696` (one target only, priority `1`) → the same SMA `17bd43cc-b102-47d8-902d-69d4db65dba6` → `arn:aws:lambda:us-east-1:867712763388:function:igor-reference-compatible-voice`. There is no ordered fallback target, so priority cannot select the legacy route.

Rollback remains explicit and in place: deploy the same stack with `IngressHandlerParameter=reference`, `ResponseRouteParameter=igor_bridge`, and a new `SourceRevisionParameter`; the reconciliation action restores the original reference `smaHandlerLambda` endpoint without changing the number, rule, SMA, or media pipeline. `gate1-green` remains immutable at `65d8f45e661914bceeba28eded1d9c961031aa1a`. This work remains **IN_PROGRESS / NOT_RELEASED**. After successful nonphysical live verification, perform exactly one physical-call test: call the existing reference number once, complete the authorized PIN flow, ask one harmless question, and confirm one audible answer without recording caller identity, audio, transcript, PIN, or credentials.
