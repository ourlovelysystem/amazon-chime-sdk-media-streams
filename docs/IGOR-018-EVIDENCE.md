# IGOR-018 enhancement and evidence ledger

**Status: IN PROGRESS.** This change has not been validated by a physical telephone call and must not be relabeled RELEASED until that call succeeds.

## Immutable rollback point

`gate1-green` is preserved and resolves to immutable commit `65d8f45e661914bceeba28eded1d9c961031aa1a`. It is not modified or deleted by IGOR-018.

## Implementation

The existing KVS consumer remains the only consumer of the existing Chime/KVS/Fargate/Transcribe path. At its final-Transcribe-result boundary it now selects `RESPONSE_ROUTE`:

* `bedrock` retains the original Bedrock Messages invocation and is the deployed default.
* `igor_bridge` invokes the deployed `igor-reference-compatible-igor-bridge` Lambda with `{ transcript, meeting_id }`. The live bridge contract returns a nonempty `{ conversation_id, response }`; returned text is passed to the existing `UpdateSipMediaApplicationCall` `Response` action.

No Connect, phone number, KVS stream/pool, Fargate service, VPC/NAT, Transcribe component, or Igor diagnostic route is created, replaced, or altered. The existing ECS task role receives only `lambda:InvokeFunction` on the named bridge. Consumer diagnostics avoid event, transcript, caller, audio, credential, and provider-payload logging. A bounded per-task replay guard suppresses duplicate final transcript events for the same meeting/transcript for two minutes.

## Tests and nonphysical evidence

* `src/resources/kvsConsumer/src/routing.test.ts` proves selected `bedrock` invokes only Bedrock, selected `igor_bridge` invokes only Igor, returned text reaches the existing response callback, a bridge failure does not send a false response, and a repeated event does not duplicate the Igor request.
* Live bridge contract verification uses only a synthetic, non-sensitive transcript and records only the nonempty response length, not content.
* CDK synthesis verifies the existing task definition receives `RESPONSE_ROUTE=bedrock`, bridge function configuration, and the exact invoke policy; it adds no parallel telephone infrastructure.
* Post-deploy evidence must verify the published SHA, CloudFormation `SourceRevisionParameter`, ECS task environment, task-role policy, ECS steady state, and the synthetic bridge-to-response callback test.

## Conservative deployment and rollback

`ResponseRouteParameter` accepts `igor_bridge` and `bedrock`; the parameter default is `bedrock` and its deployed value for IGOR-018 is `igor_bridge`. Bedrock remains immediately available: rollback is a one-value update of the existing stack parameter to `ResponseRouteParameter=bedrock`, retaining `IGOR_BRIDGE_FUNCTION_NAME=igor-reference-compatible-igor-bridge`; do not create any service or telephone resource. If a full source rollback is needed, deploy immutable `gate1-green` commit `65d8f45e661914bceeba28eded1d9c961031aa1a` to the same `AmazonChimeSDKMediaStreams` stack.

## Remaining physical requirement

After all nonphysical checks pass, place **one** authorized test call through the existing reference number, ask one harmless question, and confirm one audible answer; report the observed result without recording caller identity, audio, transcript, PIN, or credentials. Until then IGOR-018 remains **IN PROGRESS**.

## Deployment evidence (2026-09-07)

The existing `AmazonChimeSDKMediaStreams` stack was updated successfully from published source revision `9e62ce0d9762400110e6efb8a6bbceb35b8ea13f` (the source implementation commit). CloudFormation reports `UPDATE_COMPLETE`, `SourceRevisionParameter` and `SourceRevisionOutput` both equal that SHA, and `ResponseRouteParameter=igor_bridge`. The active ECS task definition is revision `:3`; its environment contains `RESPONSE_ROUTE=igor_bridge` and the deployed bridge ARN. The existing task role's `IgorBridgePolicy` allows only `lambda:InvokeFunction` on that bridge ARN. The existing service reached steady state and has a healthy target.

Nonphysical synthetic verification then invoked the live bridge and the same consumer response-delivery callback once each (`thinking_actions=1`, `response_actions=1`); response content was redacted. The original Bedrock path and duplicate/failure handling remain covered by the committed unit test. This is not a physical telephone result. **IGOR-018 remains IN PROGRESS.**
