// pi-foreman core adapter: wires the vendored Python core into Pi (design §§5-7, 9).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SteerWatch, foldSteer, pickupRuling, takeLateSteer } from "./steerwatch.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterSpawn, beforeSpawn, changedFileOf, escalate, gateThreshold, initialCeremony, isTier, ledgerTier, onFileChanged, onStrongLaunch, promptSignals, tierLine, TIERS, userOverride } from "./ceremony.ts";
import { checkTrivial, cleanTreeStatus, effectiveRequired, escalationNote, trivialBuilderPath } from "./trivial.ts";
import type { CeremonyState } from "./ceremony.ts";
import { canonical, generateSubagents, get, loadMergedConfig, pythonPathHint, readProjectDeferred } from "./config.ts";
import type { Json, MergedConfig } from "./config.ts";
import { loadRegister, normaliseChildExtensions, registrationPathLabel } from "./childext.ts";
import { childHandoffDirs, isSelfHost, openedHandoffDirs, literalOwnedDirs, npmRootOnce, ownedRoots, ownHandoffDirs, underOwned } from "./owned.ts";
import { recheckExempt } from "./recheckexempt.ts";
import type { OwnedRoots } from "./owned.ts";
import { launchNeedsNestedRefusal, sessionRootInputs, sessionScratchRoot, treeCeilingOf, treeRootOf, worktreeRootDoctor } from "./worktreeroot.ts";
import { baseFloorEnv, denialFragment, denialSentence, gateEvaluate, gitFacts, reviewGitFacts } from "./gate.ts";
import { lineFloors } from "./floors.ts";
import type { FloorEnv } from "./floors.ts";
import { ownWorktreeCheck, sessionGitFacts } from "./ownworktree.ts";
import { Classifier, CLASSIFIER_ROLE, classifierTarget, denyText } from "./classifier.ts";
import { noClassifierModelText } from "./reviewwarn.ts";
import { effectiveCheckMode } from "./protected.ts";
import { PermStore, PERM_MODES, PROTECTED_CHECK_MODES, cleanProtected, profileName, protectHintLines, protectedBlock, workFoldersBlock } from "./permconfig.ts";
import { folderRelaxes, mergedFactKey, withMergedFacts } from "./defaults.ts";
import type { GitFacts } from "./defaults.ts";
import type { PermMode, Resolved } from "./permconfig.ts";
import { describeCall, exactRules, proposeRule } from "./rules.ts";
import { readToolsOf, warnUnknownReadTools } from "./readtools.ts";
import { adopt as adoptSuggested, entriesFromReport, parsePicks, readClearHint, review as reviewAdopted, runSuggest, suggestHint } from "./permssuggest.ts";
import { insideDirs, readClearEntry, readNotes, shellIsBash } from "./readclear.ts";
import type { AdoptPick } from "./permssuggest.ts";
import { gateLogFile, openGateLog } from "./gatelog.ts";
import type { GateKind, GateLog, GateLayer } from "./gatelog.ts";
import { ChildAskWatch, childAskDir, childAskParentDir, awaitChildRuling, inputHash, writeChildAsk } from "./childask.ts";
import { ChildAskPark, parkKey } from "./childaskpark.ts";
import type { ChildAnswer, ChildAsk, ChildAskEvent } from "./childask.ts";
import { askOwner, STOP_TEXT } from "./gatedialog.ts";
import { childNpmNote } from "./childnpm.ts";
import type { OwnerAnswer, OwnerDeps } from "./gatedialog.ts";
import { parseShell } from "./shellast.ts";
import { CHILD_GONE_TEXT, childAskOffText, NO_PANE_TEXT } from "./presencewait.ts";
import { PATH_TOOL_NAMES, tmpRoots } from "./pathrules.ts";
import { toolPath } from "./pathnorm.ts";
import type { GateRoots } from "./pathrules.ts";
import type { Registration } from "./childext.ts";
import { forceDetached } from "./detach.ts";
import { forceUserScope, SHADOW_FIX, shadowedRoles } from "./agentscope.ts";
import { actionOf, endActive, isManagementCall, launchId, outputPathBlock, recordLaunch, recordLaunchRoles, resumeTarget, trackActive, roundSteps, subagentActionCheck, uncheckedHeavyBlock } from "./actions.ts";
import { combined, gateOf, gatesClearFail, gatesMarkStood, gatesRevise, gatesVerdict, openHint, SESSION_WIDE, standsFor, stands, type ReviewGates } from "./reviewgates.ts";
import { dupRefusalText, repeatSignals, type PassMark, addChange, boundRefusal, emptySteps, finishLine, emptyTally, finishRefusal, initialReviewGate, openSteps, noChange, overBound, pendingChange, readBound, dupReview, reopened, requiredSteps, reviewGateMode, reviewVerdictsOfRunEnd, SECOND_OPINION, stepsOfRunEnd } from "./bound.ts";
import { isBriefName, isCapsResetName, isRulingName, isTrackedRulingName, parentApproval, rulingNeeded, rulingOverrideNote, selfRulingRefusal, SelfRulings, snapshotRulings, toolWriteRuling } from "./ruling.ts";
import type { Change, Step, StepCounts, Tally } from "./bound.ts";
import type { RunRegistry } from "./actions.ts";
import { guardPayloadBlock } from "./guardgaps.ts";
import { firstRunNotice, presetNames, presetProviders, providerGapNotice } from "./firstrun.ts";
import { dormantDoctorLine, withBuiltinKeepalive } from "./features.ts";
import { bridgeTrusted, trustBridgeCommand } from "./bridgetrust.ts";
import { withNudge } from "./knowledge.ts";
import { preBashConfigOf, runPreBashHooks } from "./prebash.ts";
import { profileDoctorLines } from "./profiledoctor.ts";
import { doctorAppHome, modsDoctorLines } from "./profiles.mjs";
import { BUNDLED_PACKAGE_ROOTS, collectOrientation } from "./orient.ts";
import type { PiRoots } from "./orient.ts";
import { applyRootsBlock } from "./childbrief.ts";
import { ExplorerBrief } from "./builderbrief.ts";
import { ChildReads, childReadLimits, launchReadAllowance } from "./childreads.ts";
import { bgWaitLocations, coordinationCall, launchLocations, inRecorded, noticeLocations, isReadCall, ReadBudget, READ_CLASS, readLimits, recordFiles } from "./budget.ts";
import { roleToolDenied } from "./roledeny.ts";
import { McpChild, configuredServers, searchableOf } from "./mcpchild.ts";
import { missingFloorTools } from "./toolfloor.ts";
import { DEFERRED_ENTRY, DEFERRED_SECTION, MODEL_ONLY_SECTION, modelOnlyHint, addedPatterns, deferredDoctorLines, deferredHint, hiddenSet, latestDeferredLoaded, mergeDeferredLayers } from "./deferred.ts";
import { createToolSearchTool } from "./toolsearch.ts";
import { ToolUsageTracker, packageOf } from "./toolusage.ts";
import { SKILLS_SECTION, skillRulesOf, skillsHint, splitSkills, type SkillRef, type SkillRules } from "./skillvisibility.ts";
import type { McpChildOpts } from "./mcpchild.ts";
import { mcpHintLine, namedCeilingServers, PER_ENTRY_BINDINGS, planMcpLaunch, unknownServerLine, unknownServers, wholeOnlyServers, wholeServerLine, workflowBindingBlock } from "./mcplaunch.ts";
import { allowedMcpNamed, directMaxTools, directProviders, namedEntries, roleMcpEntries } from "./mcpscope.ts";
import { childSkillRefs } from "./skilldirs.ts";
import { editorBackupCommand } from "./effects.ts";
import { compareRunEnd, launchRunCwds, noticeText, readonlyRoles, spawnGit, takeStartEntry, traceLines } from "./readonlystate.ts";
import type { GitRunner, StartEntry } from "./readonlystate.ts";
import { RUN_END_EVENTS, SUPERVISOR_TOOL, SupervisorWindow, roleToolsFrom } from "./supervisor.ts";
import { branchMergedFact, branchMove, chainHint, runShellWriteGuard, shellWriteGuardPayload, shellWriteVerdict } from "./shellwriteguard.ts";
import { childRoleIds, roleLaunchBlock, roleModelBlock } from "./roles.ts";
import { BRIDGE_PROVIDER, BridgeIsolation, bridgeLoadOrder, providersLine, isolationDir, isolationDoctor, isolationOn, loadOrderNotice, PROJECT_BRIDGE_FIX, PROJECT_CLAUDE_FIX, projectBridgeConfigRisks, projectClaudeRisks, userBridgeConfigRisks } from "./bridgeiso.ts";
import { applyLaunchModels, applyLaunchTimeouts, roleModelsOf, roleTimeoutMs, rowModelOf, splitLevel, STRENGTHS } from "./launchmodel.ts";
import { hubWorkflowDriftLines } from "./hubdrift.ts";
import { gateMigrationLines } from "./gatemigrate.ts";
import { reviewTarget, userPromptOf } from "./review.ts";
import { git, ReviewFacts } from "./diffscan.ts";
import { applyFactCriticalRungs, applyResearchFloor, entryTraces, floorMarker, markedEntries, researchTraces } from "./research.ts";
import { descendsFrom, dueReasons, dueReminder, required as hsRequiredOf, findingsBlock, finishNeeds, highStakesConfig, HighStakes, HS_RISKS, launchRefusal, resumeRefusal, reviewBaseOf, repoKeyOf, holdFacts, prRefusal, readyOverride, stakesTrace, taskLine, unrevisedRefusal } from "./highstakes.ts";
import { applyOccasionOverrides, applyReviewModelRule, applySecurityRungs, cappedRung, markPolicyOverrides, missingPairWarning, planReviewerClimbs, ReviewerFails, type ReviewerClimb, type ReviewPin } from "./reviewerclimb.ts";
import type { RoleResolution } from "./roles.ts";
import { buildGuardEnv, msysEnv, patchShellEnv, piAgentDir } from "./env.ts";
import { patchChildGitEnv, stripChildCdEnv, stripChildIntercomEnv } from "./childenv.ts";
import { boundLaunchId, ChildScratch, finishScratch, launchScratch, OUT_ENV, SCRATCH_ENV, scratchRoot, storeBrief, sweepKept, sweepOldScratch, sweepScratch, wtScratchBase } from "./childscratch.ts";
import type { ScratchWt } from "./childscratch.ts";
import { panelChecksLine } from "./panelchecks.ts";
import type { PanelChecksCache } from "./panelchecks.ts";
import { GitDriftWatch, mainNeedsGitGuard, patchForemanGitEnv, safeOpDriftPreflight } from "./gitdrift.ts";
import { ClaudeConfigWatch } from "./claudedrift.ts";
import { boundLedger, ensureSessionMarker, isLedgerTarget, markerPath } from "./marker.ts";
import { allowedItems, checkVerdictCall, consumeRecord, failedItemIds, FINDING_CLASSES, FINDING_KINDS, ITEM_RESULTS, itemIdOf, launchItemsLine, launchItemsOf, makeRecordDir, MAX_FINDINGS, MAX_ITEMS, noToolRecord, parseItemsField, readConsumed, readRecordFile, recordDir, recordOf, recordSessionDir, sweepRecords, VERDICT_FILE, VERDICT_REMINDER, VERDICT_TOOL, VERDICT_VALUES, writeRecord, type ItemId, type VerdictItem, type VerdictRecord } from "./verdict.ts";
import { extendSubagentDeclaration } from "./launchschema.ts";
import { absent, applyVariants, findItemByText, isLedgerOnlyCommand, isPermissionDeny, LEDGER_TOOL, LEDGER_TOOL_ACTIONS, ledgerHelperMode, ledgerInitContent, marksVerifierCommand, mentionsLedger, planLedgerCall, planLedgerInit, retryLedgerRun, rewriteItemText } from "./ledgercall.ts";
import { postToolPayload, preToolPayload, resolveToolPath, stopPayload, subagentAgents, subagentTaskText } from "./payload.ts";
import type { PayloadContext } from "./payload.ts";
import { NO_PYTHON_FIX, PythonCache, resolvePython } from "./python.ts";
import type { PythonResolution } from "./python.ts";
import { beginRun, beginUndo, cleanText, decideScript, newScriptState, proposeScript, recordRealRun, recordRun, recordUndo, SCRIPT_CHOICES, SCRIPT_FIX_LINES_DEFAULT, SCRIPT_MAX_ATTEMPTS, SCRIPT_TOOL, scriptNoticeLines, scriptSelectTitle, scriptUndoLine, scriptStatus, shortHash } from "./scriptapproval.ts";
import type { ScriptRefusalCode, ScriptState } from "./scriptapproval.ts";
import { runScript as runOwnerScript, runScriptDetachable } from "./scriptrun.ts";
import type { ScriptRunDetached, ScriptRunResult } from "./scriptrun.ts";
import { configResultText, parseConfigArgs } from "./configcmd.ts";
import type { ScriptRunAction } from "./scriptapproval.ts";
import { runGuard } from "./runguard.ts";
import { PR_FOLLOW, applyGitPack, applyPrPack, gitPackOn, prHostLabel, prPackOn, isOwnTool, registerGitPack, registerPrFollow, registerPrPack } from "./gitpack.ts";
import type { PrPackSession } from "./gitpack.ts";
import { addTracked, lastPollAgeMs, readStoreEntry, trackedHostOf, trackerDoctorLine } from "./prstore.ts";
import type { PrOp } from "./gitpack.ts";
import { PRWATCH_ENTRY, PrWatches, latestWatches, settleMsOf, watchIntervalMs } from "./prwatch.ts";
import { parseWakeRules } from "./prwake.ts";
import { PrHost, branchOf, isTrackedKey, resolveGithubHosts } from "./prhost.ts";
import { PushNotice } from "./pushnotice.ts";
import { Where, originRepo } from "./where.ts";
import { ExtStatus } from "./extstatus.ts";
import { registerSafeOps, runSafeOp } from "./safeops.ts";
import { defaultSpawner } from "./spawn.ts";
import type { Spawner } from "./spawn.ts";
import { ADDON_BG_TOOL, isShellTool, mapTool } from "./toolmap.ts";
import type { GuardName } from "./toolmap.ts";
import { evaluateRun, planModeOn, spawnPermissionMode, translateStop, translateToolCall } from "./translate.ts";
import { appendHeadLine, appendReview, capSet, checksLine, headlessPass, headOf, headsAt, isPrToolName, launchCwds, passHeads, prGateRefusal, reviewedHeadVia, toplevelOf, treesAt, reviewsWithOutput } from "./reviews.ts";
import type { HighStakesGate, ReviewRecord } from "./reviews.ts";
import { AttentionNotices, dedupeToolCallNotices, dropEndedRunNotices, dropSuppressedNotices, hideStaleNotice, isRepeatOpenNotice, noticeEvent, staleNoticeRunIds, stableNoticeFilter, trimNoticeMessage } from "./notices.ts";
import { clearOpenCommand, DEFAULT_LONG_COMMANDS, isLongCommand, readOpenCommand, writeOpenCommand } from "./opencommand.ts";
import { hasOpenLedgerLine, markPassItems, MARK_NOTE, openItemsOf } from "./reviewmarks.ts";
import { commentOnlySince, treeChangedSince, worktreeTree, type TreeSnap } from "./commentonly.ts";
import { denyFields, openTrace, toolErrorRecord, traceFile } from "./trace.ts";
import type { TraceWriter } from "./trace.ts";
import { loadPrices } from "./cost.ts";
import { budgetCap, budgetCheck, prependReReview, prependReReviewScoped, wholeChangeSentence } from "./costguard.ts";
import { costReport } from "./costreport.ts";
import { appendUsage, aggregate, isCostLine, bindLaunch, stripBinding, causeOfCustom, WAKE_MESSAGE_TYPE, causeOfInput, formatSummary, keepSection, alignSections, PARENT_SESSION_ENV, readBinding, takeBinding, checkoutEnv, pricedLine, readUsage, recordUsageLaunch, singleLaunchRole, usageFile, usageLine } from "./usage.ts";
import type { LadderLimits, LaunchBinding, LaunchKind, LineContext, TurnCause } from "./usage.ts";
import { workspaceOf } from "./python.ts";
import { dialogFamily, dialogFields, dialogsJson } from "./dialogs.ts";
import { AskFlag } from "./askflag.ts";
import { START_NOTE_ENTRY, START_NOTE_TYPE, startNoteRecorded, startNoteText } from "./startnote.ts";
import { REPORT_DESCRIPTION, REPORT_PARAMS, REPORT_TOOL, REPORTS_DESCRIPTION, REPORTS_PARAMS, REPORTS_TOOL, runReport, runReports, type ReportSession } from "./reportstool.ts";
import { recordReport, reportContext } from "./reports.ts";
import { ASK_USER_TOOL, askAnsweredSome } from "./askhooks.ts";

const DIALOGS_TOOL = "foreman_dialogs";
import { ChildRuns, UsageTail, rungOf } from "./runs.ts";
import { childBashTimeout, type ChildBashTimeout } from "./bashtimeout.ts";
import { reviewFactsForHead } from "./prready.ts";
import { highestRework } from "./rework.ts";
import { LIVE_DEAD_MS, LiveState, intercomIdOf, labelOfHandoff, liveDir, prWatchWait } from "./livestate.ts";
import { PaneResume, RESTART_MESSAGE_TYPE, signalEnded, taskEndedCheck } from "./paneresume.ts";
import { readLiveRecord, readResumeSetting } from "./paneresume-core.ts";
import { ownerFactsLines, ownerFormHints, ownerSectionIssues, ownerSummary, planFormIssues, prefixQuestions, projectNameOf, questionHint, questionPrefix } from "./ownertext.ts";
import { NOTE_MAX_BYTES, NOTE_TITLE_MAX, planPageLineOf, planPageOutcome, Show, SHOW_TOOL, showOffReason } from "./show.ts";
import { cleanDialogText, shapedConfirm, shapedSelect } from "./ownerdialog.ts";
import type { DialogSpec } from "./ownerdialog.ts";
import { OpenPrsRefresher, ReloadingConfig, openPrsConfig, realGh } from "./openprs.ts";
import { installSidebarLive } from "./sidebarlive.ts";
import { CompactionGate } from "./compaction.ts";
import { runtimePoint } from "./compaction-point.mjs";
import { piModelDataDir } from "./pi-model-data.mjs";
import { resolveCachePolicy, resolveWarmPolicy } from "./cachepolicy.ts";
import { bridgeTtlDoctorLines, cacheDoctorLines, deprecatedKeepaliveLines, retiredHighStakesLines } from "./doctorcache.ts";
import { BridgeCacheTtl, bridgeTtlSetting, derivedBridgeTtlS, type BridgeTtlSetting } from "./bridgettl.ts";
import type { Presence } from "./presence.ts";
import type { SelfWarm, WarmSignals } from "./selfwarm.ts";
import { createWarm, liveReplayApi } from "./warmwire.ts";
import { doctorWarm } from "./doctorwarm.ts";
import { warmRates } from "./warmbudget.ts";
import { hidesDeclaredTools } from "./childtools.ts";
import { forcedProjection, replayable, subagentNoticeWrap } from "./warmreplay.ts";
import { IDLE_ENTRY, IdleModel, ownerAnswered } from "./idlemodel.ts";
import { coldAt as coldAtTouch } from "./warmcompact.ts";
import { KeepaliveLog, type KeepaliveResult } from "./keepalive.ts";
import { applyLedgerItems, criticOf, reReviewLine } from "./ledgerblock.ts";
import { taskLedger } from "./ledgerpath.ts";
import { citedItems, hintFailTrace, ledgerHint, renameRetry, writeHint as writeHintNow, type HintWriteOpts, type HintLog } from "./hints.ts";
import { ledgerGate, type LedgerGate } from "./ledgerlock.ts";
import { appendCompactionRetro, appendModelRetro, appendStateRetro, RetroState, retroEnabled, sessionTrace, withDigest } from "./retro.ts";
import { extractRetro, lastAssistantText, knownLimitsArg, modelRetroPrompt, RETRO_INSTRUCTIONS } from "./retrodigest.ts";
import { UsageFooter, cacheStatus, footerStyleOf, lookupRate, type CacheSource } from "./footer.ts";
import { symbolSet } from "./symbols.ts";
import { blockedConfirmOn, cleanLabel, installBlockedShim, withBlockedOn } from "./herdr.ts";
import type { BlockClass } from "./herdr.ts";
import { installHerdrMeta } from "./herdrmeta.ts";
import { installBgRecords } from "./bgrecords.ts";
import { RemoteWatcher } from "./remotewatch.ts";
import { CHILD_BLOCKED_TYPE, ChildBlocked, noticeSeconds, openChildren } from "./childblocked.ts";
import { IntercomCarry, addresses, deliveredSendTo, isQuestion, parentIdsOf, senderOf } from "./intercomcarry.ts";
import { captureIdentity, IDENTITY_ENTRY, latestIdentity, restoreIdentity, writeLive } from "./identity.ts";
import type { IdentityRestore } from "./identity.ts";
import { builderLaunchRefusal, checkpointConfigRefusal, CHECKPOINT_CHOICES, CHECKPOINT_TOOL, copyStale, currentPlanHash, isPlanPath, launchRefusalText, parentPhaseCheckpointText, PLAN_NAME, planSummary, readPlan, restoreFromStore, rulingsTopic, saveStored, sha256 } from "./checkpoint.ts";
import type { PlanFile } from "./checkpoint.ts";
import { hiddenFactsLine } from "./htmlmd.ts";
import type { PlanRecord } from "./checkpoint.ts";
import type { EventBus } from "./herdr.ts";
import { claimCore, emitReady, installInert, markCoreStarted, missingBundled, setupInvocation } from "./registry.ts";

/** pi.events of the loaded extension, for the Herdr blocked signal (set in the factory). */
let herdrEvents: EventBus | undefined;
/** The classes the dialog and hold sites declare (herdr.ts BlockClass): who the source waits on and its fixed kind word. */
const BLOCK_APPROVAL: BlockClass = { on: "owner", kind: "approval" };
const BLOCK_CHECKPOINT: BlockClass = { on: "owner", kind: "checkpoint" };
const BLOCK_SCRIPT: BlockClass = { on: "owner", kind: "script" };
const BLOCK_CONFIRM: BlockClass = { on: "owner", kind: "confirm" };
const BLOCK_PARENT: BlockClass = { on: "parent", kind: "parent-ask" };
import { completedAgents, CritiqueCounter, initialRounds, isOwnerPrompt, NOTIFY_TYPE, onReviewDone, REVIEW_ROLES, rulingReset, walkLaunch, type Verdict } from "./rounds.ts";
import type { LaunchRounds, RoundState } from "./rounds.ts";
import { loopRefusal, loopRefusalParented, loopVerdictOf, sigOf } from "./reviewloop.ts";
import type { LoopStop, ReviewKind } from "./reviewloop.ts";
import { getShellConfig as piGetShellConfig } from "@earendil-works/pi-coding-agent";
import { applyBgAddonDefaults, bgBashNotice, resolveBgShell } from "./bgshell.ts";
import { shellPathSetting } from "./bg.ts";
import type { ShellConfigFn } from "./bg.ts";
import { addonPeerRangeLine, addonPresent, bgFeaturesDoctor, optionalAddonsDoctor, formatWaits, readAddonTasks, readOwnAddonTasks, wakingBgTaskIds } from "./bg.ts";
import { registerWait, waitLimits } from "./wait.ts";
import { CRITICAL_WAIT_SECONDS, criticalReason, explorerOnly, narrowTasks, overrideAvailability, overrideDeclinedReason, overrideHint, overrideShape, overrideSpec, overrideUnavailableReason, takePressureOverride, taskHash, PRESSURE_FIXTURE_ENV, limitsOf, PressureSampler, pressureDoctorLine, pressurePath, pressureStatusLine, queuedReason, readPressure, sampleSecondsOf, type PressureState } from "./pressure.ts";
import { dedupeNotices, dedupeOn, detachedLaunchLine, dropAsyncGuidance, holdCap, LaunchBatch, launchWaitMode, openRequestLine, launchWaitText, LaunchWaits, noticeRuns, REPEAT_REFUSAL_ERROR, REPEAT_STOP_REASONS, runEndOf, SUPERVISOR_SURFACED_EVENT } from "./launchwait.ts";
import { HANDOFF_DIR_ENV, REMOTE_PARENT_ENV, closeReportArgs, parentIntercomId, mergeNotifier, outboxSend, parseCloseReport, readCloseJson, registerClose, syncCommand } from "./close.ts";
import { mergedReturn, realGit } from "./returntobase.ts";
import { samePath, selfFinish, spawnDetached, verifiedMergeFor } from "./selffinish.ts";
import type { CloseReport } from "./close.ts";
import { cliModelOf, foremanModelSpec, markOwnClosed, openerIntercomId, registerSession, remoteReplier, remoteRunner, registerSessionOpenTool, sessionModelOf } from "./session.ts";
import { closeChildren } from "./closechildren.ts";
import { OwnAsk } from "./ownask.ts";
import { SteerReader } from "./steer.ts";
import { foremanTriage, GATED_TOOLS, isTriaged, OUTWARD_TOOLS, triageAdvice, triageGateBlock, TRIAGE_RULES, TRIAGE_TOOL, trivialPathAdvice, workspaceTargets } from "./triage.ts";
import { allowedShellDirs, editModeAdvice, editModeBlock, editModeOf, projectChange, scratchDirOf } from "./editmode.ts";
import type { EditMode } from "./editmode.ts";
import { familyWarnings, modelGaps, splitSpec } from "./modelcheck.ts";
import { ChildLadder, childMaxTurns, climbHint, contextCap, topClimbHint, hasStrongRung, LadderState, ledgerLines, onBottomRung, RANK_CAPPED_REASON, revisionClimb, strongAbove, strongOnRevision, type Climb } from "./ladder.ts";
import { allowedExplicitModels, equalKeySentence, equalOnStrongRisk, explicitModelAllowed, explicitModelReason, launchedModels, normalModelSentence, rankDoctorFindings, rankRefusal, rankRefusalFor, rankTie, ranksOf, rolePolicy, rolesOfModel } from "./ranks.ts";
import type { RegistryLike } from "./modelcheck.ts";
import { countsForItems, launchOccasion, occasionLinesOf, occasionOf, reviewLaunchOf, OCCASIONS, reviewResultsOfRunEnd, runEndChildren, withOccasionMarker, type LaunchOccasion, type Occasion, type ReviewLaunch, type ReviewResult } from "./occasion.ts";
import { panelConfig, PendingPanels, primaryPanel, shadowInstruction, shadowLaunch, type ShadowDecision } from "./panel.ts";
import { closeLines } from "./reviewrounds.ts";
import { currentBranch, repoOf, workspaceKeyOf } from "./workspacekey.ts";
import { appendPrRow, diffLinesOf, filesOfDiff, findingsOfResult, onReviewRunEnd, planReviewFiles, RECORD_TIMEOUT_MS, type RunEndFindings } from "./findings.ts";
import { buildCeremonyState, CEREMONY_ENTRY, emptyCeremonyState, latestCeremonyState, persistedGate, type PersistedWork, type PlanPhaseOrigin, type WorkCount, restorableApproval, sentBackMark, sentBackRestore, sentBackUnmark, type CeremonyStateEntry } from "./planstate.ts";
import { PlanReviews, planDiffLines, planFactsBlock, planPathsOf, planReviewOn, planReviewRounds, planReviewRefusalText, planReviewResults, planReviewSection } from "./planreview.ts";
import { restoreRoundState, ROUND_STATE_FILE, roundStateDir, writeRoundState } from "./roundstate.ts";
import { launchEntries } from "./ladder.ts";
import { climbNotesOf, rungNote } from "./launchreceipt.ts";
import { liftSizing, mcpDescription, misplacedHint, subagentDescription, planSizing, prependProbe, rungOfModel, sizingConfig, sizingTrace, takeLaunchFlags, takeSizing, topModel as sizingTopModel, type EntryPlan, type RungContext } from "./sizing.ts";
import { ManifestRecorder, manifestOwner, recordEntries } from "./manifest.ts";
import { asyncRunDirs, bashOutputLogs, recordBashOutputLog, childSurface, hubWorkflowDirs, mainWorkflowReadable, ownTaskReadable, roundWorktrees, sessionOwnedSplit } from "./roundsurface.ts";
import { CustomSeen, isSubagentWake } from "./idlecustom.ts";
import { INTERCOM_MESSAGE_TYPE, INTERCOM_TOOL, intercomBlock, intercomDoctor, intercomInbound, intercomSender } from "./intercomguard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = fileURLToPath(import.meta.url);
const PKG_ROOT = path.resolve(HERE, "..", "..");
const CORE_DIR = path.join(PKG_ROOT, "core");
const BIN_DIR = path.join(PKG_ROOT, "bin");

/** Launch refusal trace fields: the roles launched and the call as `subagent <roles>`. */
/** The dir of the session's own Pi session file, or undefined (in-memory session, no file). */
function sessionDirOf(ctx: ExtensionContext): string | undefined {
  try {
    const f = ctx.sessionManager.getSessionFile();
    return typeof f === "string" && f && path.isAbsolute(f) ? path.dirname(f) : undefined;
  } catch {
    return undefined;
  }
}

function launchDeny(input: Record<string, unknown>): { role: string; command: string } {
  const roles = subagentAgents(input).join("+");
  return { role: roles, command: `subagent ${roles}`.trim() };
}
const ADAPTER_ID = "pi-foreman-core-adapter";
/** The id of the removed git-guard child extension: a `safety.requiredChildExtensions` entry with it is still filtered out so configs written for it load. */
const REMOVED_GIT_GUARD_ID = "pi-foreman-git-guard";
const ORIGINAL_PI_FOREMAN_PYTHON = process.env.PI_FOREMAN_PYTHON;

/** A ledger hint that failed after the rename retries: a `hint_write_failed` trace record, not a silent drop. */
const hintOpts = (s: Session): HintWriteOpts => hintFailTrace((rec) => s.trace?.emit(rec));

/** A hint write that waits for ledger.py work in flight on the same file (ledgerlock.ts), then re-reads the ledger. */
function writeHint(ledgerPath: string | null, cited: readonly string[], text: string, log?: HintLog, opts: HintWriteOpts = {}): void {
  if (!ledgerPath) return;
  ledgerGate(ledgerPath).defer(() => void writeHintNow(ledgerPath, cited, text, log, opts));
}

/** Holds taken by foreman bash calls that run `ledger`, by tool call id: released at tool_execution_end or session shutdown. */
const ledgerHolds = new Map<string, { gate: LedgerGate; key: string; sid: string }>();

function releaseLedgerHold(toolCallId: string): void {
  const h = ledgerHolds.get(toolCallId);
  if (!h) return;
  ledgerHolds.delete(toolCallId);
  h.gate.release(h.key);
}

/** Session entry type: one small record per review launch or launch that named a ledger (run id, paths, cited, and for a review its launch, items and occasion), so the route survives a reload (D31). */
const LEDGER_ROUTE_ENTRY = "pi-foreman-ledger-route";

/** The ledger path and cited items of each agent entry of a launch, in the result order of pi-subagents (parallel groups flattened). A review launch also carries its launch id, the ids its verdict tool accepts and its occasion (the record dir is derived from the launch id, never stored). */
interface LedgerRoute {
  paths: (string | null)[];
  cited: string[][];
  review?: { launch: string; items: ItemId[]; occasion: Occasion; shadow: boolean; failed?: boolean };
}

interface Session {
  id: string;
  cwd: string;
  isChild: boolean;
  agentDir: string;
  markerDir: string;
  python: PythonResolution;
  config: MergedConfig;
  /** Provider `config.roles` was resolved for (re-resolved on a provider switch). */
  configProvider: string | undefined;
  ceremony: CeremonyState;
  registration?: Registration;
  registrationError?: string;
  childExtensionErrors?: string[];
  /** Set when the permission system cannot be resolved: child launches are refused. */
  openPrs: OpenPrsRefresher | null;
  /** Dirs the foreman owns outside the workspace (owned.ts); the npm root joins once `npm root -g` resolved. */
  owned: OwnedRoots;
  /** True until `npm root -g` resolved or failed: a custom worktree root is not owned and `--worktree` open is refused meanwhile. */
  npmRootPending: boolean;
  registrationVia?: string;
  childExtensions: { id: string; path: string }[];
  stopContinued: boolean;
  /** The start note was handled (sent, or nothing qualified) for this process; the session entry covers a reload. */
  startNoteDone: boolean;
  /** The pi-foreman section text the last before_agent_start set (review N2: put back after a compaction). */
  foremanSection?: string;
  /** Orientation packet, built on the first foreman prompt ("" = none). */
  orientation?: string;
  notified: Set<string>;
  trace: TraceWriter | null;
  /** Runs this session launched (resume provenance, actions.ts). */
  runs: RunRegistry;
  /** Child runs launched by this session that have not ended (actions.ts trackActive; /sync and close refuse while any). */
  activeRuns: Set<string>;
  /** R11 item 5: tool call ids of subagent launches accepted at tool_call with no tool_result yet (finalization is off while any). */
  pendingLaunches: Set<string>;
  /** Foreman only: tool call ids of write/edit/shell calls between their tool_call and tool_result (capsReset waits while any: a parallel call cannot be seen before its self-write is marked). */
  mutating: Set<string>;
  /** Tool call ids of bash/powershell calls and of ask_user_question/plan_mode_question calls in flight (the warm tier reads them). */
  commandCalls: Set<string>;
  questionCalls: Set<string>;
  /** Tool call ids of every tool call between its tool_call and tool_result (the keep-alive warms while one runs even if a message is queued). */
  runningCalls: Set<string>;
  /** Foreman only: ms epoch of the last parent brief that lifted the caps (capsReset); persisted with reviewCount. */
  capsResetAt: number;
  /** Foreman bash calls made while a child run was active, since the last trace emit (D5; delta, reset on emit). */
  pollBash: number;
  /** Launch notices (strong model asked for but unmapped) by tool call id, added to the subagent result. */
  launchNotices: Map<string, string[]>;
  /** Open child supervisor requests (supervisor.ts). */
  supervisor: SupervisorWindow;
  /** Git config/hooks snapshot taken at child launches, checked before foreman git (gitdrift.ts). */
  gitDrift: GitDriftWatch;
  /** The git tool pack is on for this session (gitpack.ts). */
  gitPack: boolean;
  /** The PR tools are on for this session (gitpack.ts), their watches, and the context of the latest pr_watch call (for idle). */
  prPack: boolean;
  prWatches: PrWatches;
  prCtx: ExtensionContext | null;
  /** The host rule for the PR tools' `host` argument (prhost.ts). */
  prHost: PrHost;
  /** Foreman only: the pushed branches and their close-time notice (pushnotice.ts). */
  pushNotice: PushNotice;
  /** Foreman only: the external status hook (extstatus.ts); feeds the live file's `dots`. */
  extStatus: ExtStatus;
  /** Project Claude Code config snapshot, checked before claude-bridge prompts (claudedrift.ts). */
  claudeCfg: ClaudeConfigWatch;
  /** Usage log (usage.ts): file and the fields every line of this session carries. */
  usage: { file: string; line: LineContext };
  /** Launches this session recorded (launch id -> binding), for later kinds (revision, strong-relaunch). */
  launches: Map<string, LaunchBinding>;
  /** Foreman only: last trigger of the current run and its cache tokens, for the `turn` trace event. */
  turnSeq: number;
  checksCache: { current: PanelChecksCache | null };
  turn: { cause: TurnCause; cacheRead: number; cacheWrite: number; wakeKinds?: string; intercomFrom?: string; codemode?: boolean };
  /** Foreman only: launch calls of the current assistant message (launchwait.ts, knob 3). */
  launchBatch: LaunchBatch;
  /** Foreman only: run ids whose completion notice was deduplicated and traced (knob 5a; trace once per run). */
  dedupeTraced: Set<string>;
  /** Foreman only: first verdict (kept or dropped) per custom message sent to the model, so sent notices never change (notices.ts stableNoticeFilter). */
  noticeVerdicts: Map<string, boolean>;
  /** Async-started guidance lines trimmed from a held launch result, by run id (trace notify_deduped). */
  trimmedLines: Map<string, number>;
  /** Foreman only: whether a builder launch is a revision of reviewed work, since the last user prompt or /ceremony tier change (rounds.ts). */
  round: RoundState;
  /** Foreman only: session_start restored the reload file (roundstate.ts); from then on round state changes rewrite it. */
  roundStateOn: boolean;
  /** Foreman only, ceremony gate (bound.ts): own project-file changes at trivial, reset by /ceremony. */
  tally: Tally;
  /** Changes of gated calls that passed the bound check, by tool call id, counted at their result. */
  pendingChanges: Map<string, Change>;
  /** Every launch this session made (run id -> roles), single, chain and tasks. */
  launchedRoles: Map<string, string[]>;
  /** Required steps completed in this session (ceremony.required). */
  steps: StepCounts;
  /** The reviewer step under ceremony.reviewGate "pass" per checkout (reviewgates.ts; key "" = session-wide): latest verdict and a revision since (bound.ts). */
  reviewGates: ReviewGates;
  /** A parent sent the work back (rework marker, reworkScan) and no `[pre-pr]` PASS followed; the highest handled marker number (its own watermark). Both persisted in the ceremony entry. */
  sentBack: boolean;
  /** The heads a send-back covered that no `[pre-pr]` PASS on the head has cleared (planstate.ts sentBackMark); persisted beside the flag. */
  sentBackHeads: string[];
  reworkSeen: number;
  /** Finish refusals of the unchanged state `finishKey` (at most 2, then a forced pass); an owner prompt does not reset it. */
  finishRefusals: number;
  finishKey: string;
  /** The `ceremony incomplete` message was appended for this state key (once per key). */
  incompleteKey: string;
  /** Foreman work: builder launches or builder run ends, and project-file edits through its tools, and the count at the last owner prompt (a turn end with open ledger items and no new work is a pause). */
  work: WorkCount;
  workAtPrompt: WorkCount;
  /** What the session entry holds of work and refusals: written at an owner input and at a settle only, not on each edit. */
  pauseSaved: PersistedWork;
  /** A review reminder is queued for the next turn (one per pause). */
  reminderQueued: boolean;
  /** Foreman only: a handoff wait or a pending checkpoint waits for the parent/owner; the finish gate lets the turn end. Cleared by the next user/parent input. */
  waitingForParent: boolean;
  /** Foreman only: ids of the active waits that set waitingForParent (cleared with it). */
  handoffWaits: Set<string>;
  /** Foreman only: in-memory state of the questions that travel as intercom messages (intercomcarry.ts): the parent's records of its children's questions. */
  carry: IntercomCarry;
  /** Foreman only: a run is in progress (agent_start .. agent_end); a child notice that came as an intercom message is then already in it (wait.ts). */
  inRun: boolean;
  /** Foreman only: custom messages handled so far, so an idle-appended one is handled once at the next input (idlecustom.ts, ledger 11). */
  customSeen: CustomSeen;
  /** Needs-attention notices: ended runs (RUN_END_EVENTS) and what was shown (notices.ts, R12 item 9). */
  attention: AttentionNotices;
  /** Foreman only: per-item FAIL counts of reviewer runs (ladder.reviewerClimb, reviewerclimb.ts). */
  reviewerFails: ReviewerFails;
  /** Foreman only: the loop guard's stop (reviewloop.ts): builder and reviewer launches are refused while set; persisted in the ceremony-state entry (planstate.ts). */
  loopStop: LoopStop | null;
  /** Plan phase (persisted in the ceremony-state entry): .workflow-only writes, explorers without a ledger, no builder. Entered by PI_FOREMAN_PLAN_PHASE=1 or /foreman plan; left by a checkpoint approval, /foreman plan off, or below heavy in a phase a parent's launch started by the session's plan-review PASS. */
  planPhase: boolean;
  /** Who started the plan phase (persisted beside it): `parent` (a parent's launch, PI_FOREMAN_PLAN_PHASE=1 with a handoff dir) or `owner` (/foreman plan, or an entry without the field). */
  planPhaseOrigin: PlanPhaseOrigin;
  /** The ceremony-state entry last appended or restored, as JSON (an identical state is not appended again). */
  ceremonyEntry: string;
  /** restoreCeremonyState has read the branch: before that, a tier change must not append an entry that shadows the one to restore. */
  ceremonyRestored: boolean;
  /** Foreman only: item numbers of the last FAIL verdict, until a review passes (item-only re-review). */
  failItems: string[];
  /** Foreman only: critique raised and applied per review round (retro counter, rounds.ts CritiqueCounter). */
  critique: CritiqueCounter;
  /** Foreman only: the 80 % budget warning was given (ceremony.budgetUsd). */
  budgetWarned: boolean;
  /**
   * Foreman only: review launches (occasion.ts) by tool call id, then by run id; the panel's shadow
   * instruction of a run end; each run end's review results with their located findings (findings.ts); pending
   * findings records (the climb waits for them).
   */
  reviewRuns: { byCall: Map<string, ReviewLaunch>; byRun: Map<string, ReviewLaunch>; blocks: Map<string, { text: Promise<string>; claimed: boolean }>; findings: Map<string, Promise<RunEndFindings["byResult"]>>; sync: Promise<void> };
  /** Foreman only: review panels waiting for their shadow launches, by primary run id (panel.ts). */
  panels: PendingPanels;
  /** Foreman only: reviewer verdicts with the HEAD they covered, newest last, at most 50 (reviews.ts; the PR gate reads it). */
  reviews: ReviewRecord[];
  /** R26 item 3: the latest counted review verdict is FAIL and no owner prompt came since; the next reviewer launch is a re-review (ledgerblock.ts reReviewLine). */
  reviewFailOpen: boolean;
  /** The session-wide high-stakes state (highstakes.ts); persisted with the ceremony state. */
  hs: HighStakes;
  /** The sorted reason set the finish gate last held once for with the due-review reminder (persisted; not restored in a fork). */
  hsReminded: string[] | null;
  /** Subject changes to the bound ledger (added or rewritten items, a write or edit of the file); the ledger part of the repeat-review signal (persisted). */
  ledgerRev: number;
  /** Reason sets the finish let go with the review still due (memory; one owner notice each). */
  hsSkipped: Set<string>;
  /** Real path of the session's own checkout root (read once). */
  hsOwn: string | null;
  /** Pending HEAD reads of `reviews`; the PR gate waits for it. */
  reviewSync: Promise<void>;
  /** The PASS marks of the ledgers, in order; reviewSync waits for each (a slow ledger write does not wait for a snapshot's git). */
  markSync: Promise<void>;
  /** Foreman only: review runs whose record items were marked (reviewmarks.ts), so each run marks once. */
  reviewMarked: Set<string>;
  /** Foreman only: the verdict record of a review run, read once (verdictRecordOf); null = the run left none (or an invalid one). The file is renamed after the read. */
  reviewRecords: Map<string, VerdictRecord | null>;
  /** Foreman only: the ledger each agent entry of a launch named by path (ledgerpath.ts; null = none, the bound ledger) with the items it cites, by tool call, then by run id; the run records come back from the session entries after a reload. */
  ledgerByCall: Map<string, LedgerRoute>;
  ledgerByRun: Map<string, LedgerRoute>;
  /** Foreman only: the working tree at the latest review PASS per checkout (commentonly.ts; key "" = session-wide). */
  passSnaps: Record<string, TreeSnap>;
  /** Foreman only: builder runs, HEAD, tree and ledger at the latest review PASS per checkout; a reviewer launch is no repeat once one of them changed (bound.ts repeatSignals). */
  passMarks: Record<string, PassMark & { cwd: string }>;
  /** Foreman only: builder launches per checkout since the session began (memory; an unknown-root builder counts for all; a restore seeds each root from its mark). */
  builderRunsByRoot: Record<string, number>;
  /** Foreman only: the checkouts a builder run worked in, by run id (null = unknown); a resume of the run revises the same ones. Memory only. */
  builderRoots: Map<string, string[] | null>;
  /** Foreman only: the checkouts a reviewer launch covers, by tool call id until the launch result names the run (null = one is unknown). */
  reviewRootsByCall: Map<string, string[] | null>;
  /** Foreman only: the same by run id; the verdict at the run end is applied to these checkouts. Memory only. */
  reviewRoots: Map<string, string[] | null>;
  /** Foreman only: builder runs launched after a PASS (run id -> the one checkout they worked in); a comment-only result withdraws their revision there. */
  touchUps: Map<string, string>;
  /** Foreman only: HEAD per directory at launch, by tool call id until the launch result names the run. */
  launchHeadsByCall: Map<string, Map<string, string | null>>;
  /** Foreman only: HEAD per directory at launch, by run id until the run ends (reviews.ts reviewedHead). */
  launchHeads: Map<string, Map<string, string | null>>;
  /** Foreman only: the working-tree snapshot (tree id) per directory at launch, kept beside the heads above (reviews.ts reviewedHeadVia). */
  launchTreesByCall: Map<string, Map<string, string | null>>;
  launchTrees: Map<string, Map<string, string | null>>;
  /** Foreman only: the run-end state hint's start entry (readonlystate.ts) by tool call id until the launch result names the run, then by run id until the run ends. */
  readonlyStartByCall: Map<string, StartEntry>;
  readonlyStart: Map<string, StartEntry>;
  /** Foreman only: the tree roots a picture was taken for, by run id (a resume of that run reuses them). */
  readonlyRoots: Map<string, string[]>;
  /** Foreman only: the latest plan checkpoint (checkpoint.ts; in memory, a restart checkpoints again; a reload brings back only the owner's own dialog approval: from the session's ceremony-state entry, planstate.ts, and without a handoff dir also from the approval store). */
  plan: PlanRecord | null;
  /** The owner-script proposal and its approval (scriptapproval.ts): in memory only, so a reload or restart drops the approval. */
  script: ScriptState;
  /** A real owner-script run that outlived the abort of its tool call (scriptrun.ts detachOnAbort): runs on, ends through `done`; null when none. */
  scriptRun: { pid: number | undefined; since: number; stopRequested: boolean; shutdown: boolean; stop: ScriptRunDetached["stop"]; done: Promise<unknown> } | null;
  /** Foreman only: `[plan-review]` verdicts per plan lineage (planreview.ts; ceremony.planReview gates the checkpoint). */
  planReviews: PlanReviews;
  /** Foreman only: read budget (budget.ts), in memory only. */
  budget: ReadBudget;
  /** Read-budget warn notices by tool call id, added to the result. */
  readNotices: Map<string, string>;
  /** Child result locations from structured places only (budget.ts); a `read` of one or below one is exempt from the budget. */
  childFiles: Set<string>;
  /** Pi's truncated bash output logs (`details.fullOutputPath`) of this session's own bash calls (roundsurface.ts bashOutputLogs). */
  bashLogs: Set<string>;
  /** Foreman only: bash calls that run `ledger`, by tool call id until tool_execution_end (trace ledger_call). */
  ledgerBash: Set<string>;
  /** Foreman: rung per launch and climb-eligible runs (ladder.ts). Child: the once-only context steer. */
  ladder: LadderState;
  /** Foreman: ledger hints, compaction digest, auto-retro and /retro --model state (retro.ts). */
  retro: RetroState;
  childLadder: ChildLadder;
  /** Foreman: latest explorer report for the next builder launch (builderbrief.ts). Child: its read-class call count (childreads.ts). */
  brief: ExplorerBrief;
  childReads: ChildReads;
  /** Child scratch dirs of this session's launches (childscratch.ts). */
  scratch: ChildScratch;
  /** The worktree-side scratch location (`<root>/.foreman/scratch`) once the npm root resolved; null: the temp folder. Set together with `owned.childScratchRoot`. */
  scratchWt: ScratchWt | null;
  /** `child_scratch_root` was traced (at the first launch that created a lane). */
  scratchRootTraced?: boolean;
  /** Foreman only: the usage sync of stray Pi warm entries (keepalive.ts), the latest event context and assistant message time. */
  keepalive: KeepaliveLog;
  /** The warm owner (budget, cache touch, the idle warms of every cache; selfwarm.ts) and the presence gate (the presence probe runs in the foreman only). */
  selfWarm: SelfWarm;
  presence: Presence;
  idleCtx: ExtensionContext | null;
  lastAssistantAt: number | null;
  /** A turn is running (agent_start .. agent_settled): the warm tier's turn signal; the footer's cache bar shows the warms a fresh idle stretch would allow (`warmsFresh`) with the tier glyph. */
  running: boolean;
  /** Run view of the subagent launches (runs.ts). */
  childRuns: ChildRuns;
  /** Presence file (livestate.ts); null for a subagent child or a print/json run. */
  live: LiveState | null;
  /** The crash-restart note and the restart message (paneresume.ts); null without a presence file or outside a tui session. */
  paneResume: PaneResume | null;
  /** Plan publication for the side panel (show.ts); null without a presence file or with the scratch dir disabled. */
  show: Show | null;
  /** Foreman only: the pressure sampler timer (pressure.ts), and the launches queued behind the one that runs under high pressure (per assistant message). */
  pressureSampler: PressureSampler | null;
  pressureQ: { gen: number; entries: unknown[]; started: boolean } | null;
  /** Foreman only: the owner declined or dismissed a pressure override; cleared by the next owner prompt (input source interactive or rpc). */
  overrideDeclined: boolean;
  /** Foreman only: tool call ids whose launch the owner approved at critical load, with the launch arguments; settled at tool_execution_end (one approval, one launch). */
  overridden: Map<string, Record<string, unknown>>;
}

export interface AdapterDeps {
  spawner?: Spawner;
  platform?: string;
  /** Tests: the clock the pressure file's staleness is judged by. */
  pressureNow?: () => number;
  /** Tests: replaces the call of scripts/foreman_pressure.py (a fixture sampler); the args are its argv. */
  pressureRun?: (args: string[], signal?: AbortSignal) => Promise<{ ok: boolean; text: string }>;
  /** Tests: the running Pi version the doctor compares the add-on's peer range against (default: Pi's VERSION export). */
  piVersion?: () => Promise<string | null>;
  /** Tests: the child's MCP loader root and import, and the SDK's createMcpExtension (mcpchild.ts). */
  mcpChild?: Partial<Pick<McpChildOpts, "resolveRoot" | "importFile" | "createMcp" | "env">>;
  /** Tests: the working-tree snapshot taken at a reviewer launch (default: commentonly.ts worktreeTree); the shared rigs pass a no-op, so the run end keeps head_moved. */
  worktreeSnapshot?: (cwd: string) => Promise<string | null>;
  /** Tests: replaces Pi's shell resolution, used by the read question's entry condition (is the bash tool's shell a bash) and the win32 background-shell setup (default: Pi's getShellConfig). */
  getShellConfig?: ShellConfigFn;
  /** Tests: the environment the bundled add-on's start defaults (PI_BG_*) are written to (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** Tests: replaces the git runs of the run-end state pictures (default: readonlystate.ts spawnGit). */
  readonlyGit?: GitRunner;
  /** Tests: the deadline of one picture set in ms (default 20 s). */
  readonlyDeadlineMs?: number;
}

export default function coreAdapter(pi: ExtensionAPI, deps: AdapterDeps = {}): void {
  const spawner = deps.spawner ?? defaultSpawner;
  const platform = deps.platform ?? process.platform;
  const launchSnapshot = deps.worktreeSnapshot ?? worktreeTree;
  const readonlyGit = deps.readonlyGit ?? spawnGit;
  // Deferred tool declarations (deferred.ts): the hidden set is fixed at session start; the harness tool_search finds hidden tools and un-hides one only without codemode.
  const deferred = { patterns: [] as string[], loaded: new Set<string>(), hidden: [] as string[], planMode: false, warnings: [] as string[], hint: "", trace: (_r: Record<string, unknown>): void => {} };
  // The model-only tools line (deferred.ts): built at the first request of a session, then fixed so the prefix stays byte-stable.
  const modelOnly = { done: false, hint: "" };
  // Skill visibility (skillvisibility.ts): the split is made once per session so the prefix stays stable.
  const skillState = { rules: { visible: [], hidden: [] } as SkillRules, hidden: [] as SkillRef[], split: false, hint: "" };
  let toolUsage = new ToolUsageTracker(); // replaced at every session_start: /new and /resume reuse this load
  const persistDeferred = (): void => {
    try {
      pi.appendEntry(DEFERRED_ENTRY, { names: [...deferred.loaded], planMode: deferred.planMode });
    } catch {
      // the session file is not writable now: the state stays in memory
    }
  };
  const core = claimCore(PKG_ROOT); // once-guard (registry.ts): a second copy from another root registers only a notice
  if ("notice" in core) return installInert(pi, core.notice);
  // The bundled pi-background-tasks add-on reads PI_BG_* in its own factory, which loads after this one (package.json order): set its defaults now, before any await (win32: also the shell)
  const bgEnv = deps.env ?? process.env;
  applyBgAddonDefaults(bgEnv);
  const bgShell = platform === "win32" ? resolveBgShell({ platform, env: bgEnv, getShellConfig: deps.getShellConfig ?? piGetShellConfig, shellPath: shellPathSetting(piAgentDir(process.env, os.homedir()), process.cwd()) }) : { set: false, noBash: false };
  // The tool_search exists in every session of the real copy, so a child allowlisting it never fails at agent_start; an inert copy registers none (it would replace this one).
  pi.registerTool(createToolSearchTool({
    host: pi as never,
    hidden: () => deferred.hidden,
    skills: () => skillState.hidden,
    unhide: (names) => {
      for (const n of names) deferred.loaded.add(n);
      deferred.hidden = deferred.hidden.filter((n) => !deferred.loaded.has(n));
      persistDeferred();
    },
    found: (hit) => {
      toolUsage.noteFound(hit.name);
      deferred.trace({ event: "tool_found", ...hit });
    },
  }) as never);
  let remoteWatch: RemoteWatcher | null = null; // hc events watcher of the remote children (remotewatch.ts), a foreman session only
  let childBlocked: ChildBlocked | null = null; // the parent's notice that a child session waits on the owner (childblocked.ts), a foreman session only
  pi.on("session_shutdown", async () => {
    remoteWatch?.stop();
    remoteWatch = null;
    childBlocked?.stop();
    childBlocked = null;
    core.release();
  });
  // Before any session_start (pi-intercom reads PI_INTERCOM_STABLE_ID when it connects): review S6.
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    stripChildIntercomEnv(process.env);
    stripChildCdEnv(process.env); // review D-B2
  }
  const pythonCache = new PythonCache();
  const sessions = new Map<string, Session>();
  let userPickedModel = false;
  let applyingModel = false;
  /** Idle model downshift (idlemodel.ts): one instance per extension load, bound to the session and context of the latest event. */
  let idleBind: { s: Session; ctx: ExtensionContext } | null = null;
  const idleModel = new IdleModel({
    now: () => Date.now(),
    enabled: () => !!idleBind && !idleBind.s.isChild && get(idleBind.s.config.config, "ladder.idleDownshift.enabled") !== false,
    causes: () => {
      const c = idleBind ? get(idleBind.s.config.config, "ladder.idleDownshift.causes") : null;
      return Array.isArray(c) ? c.map(String) : ["child", "wake", "intercom", "other"];
    },
    rung: () => {
      const r = (idleBind?.s.config.roles.foreman as { idle?: { model?: unknown; thinking?: unknown } } | undefined)?.idle;
      return r && typeof r.model === "string" && r.model ? { model: r.model, thinking: typeof r.thinking === "string" && r.thinking ? r.thinking : null } : null;
    },
    current: () => (idleBind?.ctx.model ? { provider: idleBind.ctx.model.provider, id: idleBind.ctx.model.id } : null),
    thinking: () => pi.getThinkingLevel(),
    find: (spec) => {
      const slash = spec.indexOf("/");
      return idleBind?.ctx.modelRegistry.find(slash > 0 ? spec.slice(0, slash) : idleBind.ctx.model?.provider ?? "", slash > 0 ? spec.slice(slash + 1) : spec) as never;
    },
    findRef: (r) => idleBind?.ctx.modelRegistry.find(r.provider, r.id) as never,
    switchTo: async (model, thinking) => {
      applyingModel = true;
      try {
        const ok = await pi.setModel(model as never);
        if (ok && thinking) pi.setThinkingLevel(thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
        return ok;
      } catch {
        return false;
      } finally {
        applyingModel = false;
      }
    },
    coldAt: () => {
      const m = idleBind?.ctx.model;
      const ttl = idleBind && m ? resolveWarmPolicy(idleBind.s.config.config, m.provider, m.id, bridgeTtlS).ttlSeconds : null;
      if (!idleBind || typeof ttl !== "number") return Infinity;
      const touch = idleBind.s.selfWarm.lastCacheTouch();
      return touch === null ? 0 : coldAtTouch(touch, ttl); // no touch = a compaction or model change dropped the cache
    },
    persist: (e) => pi.appendEntry(IDLE_ENTRY, e),
    trace: (r) => idleBind?.s.trace?.emit(r),
    glyph: (g) => {
      const ctx = idleBind?.s.idleCtx ?? idleBind?.ctx;
      if (ctx && idleBind) cacheStatus(ctx, g !== null, g ? symbolSet(get(idleBind.s.config.config, "ui.symbols"))[g] : "");
    },
  });
  /** The model the foreman's gates (review rule, rank checks, panel) judge: the base while downshifted, else the current model. */
  const foremanBaseModel = (ctx: ExtensionContext): string | null => idleModel.baseModel(ctx.model);
  /** Raw state for the footer's cache bar (footer.ts CacheSource): read-only, nothing is sent. */
  const cacheSourceOf = (s: Session, model: { id: string; provider?: string } | undefined): CacheSource | null => {
    if (!model) return null;
    const policy = resolveWarmPolicy(s.config.config, model.provider, model.id, bridgeTtlS);
    const snap = s.selfWarm.snapshot();
    const rung = idleModel.idleRung();
    return {
      policy,
      now: Date.now(),
      lastTouch: s.selfWarm.lastCacheTouch(),
      stretchStartAt: snap.stretchStartAt,
      nextWarmAt: snap.state === "watching" && snap.budget ? snap.nextWarmAt : null,
      spanEndAt: snap.spanEndAt,
      warmsLeft: snap.warmsLeft,
      warmsFresh: snap.warmsFresh,
      endedBy: snap.endedBy,
      tier: snap.tier ? snap.tier.tier : null,
      running: s.running,
      waiting: s.questionCalls.size > 0 || s.live?.isBlocked() === true,
      downshifted: idleModel.downshifted(),
      idleRung: rung ? rung.id : null,
      enabled: get(s.config.config, "footer.cacheBar") !== false,
      symbols: String(get(s.config.config, "ui.symbols") ?? "unicode"),
    };
  };
  let instructionsCache: string | null | undefined;
  let reviewerInstructionsCache: string | null | undefined;
  const bridgeIso = new BridgeIsolation();
  const bridgeTtl = new BridgeCacheTtl();
  let ttlSetting: BridgeTtlSetting = bridgeTtlSetting(undefined);
  /** Derived claude-bridge TTL of this process kind (bridgettl.ts); set at session start, null = no derived value. */
  let bridgeTtlS: number | null = null;
  const reviewFacts = new ReviewFacts();
  const usageFooter = new UsageFooter(loadPrices(PKG_ROOT), (model) => piRuntimePoint(model));
  /** Priced run cost per usage file, cached by size and mtime (the run list keeps only 64 rows and loses its total on restart). */
  const runsCostCache = new Map<string, { sig: string; runs: number }>();
  /** The summed estimate (lane 3b): the foreman's own list-price cost plus every run's priced cost, read from the session's usage file. */
  function summedCost(s: Session): { foreman: number; runs: number; total: number } {
    const foreman = usageFooter.totalsOf(s.id)?.cost ?? 0;
    let runs = 0;
    try {
      const st = fs.statSync(s.usage.file);
      const sig = `${st.size}:${st.mtimeMs}`;
      const hit = runsCostCache.get(s.usage.file);
      if (hit && hit.sig === sig) runs = hit.runs;
      else {
        const lines = readUsage(s.agentDir, { session: s.usage.line.foremanSession }).filter((l) => l.kind !== "foreman");
        runs = aggregate(lines, loadPrices(PKG_ROOT)).total.cost.total;
        runsCostCache.set(s.usage.file, { sig, runs });
      }
    } catch {
      // no usage file yet: no run cost
    }
    return { foreman, runs, total: foreman + runs };
  }
  const compactionGate = new CompactionGate();
  /** R39: per launch call, the roles that stayed on the bottom rung although a strong climb was asked or wanted, with the reason the receipt shows. */
  const bottomNotes = new Map<string, Map<string, string>>();
  /** Per launch call, the roles' rung phrase from the ladder's climbs and the sizing plans (launchreceipt.ts); read and deleted with bottomNotes. */
  const climbNotes = new Map<string, Map<string, string>>();
  /** Per launch call, the occasions its review children were recorded with (taken before any rewrite); read and deleted at the tool result for the occasion lines. */
  const launchOccasions = new Map<string, Occasion[]>();
  /** The ledger items a launch cited, taken before the high-stakes findings block went into its task (for the ledger notes at the tool result). */
  const hsCited = new Map<string, string[]>();
  /** Tool call ids of `subagent` launches that carried size/risk outside the top level (sizing.ts liftSizing); read at their tool_result. */
  const misplacedSizing = new Set<string>();
  herdrEvents = pi.events as EventBus | undefined;
  // Herdr blocked shim (herdr.ts); `blockedShim.onChange((active) => ...)` can feed other consumers.
  const blockedShim = installBlockedShim(pi, { enabled: () => [...sessions.values()].every((x) => get(x.config.config, "herdr.blockedShim") !== false) });
  // Own asks hold each session's presence blocked directly (Pi can suppress ui_prompt_start, see herdr.ts).
  // The hook also records blocked_open / blocked_closed (trace) for every own source: who it waits on, its kind word, its short label, and how long it waited.
  /** Per session, the owner-class own sources open now: the one event per dialog comes from the classed source, so Pi's prompt events add one only for a dialog nobody classed (a wait on the parent does not mute them). */
  const classedOpen = new Map<string, number>();
  /** Per session, the parent-class own sources open now and when the first opened: a child's wait on its parent's ruling, read by the warm tier. */
  const parentOpen = new Map<string, { n: number; since: number }>();
  blockedShim.onOwnOn((label, cls) => {
    const held = [...sessions.values()].map((s) => ({ s, release: s.live?.holdOn(cls) }));
    const rec = { on: cls?.on ?? "owner", kind: cls?.kind ?? "dialog", label: cleanLabel(label) };
    const opened = Date.now();
    for (const h of held) {
      if (rec.on === "parent") {
        const p = parentOpen.get(h.s.id);
        parentOpen.set(h.s.id, { n: (p?.n ?? 0) + 1, since: p?.since ?? opened });
      }
      if (rec.on === "owner") classedOpen.set(h.s.id, (classedOpen.get(h.s.id) ?? 0) + 1);
      h.s.trace?.emit({ event: "blocked_open", ...rec });
    }
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      for (const h of held) {
        if (rec.on === "parent") {
          const p = parentOpen.get(h.s.id);
          if (p && p.n > 1) parentOpen.set(h.s.id, { n: p.n - 1, since: p.since });
          else parentOpen.delete(h.s.id);
        }
        if (rec.on === "owner") {
          const n = (classedOpen.get(h.s.id) ?? 1) - 1;
          if (n > 0) classedOpen.set(h.s.id, n);
          else classedOpen.delete(h.s.id);
        }
        h.release?.();
        h.s.trace?.emit({ event: "blocked_closed", ...rec, waitedMs: Date.now() - opened });
      }
    };
  });
  const uiLabels = new Map<string, string>();
  // A question tool call holds an own blocked source from tool_call to tool_execution_end, independent of Pi's ui_prompt_* events (Pi suppresses them under a stuck dialog depth).
  const questionBlocks = new Map<string, () => void>();
  const holdQuestion = (id: string, input: unknown): void => {
    questionBlocks.get(id)?.();
    const first = (input as { questions?: { header?: unknown }[] } | undefined)?.questions?.[0]?.header;
    const label = typeof first === "string" && first.trim() ? first : "question";
    questionBlocks.set(id, blockedShim.ownOn(label, { on: "owner", kind: "question" }));
  };
  const releaseQuestion = (id: string): void => {
    const release = questionBlocks.get(id);
    questionBlocks.delete(id);
    release?.();
  };
  let bgTrace: (rec: Record<string, unknown>) => void = () => undefined;
  installBgRecords(pi, { platform: deps.platform ?? process.platform, trace: (r) => bgTrace(r) }); // hc records for the add-on's background tasks (bgrecords.ts)
  const herdrMeta = installHerdrMeta(pi); // group tag (herdrmeta.ts), started at the end of session_start
  const sidebarLive = installSidebarLive(pi); // session-owned Herdr sidebar row (sidebarlive.ts), same place
  const askFlag = new AskFlag(); // /foreman flag-ask (askflag.ts): the last ask the owner answered
  const radarTouch = (s: Session | undefined, _ctx: ExtensionContext): void => {
    if (!s) return;
    s.live?.touch();
  };
  pi.on("agent_start", async (_e, ctx) => {
    const s = sessionFor(ctx);
    s?.live?.onAgentStart();
    radarTouch(s, ctx);
  });
  // Pi's prompt events are the `ui` choke point: the live state's blocker and, through the single-key rule (herdr.ts uiKeyAction), its owner key.
  const uiClosed = (s: Session, r: { waitedMs?: number } | undefined): void => {
    if (r?.waitedMs === undefined || !uiLabels.has(s.id)) return; // only a dialog this path opened
    s.trace?.emit({ event: "blocked_closed", on: "owner", kind: "dialog", label: uiLabels.get(s.id) ?? "dialog", waitedMs: r.waitedMs });
    uiLabels.delete(s.id);
  };
  pi.on("ui_prompt_start", async (e, ctx) => {
    const s = sessionFor(ctx);
    s?.live?.setBlocked(true);
    if (!s || !s.live?.uiKey("prompt_start").opened) return;
    const p = e as { title?: unknown; kind?: unknown };
    const label = cleanLabel(typeof p.title === "string" && p.title.trim() ? p.title : typeof p.kind === "string" ? p.kind : "dialog");
    if (classedOpen.has(s.id)) return; // an owner-class own source of this session is open: it emits the pair
    uiLabels.set(s.id, label);
    s.trace?.emit({ event: "blocked_open", on: "owner", kind: "dialog", label });
  });
  pi.on("ui_prompt_end", async (_e, ctx) => {
    const s = sessionFor(ctx);
    s?.live?.setBlocked(false);
    if (s) uiClosed(s, s.live?.uiKey("prompt_end"));
  });
  // orphaned dialog (see herdr.ts): Pi may swallow ui_prompt_end, so any input or the end of the turn also clears the "ui" source
  // (the owner key only on typed input: an extension's input and a turn end keep it while a dialog may still be open)
  pi.on("input", async (e, ctx) => {
    const s = sessionFor(ctx);
    s?.live?.setBlocked(false);
    if (s) uiClosed(s, s.live?.uiKey("input", (e as { source?: unknown }).source));
    if (s && (e as { source?: string }).source !== "extension") gateStopped.delete(s.id); // a new user prompt ends a "deny and stop"
  });
  pi.on("agent_end", async (_e, ctx) => {
    const s = sessionFor(ctx);
    s?.live?.setBlocked(false);
    s?.questionCalls.forEach(releaseQuestion);
  });
  let isoSetting: unknown = "auto";
  // A child's launch binding is in the env while its extensions load (usage.ts); read it now. A child removes it from its env
  // after the read, so a pi it starts has no role; the foreman's env stays as it is.
  const launchBinding = process.env.PI_SUBAGENT_CHILD === "1" ? takeBinding(process.env) : readBinding(process.env);
  if (process.env.PI_SUBAGENT_CHILD === "1" && launchBinding?.scratch) process.env[SCRATCH_ENV] = launchBinding.scratch;
  if (process.env.PI_SUBAGENT_CHILD === "1" && launchBinding?.out) process.env[OUT_ENV] = launchBinding.out;
  /** A child's write roots of this kind: its scratch dir first, then its kept output dir (`$FOREMAN_OUT`). */
  const childScratchDirs = launchBinding?.scratch ? [launchBinding.scratch, ...(launchBinding.out ? [launchBinding.out] : [])] : [];
  // a worktree child gets the foreman's checkout in its env
  if (process.env.PI_SUBAGENT_CHILD === "1") Object.assign(process.env, checkoutEnv(launchBinding));
  // r68: the child's MCP scope. The binding is captured here; the allowed set is computed from it in session_start (never from env later).
  const mcpChild = process.env.PI_SUBAGENT_CHILD === "1" ? new McpChild(pi, { binding: launchBinding ? { role: launchBinding.role, ...(launchBinding.mcp ? { mcp: launchBinding.mcp } : {}) } : null, hiddenSkills: () => skillState.hidden.length, ...(deps.mcpChild ?? {}) }) : null;

  const pyPath = (s: Session): string | null => (s.python.ok ? s.python.info.executable : null);

  const notifyOnce = (s: Session, ctx: ExtensionContext, key: string, msg: string, level: "info" | "warning" | "error" = "warning"): void => {
    if (s.notified.has(key)) return;
    s.notified.add(key);
    ctx.ui.notify(msg, level);
  };

  const prevHeartbeats = new Map<string, number | null>();

  async function startSession(ctx: ExtensionContext): Promise<Session> {
    const id = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;
    const home = os.homedir();
    const agentDir = piAgentDir(process.env, home);
    const trusted = safeTrusted(ctx);
    let markerDir = path.join(agentDir, "pi-foreman", "state");
    try {
      fs.mkdirSync(markerDir, { recursive: true });
    } catch {
      markerDir = os.tmpdir();
    }

    const hint = pythonPathHint(PKG_ROOT, agentDir);
    let python = await pythonCache.get(id, () => resolvePython({ configPath: hint, envPath: ORIGINAL_PI_FOREMAN_PYTHON, platform, spawner, cwd }));
    const provider = ctx.model?.provider;
    const config = await loadMergedConfig({ python: python.ok ? python.info.executable : null, pkgRoot: PKG_ROOT, provider, agentDir, projectDir: cwd, trusted, spawner });
    const merged = get(config.config, "python.path");
    if (typeof merged === "string" && merged.trim() && merged !== hint) {
      // python.path came from a layer the hint does not read (L3): honour it.
      pythonCache.drop(id);
      python = await pythonCache.get(id, () => resolvePython({ configPath: merged, envPath: ORIGINAL_PI_FOREMAN_PYTHON, platform, spawner, cwd }));
    }

    const isChild = process.env.PI_SUBAGENT_CHILD === "1";
    const b = isChild ? launchBinding : null;
    const foremanSession = isChild ? b?.foremanSession ?? process.env[PARENT_SESSION_ENV] ?? id : id;
    const line: LineContext = { workspace: b?.workspace || workspaceOf(cwd).root, foremanSession, role: isChild ? b?.role ?? "child" : "foreman", launchId: b?.launchId ?? null, kind: isChild ? b?.kind ?? "first" : "foreman" };
    const selfHost = isSelfHost(cwd, PKG_ROOT);
    // Owned dirs (owned.ts): the npm root resolves in the background and is added once known.
    const tmpRoot = path.dirname(scratchRoot() ?? path.join(os.tmpdir(), "pi-foreman-scratch"));
    // close.worktreeDir (worktreeroot.ts): only a session in the main checkout takes it; a refused value or a collision falls back to the default layout with one visible notice
    // the Pi install root and the global npm root are protected roots only this side knows; the npm root joins when it resolves (below)
    const installRoot = await installRootOfPi();
    const rootInputsOf = (npmRoot: string | null) => sessionRootInputs(cwd, get(config.config, "close.worktreeDir"), { installRoot, npmRoot });
    // unresolved until the npm root is known (or failed): no owned custom root, so a root under the npm root is never briefly owned
    let rootInputs: ReturnType<typeof rootInputsOf> = {};
    // the child scratch base: the temp folder (null) until the npm root is known, then `<worktree root>/.foreman/scratch` when the session has a usable root
    let scratchWtNow: ScratchWt | null = null;
    const computeOwned = (npmRoot: string | null, resolved = true): OwnedRoots => {
      if (resolved) {
        rootInputs = rootInputsOf(npmRoot);
        const root = sessionScratchRoot(cwd, get(config.config, "close.worktreeDir"), { installRoot, npmRoot });
        scratchWtNow = root ? { root, base: wtScratchBase(root), failed: false } : null;
      }
      // while pending: block globs are always safe to add early; only the owned root waits
      const globs = resolved ? rootInputs.worktreeGlobs : rootInputsOf(null).worktreeGlobs;
      return ownedRoots({ agentDir, workspaceRoot: workspaceOf(cwd).root, tmpRoot, ...(scratchWtNow ? { scratchBase: scratchWtNow.base } : {}), npmRoot, worktreeRoot: rootInputs.worktreeRoot, worktreeGlobs: globs });
    };
    const owned = computeOwned(null, false);
    const warm = createWarm({ pi, pkgRoot: PKG_ROOT, isChild, bridgeTtl: () => bridgeTtlS, ctx: () => s.idleCtx, config: () => s.config.config, usage: () => s.usage, trace: (r) => s.trace?.emit(r), signals: () => warmSignals(s), queued: () => warmQueued(s), compact: () => idleCompact(s), contextTokens: () => s.idleCtx?.getContextUsage()?.tokens ?? null, contextWindow: () => s.idleCtx?.getContextUsage()?.contextWindow ?? null, driftPending: () => warmDriftPending(s), hidden: () => deferred.hidden, setGlyph: (on) => { if (s.isChild) return; if (s.idleCtx) idleBind = { s, ctx: s.idleCtx }; idleModel.setWarming(on); } });
    // A child foreman session (handoff dir set) says once per merged PR that it stays open (close.ts mergeNotifier); a merge never starts a close.
    const mergeNotice = mergeNotifier({
      handoff: process.env[HANDOFF_DIR_ENV],
      get parent() { return parentIntercomId(process.env); },
      remote: process.env[REMOTE_PARENT_ENV] === "1",
      notify: (text) => s.prCtx?.ui.notify(text, "info"),
      reply: (to, text) => outboxSend(pi.events, to, text, "close"),
      trace: (r) => s.trace?.emit(r),
    });
    const s: Session = {
      id,
      cwd,
      isChild,
      agentDir,
      markerDir,
      python,
      config,
      configProvider: provider,
      owned,
      npmRootPending: true,
      ceremony: initialCeremony(get(config.config, "ceremony.default")),
      childExtensions: [],
      stopContinued: false,
      startNoteDone: false,
      notified: new Set(),
      runs: new Map(),
      activeRuns: new Set(),
      pendingLaunches: new Set(),
      mutating: new Set(),
      commandCalls: new Set(),
      questionCalls: new Set(),
      runningCalls: new Set(),
      capsResetAt: 0,
      pollBash: 0,
      launchNotices: new Map(),
      supervisor: new SupervisorWindow(),
      gitDrift: new GitDriftWatch(),
      gitPack: false,
      prPack: false,
      prCtx: null,
      prWatches: new PrWatches({
        storeEntry: (key) => readStoreEntry(agentDir, key, Date.now(), prFeedOn(s), resolveGithubHosts(s.config.config)),
        githubHosts: () => resolveGithubHosts(s.config.config),
        wakeRules: () => parseWakeRules(get(s.config.config, "tools.prWake")).rules,
        retrack: async (key) => {
          const hosts = resolveGithubHosts(s.config.config);
          if ("hosts" in hosts && isTrackedKey(key, hosts.hosts) && prFeedOn(s)) await addTracked(agentDir, key.repo, key.n, undefined, key.host);
        },
        reviewedHeads: () => passHeads(s.reviews),
        reviewGate: () => get(s.config.config, "ceremony.reviewBeforePr") !== false,
        // the readiness rule (prready.ts)
        reviewFacts: (head) => {
          // an open PR is not ready while a high-stakes pass is due or a FAIL stands (session-wide: the head alone does not name its checkout)
          return holdFacts(reviewFactsForHead(s.reviews, head, s.sentBackHeads), hsModel(s) ? readyOverride(s.hs.state(), hsDue(s), head) : null);
        },
        tick: () => reworkScan(s),
        draftFlow: () => draftFlowOn(s),
        draft: (key, cwd, draft) => prRun(s, cwd, "pr_draft", { number: key.n, repo: key.repo, ...(key.host ? { host: key.host } : {}), draft }, 30_000),
        label: (key, cwd, label, on) => prRun(s, cwd, "pr_label", { number: key.n, repo: key.repo, ...(key.host ? { host: key.host } : {}), label, on }, 30_000),
        readyLabel: () => {
          const v = get(s.config.config, "tools.prReadyLabel");
          return typeof v === "string" ? v : "";
        },
        cwd: () => s.prCtx?.cwd ?? s.cwd,
        child: () => !!process.env.PI_FOREMAN_HANDOFF_DIR?.trim(),
        fresh: async (key, cwd) => {
          const o = await prRun(s, cwd ?? s.prCtx?.cwd ?? s.cwd, "pr_status", { number: key.n, ...(key.repo ? { repo: key.repo, ...(key.host ? { host: key.host } : {}) } : {}) });
          const st = o.kind === "ran" ? o.result.state : null;
          return st === "open" || st === "merged" || st === "closed" ? st : "unknown";
        },
        // A merged PR is announced once (child pane and intercom parent); the session closes only on a close request.
        onMerged: (info) => mergeNotice(info.key.n),
        returnToBase: ({ key, cwd }) => {
          const dir = cwd || (s.prCtx?.cwd ?? s.cwd);
          return mergedReturn({
            enabled: () => get(s.config.config, "tools.prReturnToBase") !== false,
            sessionCwd: () => s.cwd,
            busy: () => s.activeRuns.size > 0 || s.pendingLaunches.size > 0,
            git: realGit,
            status: (n) => prRun(s, dir, "pr_status", { number: n, ...(key.repo ? { repo: key.repo, ...(key.host ? { host: key.host } : {}) } : {}) }),
          }, { cwd: dir, number: key.n });
        },
        notice: (text) => s.prCtx?.ui.notify(text, "info"),
        milestone: (kind, n) => s.show?.milestone(kind, `PR #${n} ${kind === "pr_opened" ? "opened" : kind === "pr_ready" ? "is ready to merge" : "was merged"}`),
        rememberMerged: () => !!process.env[HANDOFF_DIR_ENV]?.trim(),
        persist: (watches, merged) => pi.appendEntry(PRWATCH_ENTRY, { v: 2, piSessionId: s.id, watches, ...(merged.length ? { merged } : {}) }),
        send: (msg, idle) => pi.sendMessage(msg, idle ? { triggerTurn: true } : { deliverAs: "followUp" }),
        idle: () => s.prCtx?.isIdle() ?? true,
        trace: (r) => s.trace?.emit(r),
        intervalMs: () => watchIntervalMs(get(s.config.config, "tools.prWatchSeconds")),
        settleMs: () => settleMsOf(get(s.config.config, "tools.prSettleSeconds")),
        now: () => Date.now(),
        changed: () => s.live?.touch(),
      }),
      prHost: new PrHost({ run: (op, args, cwd) => prRun(s, cwd ?? s.prCtx?.cwd ?? s.cwd, op, args, 30_000) }),
      pushNotice: new PushNotice({
        enabled: () => s.prPack && !s.isChild,
        run: (op, args, cwd) => prRun(s, cwd ?? s.prCtx?.cwd ?? s.cwd, op, args, 30_000),
        baseBranch: () => {
          const b = get(s.config.config, "safety.ops.baseBranch");
          return typeof b === "string" && b ? b : null;
        },
        merged: async (cwd, remote, name) => {
          const ref = [`refs/remotes/${remote}/${name}`, `refs/heads/${name}`];
          let found: string | null = null;
          for (const r of ref) if (!found && (await git(cwd, ["rev-parse", "--verify", "--quiet", r]))) found = r;
          if (!found) return null;
          const base = get(s.config.config, "safety.ops.baseBranch");
          const r = await runScript(s, "foreman_close.py", ["merged", "--ws", cwd, "--ref", found, ...(typeof base === "string" && base ? ["--base", base] : [])], 20_000);
          try {
            const v = (JSON.parse(r.text) as { merged?: unknown }).merged;
            return typeof v === "boolean" ? v : null;
          } catch {
            return null;
          }
        },
      }),
      extStatus: new ExtStatus({
        enabled: () => !s.isChild && s.live !== null,
        command: () => {
          const c = get(s.config.config, "sidebar.statusCommand");
          return typeof c === "string" && c.trim() ? c : null;
        },
        intervalMs: () => (typeof get(s.config.config, "sidebar.statusSeconds") === "number" ? Math.min(3600, Math.max(10, get(s.config.config, "sidebar.statusSeconds") as number)) : 60) * 1000,
        workspace: () => workspaceOf(s.cwd).root,
        cwd: () => s.cwd,
        sessionId: () => s.id,
        branch: () => branchOf(s.cwd),
        env: process.env,
        platform,
        trace: (r) => s.trace?.emit(r),
        changed: () => s.live?.touch(),
      }),
      claudeCfg: new ClaudeConfigWatch(),
      trace: ((t) => openTrace({ enabled: t.enabled, dir: get(config.config, "trace.dir"), stateDir: markerDir, sessionId: t.id, base: t.base }))(sessionTrace(get(config.config, "trace.enabled"), get(config.config, "retro.enabled"), ctx.mode, id, b)),
      usage: { file: usageFile(agentDir, foremanSession), line },
      launches: new Map(),
      turnSeq: 0,
      checksCache: { current: null },
      turn: { cause: "other", cacheRead: 0, cacheWrite: 0 },
      round: initialRounds(),
      roundStateOn: false,
      tally: emptyTally(),
      pendingChanges: new Map(),
      launchedRoles: new Map(),
      steps: emptySteps(),
      reviewGates: {},
      sentBack: false,
      sentBackHeads: [],
      reworkSeen: 0,
      finishRefusals: 0,
      finishKey: "",
      incompleteKey: "",
      work: { builders: 0, edits: 0 },
      workAtPrompt: { builders: 0, edits: 0 },
      pauseSaved: { work: { builders: 0, edits: 0 }, atPrompt: { builders: 0, edits: 0 }, refusals: null },
      reminderQueued: false,
      waitingForParent: false,
      handoffWaits: new Set(),
      carry: new IntercomCarry(),
      inRun: false,
      customSeen: new CustomSeen(),
      attention: new AttentionNotices(),
      reviewerFails: new ReviewerFails(),
      loopStop: null,
      planPhase: !isChild && process.env.PI_FOREMAN_PLAN_PHASE === "1",
      planPhaseOrigin: process.env.PI_FOREMAN_PLAN_PHASE === "1" && !!process.env.PI_FOREMAN_HANDOFF_DIR?.trim() ? "parent" : "owner",
      ceremonyEntry: JSON.stringify(emptyCeremonyState()),
      ceremonyRestored: false,
      failItems: [],
      critique: new CritiqueCounter(),
      budgetWarned: false,
      reviewRuns: { byCall: new Map(), byRun: new Map(), blocks: new Map(), findings: new Map(), sync: Promise.resolve() },
      panels: new PendingPanels({ send: (text) => pi.sendMessage({ customType: "pi-foreman-panel", content: text, display: true }, { triggerTurn: false }), trace: (r) => s.trace?.emit(r), extra: () => prChecksLine(s) }),
      reviews: [],
      reviewFailOpen: false,
      hs: new HighStakes(),
      hsReminded: null,
      ledgerRev: 0,
      hsSkipped: new Set(),
      hsOwn: null,
      reviewSync: Promise.resolve(),
      markSync: Promise.resolve(),
      reviewMarked: new Set(),
      reviewRecords: new Map(),
      ledgerByCall: new Map(),
      ledgerByRun: new Map(),
      passSnaps: {},
      passMarks: {},
      builderRunsByRoot: {},
      builderRoots: new Map(),
      reviewRootsByCall: new Map(),
      reviewRoots: new Map(),
      touchUps: new Map(),
      launchHeadsByCall: new Map(),
      launchHeads: new Map(),
      launchTreesByCall: new Map(),
      launchTrees: new Map(),
      readonlyStartByCall: new Map(),
      readonlyStart: new Map(),
      readonlyRoots: new Map(),
      plan: null,
      script: newScriptState(),
      scriptRun: null,
      planReviews: new PlanReviews(),
      budget: new ReadBudget(),
      readNotices: new Map(),
      childFiles: new Set(),
      bashLogs: new Set(),
      ledgerBash: new Set(),
      launchBatch: new LaunchBatch(),
      dedupeTraced: new Set(),
      noticeVerdicts: new Map(),
      trimmedLines: new Map(),
      ladder: new LadderState(),
      retro: new RetroState(),
      childLadder: new ChildLadder(isChild ? b?.ladder : undefined),
      brief: new ExplorerBrief(),
      childReads: new ChildReads(),
      scratch: new ChildScratch(),
      scratchWt: null,
      keepalive: new KeepaliveLog(),
      selfWarm: warm.selfWarm,
      presence: warm.presence,
      idleCtx: null,
      lastAssistantAt: null,
      running: false,
      childRuns: new ChildRuns(new UsageTail(usageFile(agentDir, foremanSession), loadPrices(PKG_ROOT))),
      live: null,
      paneResume: null,
      show: null,
      openPrs: null,
      pressureSampler: null,
      pressureQ: null,
      overrideDeclined: false,
      overridden: new Map(),
    };
    sessions.set(id, s);
    // the session's scratch location goes in the step that sets `owned.childScratchRoot`; the foreman removes worktree-side lanes older than 7 days
    const applyScratchBase = (): void => {
      s.scratchWt = scratchWtNow;
      if (isChild) return;
      try {
        sweepOldScratch(s);
      } catch {
        // a failed sweep never stops the session
      }
    };
    // `npm root -g` once per process, never awaited on the hot path; the owned roots take the root when it resolves.
    void npmRootOnce({ spawn: defaultSpawner, env: process.env, platform, execPath: process.execPath })
      .then((npmRoot) => {
        s.owned = computeOwned(npmRoot);
        applyScratchBase();
        s.npmRootPending = false;
        if (rootInputs.notice && !isChild) notifyOnce(s, ctx, "worktree-root", rootInputs.notice, "warning");
      })
      .catch(() => {
        s.owned = computeOwned(null);
        applyScratchBase();
        s.npmRootPending = false;
      });
    if (!isChild) {
      if (ctx.mode === "tui" && footerStyleOf(get(s.config.config, "footer.style")) === "foreman") {
        try {
          ctx.ui.setFooter((tui, theme, data) => usageFooter.mount(id, ctx, tui, theme, data, () => pi.getThinkingLevel(), (model) => cacheSourceOf(s, model)));
        } catch {
          // the footer is cosmetic: Pi's own footer stays
        }
      }
      prevHeartbeats.set(id, readLiveRecord(agentDir, id)?.heartbeatMs ?? null); // before the start below overwrites the record
      s.live = LiveState.start({ agentDir, sessionId: id, cwd, mode: ctx.mode, env: process.env, endedBy: signalEnded, taskEnded: taskEndedCheck() }, () => s.childRuns.views(), () => usageFooter.totalsOf(id), () => { const w = waits.active(id); const pw = prWatchWait(sessions.get(id)?.prWatches.list() ?? [], sessions.get(id)?.prWatches.unreviewed() ?? [], sessions.get(id)?.prWatches.reviewLive() ?? []); return pw ? [...w, pw] : w; }, () => { const x = sessions.get(id); if (!x) return null; const p = pressureOf(x); return p.level === "ok" ? null : p; }, () => { const x = sessions.get(id); return x ? x.extStatus.items().map((i) => ({ n: null, state: i.state, label: i.label, src: "ext" as const })) : []; });
      if (s.live) {
        const live = s.live;
        s.show = Show.start({ agentDir, sessionId: id, cwd, home: os.homedir(), platform, scratchDir: editModeOfSession(s).scratchDir, handoffDir: (process.env.PI_FOREMAN_HANDOFF_DIR ?? "").trim() || null, trace: (r) => s.trace?.emit(r), onChange: () => live.flush() });
        const show = s.show;
        if (show) {
          live.show = () => show.field();
          live.flush();
        }
      }
      const where = new Where({ cwd: () => s.cwd, repo: originRepo, branch: branchOf, changed: () => s.live?.touch() });
      if (s.live) s.live.where = () => where.read();
      s.live?.setAwayGetter(() => s.selfWarm.state() === "watching" && s.presence.away());
      s.live?.setOwnerGetter(() => s.selfWarm.ownerPresence());
      const prCfg = new ReloadingConfig(agentDir, config, () => loadMergedConfig({ python: pyPath(s), pkgRoot: PKG_ROOT, provider, agentDir, projectDir: cwd, trusted, spawner }));
      s.openPrs = new OpenPrsRefresher({ agentDir, prepare: () => prCfg.refresh(), config: () => get(prCfg.current().config, "radar.openPrs"), ghHost: () => { const h = get(prCfg.current().config, "tools.prHost") ?? "auto"; return h === "auto" || h === "gh"; }, gh: realGh(cwd), hosts: () => resolveGithubHosts(prCfg.current().config) });
      s.openPrs.start();
      const live = s.live;
      waits.onChange(id, () => live?.touch());
    }
    isoSetting = get(config.config, "bridge.isolateClaudeConfig");
    ttlSetting = bridgeTtlSetting(get(config.config, "bridge.promptCacheTtl"));
    bridgeTtlS = derivedBridgeTtlS(ttlSetting, isChild, process.env);
    bridgeTtl.apply(process.env, ttlSetting, provider, isChild);
    try {
      bridgeIso.apply(process.env, agentDir, isoSetting, provider);
    } catch (err) {
      ctx.ui.notify(`pi-foreman: could not prepare the bridge config folder (${(err as Error).message}).`, "warning");
    }
    const claudeRisks = provider === BRIDGE_PROVIDER ? projectClaudeRisks(cwd) : [];
    if (claudeRisks.length) ctx.ui.notify(`pi-foreman: project Claude Code config runs in claude-bridge turns: ${claudeRisks.join(", ")}. Fix: ${PROJECT_CLAUDE_FIX}`, "error");
    const bridgeCfgRisks = bridgeTrusted(agentDir, cwd) ? [] : projectBridgeConfigRisks(cwd); // silent while the owner's trust record matches the file (bridgetrust.ts)
    if (bridgeCfgRisks.length) ctx.ui.notify(`pi-foreman: the project's claude-bridge config makes the bridge run what the project chose: ${bridgeCfgRisks.join(", ")}. Fix: ${PROJECT_BRIDGE_FIX}`, "error");
    s.trace?.emit({ event: "session_start", role: s.isChild ? "child" : "foreman", model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, tier: s.ceremony.tier });
    tracePoint(s, ctx.model);
    if (selfHost) {
      s.trace?.emit({ event: "protect_selfhost", reason: "dev checkout" });
      if (!s.isChild) notifyOnce(s, ctx, "selfhost", "pi-foreman: dev checkout: package-root write protection narrowed", "info");
    }
    if (rootInputs.notice && !s.isChild) notifyOnce(s, ctx, "worktree-root", rootInputs.notice, "warning");

    try {
      ensureSessionMarker(markerDir, id, Date.now() / 1000);
    } catch (err) {
      ctx.ui.notify(`pi-foreman: could not write the session marker in ${markerDir} (${(err as Error).message}); the ledger gates treat this session as unbound.`, "warning");
    }
    refreshLedgerTier(s);
    patchShellEnv({ env: process.env, binDir: BIN_DIR, python: pyPath(s), markerDir, platform, config: s.config.config });
    if (s.isChild) patchChildGitEnv(process.env);
    if (!s.isChild) patchForemanGitEnv(process.env);
    if (!s.isChild && ledgerHelperMode(get(config.config, "ceremony.ledgerHelper")) !== "off") {
      const active = pi.getActiveTools();
      if (!active.includes(LEDGER_TOOL)) pi.setActiveTools([...active, LEDGER_TOOL]);
    }
    s.gitPack = gitPackOn({ config: config.config, isChild: s.isChild, env: process.env });
    applyGitPack(pi, s.gitPack, s.isChild, process.env);
    s.prPack = prPackOn({ config: config.config, isChild: s.isChild, env: process.env });
    applyPrPack(pi, s.prPack, s.isChild, process.env);
    if (s.prPack && !s.isChild && !pi.getActiveTools().includes(PR_FOLLOW)) pi.setActiveTools([...pi.getActiveTools(), PR_FOLLOW]);
    if (!s.isChild) {
      const gitLines = s.gitDrift.bind(markerDir, cwd, home);
      if (gitLines.length) ctx.ui.notify(`pi-foreman: the repository's git config or hooks changed since the last session; the next foreman git run or child launch asks.\n${gitLines.join("\n")}`, "warning");
      const cfgLines = s.claudeCfg.bind(markerDir, cwd, agentDir);
      if (cfgLines.length) ctx.ui.notify(`pi-foreman: project Claude Code or claude-bridge config changed since the last session; the next claude-bridge request or summary asks.\n${cfgLines.join("\n")}`, "warning");
      const first = [s.gitDrift.firstBaseline ? "the repository's git config and hooks" : "", s.claudeCfg.firstBaseline ? "the project's Claude Code config" : ""].filter(Boolean);
      if (first.length) ctx.ui.notify(`pi-foreman: first session on this workspace: took the baseline snapshot of ${first.join(" and ")}. Later changes ask before the foreman's git runs, child launches and claude-bridge requests.`, "info");
    }

    if (!python.ok) ctx.ui.notify(`pi-foreman: no Python ≥ 3.13 found — shell commands and subagent launches are blocked until it is fixed. ${NO_PYTHON_FIX}`, "error");
    const bgNotice = bgBashNotice(bgShell, s.isChild);
    if (bgNotice) notifyOnce(s, ctx, "bg-no-bash", bgNotice, "warning");
    for (const e of config.errors) ctx.ui.notify(e, "error");
    if (config.source === "defaults") s.trace?.emit({ event: "config_fallback", reason: config.fallbackReason ?? "unknown", source: config.source });
    if (config.safetyFallback) ctx.ui.notify(config.source === "cli" ? "pi-foreman: invalid safety config; L1 safety values apply." : "pi-foreman: config CLI unavailable; L1 defaults apply and presence stays off.", "warning");
    for (const w of config.warnings) ctx.ui.notify(`pi-foreman config: ${w}`, "warning");
    const firstRun = firstRunNotice({ mode: ctx.mode, isChild: s.isChild, config: config.config, presets: presetNames(PKG_ROOT) });
    if (firstRun) ctx.ui.notify(firstRun, "info");
    if (!s.isChild && get(config.config, "gate.mode") === "floors-only") ctx.ui.notify("pi-foreman: gate.mode \"floors-only\" is retired and now means permissions mode allow (floors, self-modification and deny/ask rules still apply; everything else runs). Set \"mode\": \"allow\" in permissions.json, or use /foreman perms mode allow, and remove gate.mode.", "warning");
    const gap = providerGapNotice({ provider, config: config.config, presets: presetProviders(PKG_ROOT), mode: ctx.mode, isChild: s.isChild });
    if (gap) notifyOnce(s, ctx, "provider-gap", gap, "warning");
    if (!s.isChild) for (const sh of shadowedRoles(cwd, childRoleIds(get(config.config, "roles")), home)) ctx.ui.notify(`pi-foreman: project agent shadows a role (${sh}); ${SHADOW_FIX}`, "warning");
    if (!s.isChild && ranksOf(config.config).size === 0) notifyOnce(s, ctx, "no-rank-rules", "pi-foreman: no model rank rules: builder launches that name a model outside the builder's own models are refused; run foreman config apply-preset", "warning");
    return s;
  }

  /** Every tier change goes through here so the trace sees it. Only a change by the user (/ceremony) resets the round state and the loop stop. */
  function setCeremony(s: Session, next: CeremonyState): void {
    const before = s.ceremony.tier;
    // The reason of the change: the reason an escalation or override appended, else the source (a triage without one).
    const reason = next.reasons.length > s.ceremony.reasons.length ? next.reasons[next.reasons.length - 1] : `source ${next.source}`;
    s.ceremony = next;
    if (next.tier !== before) {
      if (!s.isChild) s.trace?.emit({ event: "tier", tier: next.tier, reason }); // D7: a tier event is the foreman's triage
      if (next.source === "user") (s.round = initialRounds()), (s.loopStop = null);
      persistRounds(s);
    }
    persistCeremonyState(s);
  }

  /** The ledger part of a PassMark and of the repeat-review signal: the bound path and the count of subject changes (`path#rev`), null when no ledger is bound. */
  function ledgerSignal(s: Session): string | null {
    const f = boundLedger(s.markerDir, s.id);
    return f === null ? null : `${f}#${s.ledgerRev}`;
  }

  /** Whether a resolved tool path is the bound ledger (selffinish's samePath: native real paths, Windows case and separators folded, so an 8.3 short temp path matches). */
  function isBoundLedgerPath(p: string | null, bound: string): boolean {
    return p !== null && samePath(p, bound);
  }

  /** A subject change to the bound ledger (an item added or rewritten, a write or edit of the file): the next reviewer launch is allowed after a PASS. Saved at once. */
  function bumpLedgerRev(s: Session): void {
    s.ledgerRev += 1;
    persistCeremonyState(s);
  }

  /** Append the `pi-foreman-ceremony-state` session entry (planstate.ts) when the state differs from the last one appended or restored. */
  function persistCeremonyState(s: Session): void {
    if (s.isChild || !s.ceremonyRestored) return;
    const data = buildCeremonyState({
      plan: s.plan,
      lineages: s.planReviews.all().map((l) => ({ path: l.path, hash: l.latest.hash, verdict: l.latest.verdict, model: l.latest.model, rounds: l.rounds, reviews: l.reviews })),
      userTier: s.ceremony.userTier,
      tier: s.ceremony.tier,
      tierSource: s.ceremony.source,
      planPhase: s.planPhase,
      planPhaseOrigin: s.planPhaseOrigin,
      reviews: s.reviews,
      loopStop: s.loopStop,
      gate: persistedGate({ ...s.steps }, s.reviewGates, s.passMarks),
      sentBack: s.sentBack,
      sentBackHeads: s.sentBackHeads,
      reworkSeen: s.reworkSeen,
      highStakes: s.hs.snapshot(),
      pause: s.pauseSaved,
      hsReminded: s.hsReminded,
      ledgerRev: s.ledgerRev,
    });
    const json = JSON.stringify(data);
    if (json === s.ceremonyEntry) return;
    s.ceremonyEntry = json;
    try {
      pi.appendEntry(CEREMONY_ENTRY, data);
    } catch {
      // the session file is not writable now: the state stays in memory
    }
  }

  // ------------------------------------------------------------------ high stakes (highstakes.ts)

  /** ceremony.highStakes.model of a foreman session; every high-stakes check reads it first (null: nothing is measured, required or warned). */
  const hsModel = (s: Session): string | null => (s.isChild ? null : highStakesConfig(s.config.config).model);

  async function hsOwnRoot(s: Session): Promise<string> {
    if (!s.hsOwn) s.hsOwn = (await toplevelOf(s.cwd)) ?? s.cwd;
    return s.hsOwn;
  }

  // ------------------------------------------------------------------ review gates per checkout (reviewgates.ts)

  /** The checkouts of `dirs` (toplevelOf each); null when there is none or one does not resolve (an unknown checkout acts on every gate entry). */
  const rootMemo = new Map<string, string>(); // a resolved checkout of a directory (a miss is not kept: the directory may appear later)
  async function rootOf(d: string): Promise<string | null> {
    const known = rootMemo.get(d);
    if (known !== undefined) return known;
    const r = await toplevelOf(d);
    if (r !== null) rootMemo.set(d, r);
    return r;
  }
  async function rootsOf(dirs: readonly string[]): Promise<string[] | null> {
    const roots = await Promise.all(dirs.map(rootOf));
    return roots.length > 0 && roots.every((r): r is string => r !== null) ? [...new Set(roots)] : null;
  }

  /** The directory of each reviewer entry of a fresh launch (not `launchCwds`, which always adds the session cwd). */
  const reviewDirs = (ctx: ExtensionContext, input: Record<string, unknown>, keep: (e: Record<string, unknown>) => boolean = () => true): string[] => launchEntries(input).filter((e) => typeof e.agent === "string" && REVIEW_ROLES.includes(e.agent) && keep(e)).map((e) => hsDirOf(ctx, input, e));

  /** Work happened in `roots` (null: unknown): their gate entries go stale; a builder raises the builder count of each (an unknown root: of every counted one). */
  function reviseGates(s: Session, roots: readonly string[] | null, builder: boolean): void {
    if (roots === null) {
      s.reviewGates = gatesRevise(s.reviewGates, null);
      if (builder) for (const k of Object.keys(s.builderRunsByRoot)) s.builderRunsByRoot[k]++;
      return;
    }
    for (const r of roots) {
      s.reviewGates = gatesRevise(s.reviewGates, r);
      if (builder) s.builderRunsByRoot[r] = (s.builderRunsByRoot[r] ?? 0) + 1;
    }
  }

  /** The key of the pass mark that applies to `root`: its own, else the session-wide one; null = the newest mark; undefined when there is none. */
  function markKeyOf(s: Session, root: string | null): string | undefined {
    if (root !== null) return s.passMarks[root] ? root : s.passMarks[SESSION_WIDE] ? SESSION_WIDE : undefined;
    return Object.entries(s.passMarks).reduce<[string, number] | undefined>((best, [k, m]) => (!best || m.at >= best[1] ? [k, m.at] : best), undefined)?.[0];
  }

  /** Builder launches counted for a pass-mark key (the session-wide mark counts the finished builder runs of the session, as before). */
  const builderRunsOf = (s: Session, key: string): number => (key === SESSION_WIDE ? s.steps.builder : (s.builderRunsByRoot[key] ?? 0));

  /** The checkout `dir` belongs to, its repository noted as seen (the first HEAD is the review base when no merge-base resolves); null outside git. */
  async function hsSee(s: Session, dir: string): Promise<string | null> {
    const root = await rootOf(dir);
    if (!root) return null;
    const key = await repoKeyOf(root);
    const head = key && !s.hs.base(key) ? await headOf(root) : null;
    if (key && head && s.hs.noteBase(key, head)) persistCeremonyState(s);
    return root;
  }

  /** The session's high-stakes state is session-wide: reasons that fire are sticky and each new one is traced. */
  function hsFire(s: Session, reasons: readonly string[]): void {
    const added = s.hs.fire(reasons);
    if (added.length === 0) return;
    s.trace?.emit(stakesTrace(added));
    persistCeremonyState(s);
  }

  /** The task is heavy and the session built something: `heavy` counts toward a due review. Once stored it stays until the owner's `/ceremony` tier (`userTier`) is below heavy; a foreman triage or a ledger line cannot drop it, and a raise back to heavy brings the reason back. */
  const hsHeavyOn = (s: Session): boolean => {
    if (s.hs.state().fired?.reasons.includes("heavy") === true) return s.ceremony.tier === "heavy" || !s.ceremony.userTier || s.ceremony.userTier === "heavy";
    return s.ceremony.tier === "heavy" && (s.steps.builder > 0 || s.tally.files.length > 0);
  };

  /** The reasons that count now (empty: no pass is due). */
  const hsDue = (s: Session): string[] => dueReasons(s.hs.state(), hsHeavyOn(s));

  /** A gate asks: the heavy reason is recorded when it applies. */
  function hsRefresh(s: Session): void {
    if (hsHeavyOn(s)) hsFire(s, ["heavy"]);
  }

  /** Whether a high-stakes review is required now, computed as the PR gate does (feature on, heavy reason refreshed). */
  const hsRequired = (s: Session): boolean => {
    if (!hsModel(s)) return false;
    hsRefresh(s);
    return hsRequiredOf(s.hs.state(), hsDue(s));
  };

  /** The high-stakes test of the PR gate (reviews.ts prGateRefusal): session-wide, `scope` does not narrow it. */
  const hsGate = (s: Session): HighStakesGate => async (_scope, heads) => {
    if (!hsModel(s)) return null;
    hsRefresh(s);
    const r = prRefusal(s.hs.state(), hsDue(s), heads, await hsOwnRoot(s));
    return r ? { reason: r.reason, message: r.message } : null;
  };

  /** A revision happened in the checkout of `dir` (a builder run, a project edit): an uncleared high-stakes FAIL that ran there counts as revised. */
  async function hsRevised(s: Session, dir: string | null): Promise<void> {
    if (!hsModel(s) || !s.hs.hasRuns()) return;
    const root = await rootOf(dir ?? s.cwd);
    if (root && s.hs.revision(root)) persistCeremonyState(s);
  }

  /** The checkout key of a directory outside git (and of a launch's root there): its realpath, else the resolved path; both sides of a same-directory compare use it. */
  const realDir = (d: string): string => {
    try {
      return fs.realpathSync.native(d);
    } catch {
      return path.resolve(d);
    }
  };

  /**
   * A normal PASS (item or [pre-pr]) of run `runId` was recorded in `cwd` at `head`: when the run got the findings of the uncleared high-stakes FAIL it clears it, in the FAIL's
   * checkout at any head, elsewhere when the PASS head descends from the FAIL head (highstakes.ts descendsFrom). The FAIL's review gate entry then passes too, when its PASS stood just before the FAIL and no work happened there since (work during the high-stakes run keeps it open).
   */
  async function hsNormalPass(s: Session, cwd: string, runId: string, head: string | null): Promise<void> {
    if (!hsModel(s)) return;
    const fail = s.hs.openFail();
    if (!fail) return;
    const root = (await rootOf(cwd)) ?? realDir(cwd);
    const descends = root !== fail.cwd && (await descendsFrom(fail, root, head));
    if (!s.hs.clearBy(root, { runId, head, descends })) return;
    s.reviewGates = gatesClearFail(s.reviewGates, fail.gateKey === undefined ? SESSION_WIDE : fail.gateKey, fail.failAt, Date.now(), runId); // an old run without gateKey: the session-wide entry
    persistCeremonyState(s);
  }

  /** The directory a launch entry runs in. */
  const hsDirOf = (ctx: ExtensionContext, input: Record<string, unknown>, e: Json): string => path.resolve(ctx.cwd, typeof e.cwd === "string" && e.cwd ? e.cwd : typeof input.cwd === "string" && input.cwd ? input.cwd : ".");

  /** The directories the builder entries of a launch run in (a resumed builder: the session's own). */
  function builderDirs(ctx: ExtensionContext, input: Record<string, unknown>): string[] {
    const dirs = launchEntries(input).filter((e) => e.agent === "builder").map((e) => hsDirOf(ctx, input, e));
    return dirs.length > 0 ? dirs : [ctx.cwd];
  }

  /**
   * The guards of the `[high-stakes]` launch (highstakes.ts launchRefusal, in the plan's order) and of a reviewer resume while a high-stakes FAIL is not cleared
   * (a fresh normal reviewer is never refused: it gets the findings). Each refusal is traced. An accepted `[high-stakes]` launch fills `hsEntries` and returns its checkout
   * and the base its facts are collected against; null otherwise.
   */
  async function hsLaunchGuard(s: Session, ctx: ExtensionContext, input: Record<string, unknown>, occasions: Map<Json, Occasion>, hsEntries: Set<Json>): Promise<string | { root: string; gateKey: string; base: string | null } | null> {
    const refused = (r: { reason: string; text: string }): string => {
      s.trace?.emit({ event: "review_high_stakes_refused", reason: r.reason });
      return r.text;
    };
    const model = hsModel(s);
    const action = actionOf(input);
    if (action === "resume") {
      const target = resumeTarget(input);
      // the run-id lookup holds whatever the model says
      if (target && s.hs.ownerOf(target) !== null) return refused(resumeRefusal());
      if (model && launchRoles(s, input).some((r) => REVIEW_ROLES.includes(r))) {
        await s.reviewSync; // a FAIL still being recorded lands before it is read
        for (const d of launchCwds(input, ctx.cwd)) {
          const root = await rootOf(d);
          const r = root ? unrevisedRefusal(s.hs.state(), { resume: true, builder: false, cwd: root }) : null;
          if (r) return refused(r);
        }
      }
      return null;
    }
    if (action !== null) return null;
    const reviews = [...occasions].filter(([e]) => typeof e.agent === "string" && REVIEW_ROLES.includes(e.agent));
    const marked = reviews.filter(([, o]) => o === "high-stakes").map(([e]) => e);
    if (marked.length === 0) return null;
    await s.reviewSync; // a review round still being recorded lands before the gate is read
    const dir = hsDirOf(ctx, input, marked[0]);
    const top = await rootOf(dir);
    const root = top ?? realDir(dir);
    const r = launchRefusal({ model, single: singleLaunchRole(input) !== null && !Array.isArray(input.parallel), resume: false, state: s.hs.state(), running: s.hs.isRunning(), gate: gateOf(s.reviewGates, top) }); // an unresolved checkout reads every entry
    if (r) return refused(r);
    // the whole change: the diff facts are collected against the merge-base (else the first HEAD the session saw in the repository), and the task names it
    const key = await repoKeyOf(root);
    const configured = get(s.config.config, "safety.ops.baseBranch");
    const base = await reviewBaseOf(root, { baseBranch: typeof configured === "string" ? configured : null, ...(key && s.hs.base(key) ? { recorded: s.hs.base(key) } : {}) });
    for (const e of marked) {
      if (base) reviewFacts.setStepBase(e, base);
      if (typeof e.task === "string") e.task = taskLine(base) + e.task;
      hsEntries.add(e);
    }
    return { root, gateKey: top ?? SESSION_WIDE, base };
  }

  /**
   * The verdict record of review run `runId` (verdict.ts), read once: the live `verdict.json` of the run's launch folder is parsed against the launch's items,
   * renamed to `verdict.<runId>.json` and cached; later reads (the other consumers of the run end, the completion notice after it) take the cache, and after a reload
   * the renamed file. The launch and its items come from the route of the run (it survives a reload), else the launch bookkeeping. null = no record, or an invalid
   * one (traced `review_record_invalid`). Not cached while the run's launch is unknown.
   */
  function verdictRecordOf(s: Session, runId: string): VerdictRecord | null {
    if (s.reviewRecords.has(runId)) return s.reviewRecords.get(runId) ?? null;
    const route = s.ledgerByRun.get(runId);
    const launch = route?.review?.launch ?? parkFor(s).launchFor(runId);
    if (!launch) return null;
    const items = route?.review?.items ?? s.launches.get(launch)?.items ?? [];
    const dir = recordDir(s.agentDir, s.id, launch);
    let read = readRecordFile(dir, launch, items);
    if (read) consumeRecord(dir, runId);
    else read = readConsumed(dir, runId, launch, items);
    if (read && "invalid" in read) s.trace?.emit({ event: "review_record_invalid", runId, reason: read.invalid });
    const record = read && "record" in read ? read.record : null;
    capSet(s.reviewRecords, runId, record);
    return record;
  }

  /** A review run that did not complete gives no record, for the notice path too: null is cached and the route (persisted, so a reload knows) says `failed`. */
  function failedReviewRun(s: Session, runId: string): void {
    capSet(s.reviewRecords, runId, null);
    const route = s.ledgerByRun.get(runId);
    if (!route?.review || route.review.failed) return;
    const next = { ...route, review: { ...route.review, failed: true } };
    capSet(s.ledgerByRun, runId, next);
    persistRoute(runId, next);
  }

  /** The review results of a run end, the verdict from the run's record; a run of a high-stakes launch (its id is kept in the state) reads as `high-stakes` and counts nowhere, with or without bookkeeping. */
  function reviewResultsOfRun(s: Session, runId: string, data: unknown): ReturnType<typeof reviewResultsOfRunEnd> {
    const hs = s.hs.ownerOf(runId) !== null;
    const record = (s.launchedRoles.get(runId) ?? []).some((r) => REVIEW_ROLES.includes(r)) ? verdictRecordOf(s, runId) : null;
    return reviewResultsOfRunEnd(data, s.reviewRuns.byRun.get(runId), record).map((r) => (hs ? { ...r, occasion: "high-stakes" as const, counts: false } : r));
  }

  /** A high-stakes run ended with a verdict (not `FAIL INCOMPLETE`, which records nothing): it is recorded for its checkout (a FAIL also sets the review gate). No item mark, no normal review record. */
  function hsRunEnd(s: Session, runId: string, root: string, data: unknown, start: Parameters<typeof reviewedHeadVia>[0], trees: Parameters<typeof reviewedHeadVia>[1]): void {
    const r = reviewResultsOfRun(s, runId, data).find((x) => x.verdict !== null || x.incomplete);
    if (r?.incomplete) {
      // the reviewer recorded `incomplete` (it could not run its checks): nothing is recorded (no run, no gate change), as for a run with no verdict
      s.trace?.emit({ event: "high_stakes", kind: "incomplete" });
      return;
    }
    const verdict = r?.verdict;
    if (!r || !verdict) return;
    const failAt = Date.now();
    const key = s.hs.gateKeyOf(runId); // the checkout resolved at the launch; none known: every entry
    if (verdict === "fail") s.reviewGates = gatesMarkStood(s.reviewGates, gatesVerdict(s.reviewGates, key ? [key] : null, ["fail"], failAt, runId));
    s.reviewSync = s.reviewSync.then(async () => {
      const dir = r.cwd ?? root;
      const h = await reviewedHeadVia(start, trees, dir, await headOf(dir));
      const n = verdict === "fail" ? s.hs.recordFail(root, h.head, r.text, { repoKey: await repoKeyOf(root), gateKey: key || null, failAt }) : s.hs.record(root, verdict, h.head, r.text);
      if (n === 0) return;
      s.trace?.emit({ event: "review_high_stakes", verdict, head: h.head, count: n });
      persistCeremonyState(s);
    });
  }

  /** The finish gate's high-stakes entries and hint (the pass only once every ledger item but V is marked). */
  async function hsFinish(s: Session): Promise<ReturnType<typeof finishNeeds>> {
    if (!hsModel(s)) return { missing: [], hint: "" };
    hsRefresh(s);
    const file = boundLedger(s.markerDir, s.id);
    let done = true;
    try {
      done = file ? openItemsOf(fs.readFileSync(file, "utf8")).size === 0 : true;
    } catch {
      done = true;
    }
    return finishNeeds(s.hs.state(), { due: hsDue(s), ledgerDone: done, own: await hsOwnRoot(s) });
  }

  /**
   * The finish gate's progress of the same session (never a fork): the recorded `gate`, else, for an entry from before it was
   * recorded, rebuilt from the newest code review: a PASS counts as builder and reviewer done, and as revised when HEAD moved since.
   */
  function restoreGate(s: Session, e: CeremonyStateEntry): void {
    if (e.gate) {
      s.steps = { ...e.gate.steps };
      // an entry from before the per-checkout gate: its single gate and mark are the session-wide entry (strict: it reads for every checkout without an entry)
      const old = e.gate.reviewGate.last === null && !e.gate.reviewGate.revised ? {} : { [SESSION_WIDE]: e.gate.reviewGate };
      s.reviewGates = e.gate.reviewGates ? { ...e.gate.reviewGates } : old;
      s.passMarks = e.gate.reviewGates ? { ...(e.gate.passMarks ?? {}) } : e.gate.passMark ? { [SESSION_WIDE]: e.gate.passMark } : {};
      s.passSnaps = {};
      for (const [k, m] of Object.entries(s.passMarks)) {
        if (m.tree) s.passSnaps[k] = { cwd: m.cwd, tree: m.tree };
        if (k !== SESSION_WIDE) s.builderRunsByRoot[k] = m.builderRuns;
      }
      return;
    }
    const last = e.reviews.findLast((r) => r.kind !== "plan");
    if (!last || last.verdict !== "pass") return;
    s.steps = { builder: Math.max(s.steps.builder, 1), reviewer: Math.max(s.steps.reviewer, 1) };
    const key = last.cwd ?? SESSION_WIDE;
    s.reviewGates = { [key]: { last: "pass", revised: false } };
    if (last.head) s.reviewSync = s.reviewSync.then(async () => {
      const cur = await headOf(last.cwd ?? s.cwd);
      if (cur !== last.head && s.reviewGates[key]?.last === "pass") s.reviewGates = gatesRevise(s.reviewGates, key === SESSION_WIDE ? null : key);
    });
  }

  /** Records the work counters and the refusal count in the session entry; called at an owner input and at a settle only, never per edit. */
  function savePause(s: Session): void {
    s.pauseSaved = { work: { ...s.work }, atPrompt: { ...s.workAtPrompt }, refusals: s.finishKey ? { n: s.finishRefusals, key: s.finishKey, ...(s.incompleteKey === s.finishKey ? { done: true } : {}) } : null };
    persistCeremonyState(s);
  }

  /** A reviewer child whose record folder holds no record yet owes a verdict (the setup record of `noToolVerdict` counts as one). */
  function verdictOwed(): boolean {
    const b = launchBinding;
    if (!b?.verdictDir || !REVIEW_ROLES.includes(b.role)) return false;
    return fs.existsSync(b.verdictDir) && !fs.existsSync(path.join(b.verdictDir, VERDICT_FILE));
  }

  /** A reviewer child with a record folder whose active tools lack `review_verdict` (settings not regenerated, A6) writes the incomplete record itself, with the fixed setup reason: no model text enters it. */
  function noToolVerdict(s: Session): void {
    const b = launchBinding;
    if (!b?.verdictDir || !REVIEW_ROLES.includes(b.role) || !fs.existsSync(b.verdictDir)) return;
    try {
      if (pi.getActiveTools().includes(VERDICT_TOOL)) return;
      writeRecord(b.verdictDir, noToolRecord(b.launchId));
      s.trace?.emit({ event: "review_verdict_call", accepted: false, reason: "no_tool" });
    } catch {
      // a host without the tool api, or an unwritable folder: the reviewer ends without a verdict
    }
  }

  /** The `review` part of a route entry read back from a session file; undefined when it is not well formed. */
  function reviewRouteOf(raw: unknown): LedgerRoute["review"] {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as { launch?: unknown; items?: unknown; occasion?: unknown; shadow?: unknown; failed?: unknown };
    if (typeof r.launch !== "string" || !r.launch || !Array.isArray(r.items) || !(OCCASIONS as readonly unknown[]).includes(r.occasion) && r.occasion !== "high-stakes") return undefined;
    const items = r.items.map(itemIdOf);
    if (items.some((i) => i === null)) return undefined;
    return { launch: r.launch, items: items as ItemId[], occasion: r.occasion as Occasion, shadow: r.shadow === true, ...(r.failed === true ? { failed: true } : {}) };
  }

  /** The route of a run into the session file (so it survives a reload); a session file that is not writable keeps it in memory only. */
  function persistRoute(runId: string, route: LedgerRoute): void {
    try {
      pi.appendEntry(LEDGER_ROUTE_ENTRY, { v: 1, run: runId, paths: route.paths, cited: route.cited, ...(route.review ? { review: route.review } : {}) });
    } catch {
      // the session file is not writable now: the route stays in memory
    }
  }

  /** session_start: the run -> ledger routes of the branch's launches; a run with no record uses the bound ledger. */
  function restoreLedgerRoutes(s: Session, ctx: ExtensionContext): void {
    if (s.isChild) return;
    for (const raw of (ctx.sessionManager.getBranch?.() ?? []) as unknown[]) {
      const e = raw as { type?: unknown; customType?: unknown; data?: { v?: unknown; run?: unknown; paths?: unknown; cited?: unknown; review?: unknown } } | null;
      if (!e || e.type !== "custom" || e.customType !== LEDGER_ROUTE_ENTRY || !e.data || e.data.v !== 1) continue;
      const { run, paths, cited, review } = e.data;
      if (typeof run !== "string" || !Array.isArray(paths) || !Array.isArray(cited) || cited.length !== paths.length) continue;
      if (!paths.every((p) => p === null || typeof p === "string") || !cited.every((c) => Array.isArray(c) && c.every((x) => typeof x === "string"))) continue;
      capSet(s.ledgerByRun, run, { paths: paths as (string | null)[], cited: cited as string[][], ...(reviewRouteOf(review) ? { review: reviewRouteOf(review) } : {}) });
    }
  }

  /** session_start: what the latest ceremony-state entry of the branch brings back; an approval never on a fork. */
  function restoreCeremonyState(s: Session, ctx: ExtensionContext, reason: string): void {
    if (s.isChild) return;
    const e = latestCeremonyState((ctx.sessionManager.getBranch?.() ?? []) as unknown[]);
    s.ceremonyRestored = true;
    if (!e) return persistCeremonyState(s); // a plan phase entered through the env is recorded at once
    for (const l of e.lineages) s.planReviews.restore(l.path, { hash: l.hash, verdict: l.verdict, model: l.model, findings: Promise.resolve([]) }, l.rounds, l.reviews);
    s.planPhase = e.planPhase;
    s.planPhaseOrigin = e.planPhaseOrigin ?? "owner"; // an entry without the field: the owner's origin (a PASS does not end it)
    if (!s.planPhase && process.env.PI_FOREMAN_PLAN_PHASE !== undefined) {
      // a resumed pane put the launch flag back from an identity entry written before the phase ended: drop it there too, so a later resume does not bring it back
      delete process.env.PI_FOREMAN_PLAN_PHASE;
      recordIdentity(s, ctx, reason, { status: "none" });
    }
    if (s.reviews.length === 0) s.reviews.push(...e.reviews); // the PR gate's verdicts and heads (reviews.ts)
    if (e.highStakes && s.hs.isEmpty()) s.hs.load(e.highStakes); // nothing counts as running after a reload
    s.loopStop = e.loopStop ?? null;
    if (reason !== "fork") restoreGate(s, e);
    if (reason !== "fork") s.hsReminded = e.hsReminded ?? null;
    if (reason !== "fork") s.ledgerRev = e.ledgerRev ?? 0;
    if (reason !== "fork") (s.sentBack = e.sentBack === true), (s.sentBackHeads = sentBackRestore(e)), (s.reworkSeen = e.reworkSeen ?? 0);
    if (reason !== "fork" && e.pause) {
      s.work = { ...e.pause.work };
      s.workAtPrompt = { ...e.pause.atPrompt };
      s.finishRefusals = e.pause.refusals?.n ?? 0;
      s.finishKey = e.pause.refusals?.key ?? "";
      s.incompleteKey = e.pause.refusals?.done ? s.finishKey : "";
      s.pauseSaved = e.pause;
    }
    if (e.tier && e.tierSource && e.tierSource !== "default") {
      // a reload never lowers the tier: the persisted effective tier (auto escalations included) or the user's, whichever is higher, unless the last change was /ceremony
      const tier = e.tierSource === "user" || !e.userTier || TIERS.indexOf(e.tier) >= TIERS.indexOf(e.userTier) ? e.tier : e.userTier;
      s.ceremony = { ...s.ceremony, tier, source: e.tierSource, triaged: true, ...(e.userTier ? { userTier: e.userTier } : {}) };
    } else if (e.userTier) {
      s.ceremony = { ...s.ceremony, tier: e.userTier, source: "user", triaged: true, userTier: e.userTier };
    }
    let approved = false;
    if (reason !== "fork" && e.plan?.status === "approved") {
      const o = planOpts(s, ctx);
      const now = readPlan(e.plan.path, o);
      const rec = restorableApproval(e.plan, "plan" in now ? now.plan.hash : null);
      if (rec) {
        s.plan = rec;
        approved = true;
      }
    }
    s.trace?.emit({ event: "ceremony_state_restored", approval: approved ? "restored" : "none", lineages: e.lineages.length, ...(e.userTier ? { userTier: e.userTier } : {}) });
    s.ceremonyEntry = JSON.stringify(e);
    if (e.userTier) refreshLedgerTier(s); // records what the ledger says; it cannot raise the tier
    persistCeremonyState(s);
  }

  /** Session opened by another session: rewrite `<handoff>/round-state.json` (roundstate.ts); never an approval flag. */
  function persistRounds(s: Session): void {
    persistCeremonyState(s);
    const dir = roundStateDir(process.env);
    if (s.isChild || !s.roundStateOn || !dir) return;
    const plan = s.plan && s.plan.status !== "rejected" ? s.plan : null;
    const l = plan ? s.planReviews.lineage(plan.path) : null;
    const newest = plan ? l : s.planReviews.newest(); // before a checkpoint s.plan is unset: the newest verdict still says whether the review passed
    writeRoundState({
      handoffDir: dir,
      plan: plan ? { topic: plan.topic, hash: plan.hash } : null,
      planReview: l ? { hash: l.latest.hash, verdict: l.latest.verdict, model: l.latest.model, rounds: l.rounds } : null,
      round: s.round,
      tier: s.ceremony.tier,
      reviewPassed: newest?.latest.verdict === "pass" && (!plan || newest.latest.hash === plan.hash),
      planOpen: plan?.status !== "approved",
      ...(s.capsResetAt > 0 ? { capsResetAt: s.capsResetAt } : {}),
    });
  }

  /** session_start of a session opened by another session: what the reload file may bring back; never an approval. */
  function restoreRounds(s: Session, ctx: ExtensionContext, reason: string): void {
    const dir = roundStateDir(process.env);
    if (s.isChild) return;
    s.roundStateOn = true;
    if (!dir) return;
    const o = planOpts(s, ctx);
    const r = restoreRoundState(dir, (topic) => { const p = readPlan(path.join(o.scratchDir, `plan-${topic}.md`), o); return "plan" in p ? { path: p.plan.path, hash: p.plan.hash } : null; });
    if (!r) {
      // discarded: the file now holds the fresh state, so nothing of the old one can come back later
      if (fs.existsSync(path.join(dir, ROUND_STATE_FILE))) persistRounds(s);
      return;
    }
    s.round = r.round;
    s.capsResetAt = r.capsResetAt;
    s.trace?.emit({ event: "round_state_restored", approval: "none" });
    persistRounds(s);
  }

  /**
   * session_start after a reload or resume (R41 item 17): the checkpoint approval and the plan-review verdicts come back from the harness-only approval
   * store, keyed by the plan version hash of the plan files now in the scratch dir. Not in a session opened by another session: the store keeps no session or
   * plan path, so a shared scratch dir would hand it the parent's approval; its own dialog approval comes back from its ceremony-state entry (restoreCeremonyState).
   */
  function restoreStoredPlans(s: Session, ctx: ExtensionContext): void {
    if (s.isChild || roundStateDir(process.env)) return;
    const r = restoreFromStore(s.agentDir, planOpts(s, ctx));
    for (const v of r.reviews) if (!s.planReviews.lineage(v.plan.path)) s.planReviews.restore(v.plan.path, { hash: v.plan.hash, verdict: v.review.verdict, model: v.review.model, findings: Promise.resolve([]) }, v.review.rounds);
    const a = r.approved;
    if (a && !s.plan) s.plan = { topic: a.plan.topic, path: a.plan.path, hash: a.plan.hash, status: "approved", approvedAt: a.at, by: a.by, note: "restored after reload from the approval store" };
    if (a || r.reviews.length) {
      s.trace?.emit({ event: "round_state_restored", approval: a ? "store" : "none" });
      persistRounds(s);
    }
  }

  function sessionFor(ctx: ExtensionContext): Session | undefined {
    return sessions.get(ctx.sessionManager.getSessionId());
  }

  async function ensureSession(ctx: ExtensionContext): Promise<Session> {
    return sessionFor(ctx) ?? (await startSession(ctx));
  }

  function refreshLedgerTier(s: Session): void {
    const ledger = boundLedger(s.markerDir, s.id);
    if (!ledger) return;
    try {
      const { tier, reason } = ledgerTier(fs.readFileSync(ledger, "utf8"));
      setCeremony(s, escalate(s.ceremony, tier, "ledger", reason));
    } catch {
      // unreadable ledger: keep the tier
    }
  }

  /**
   * session_start, after startSession: an opened session (handoff dir and child id in env, restored or given) appends its identity
   * entry when it differs from the branch's latest and refreshes `<handoff>/live.json`; never in a child or on a fork.
   */
  function recordIdentity(s: Session, ctx: ExtensionContext, reason: string, restored: IdentityRestore): void {
    if (restored.status === "restored") s.trace?.emit({ event: "identity_restored", reason });
    else if (restored.status === "skipped") s.trace?.emit({ event: "identity_restore_skipped", reason: restored.reason });
    if (s.isChild || process.env.PI_SUBAGENT_CHILD === "1" || reason === "fork") return;
    const id = captureIdentity(process.env, s.id, pi.getSessionName?.());
    if (!id) return;
    const last = latestIdentity((ctx.sessionManager.getBranch?.() ?? []) as unknown[]);
    if (JSON.stringify(last) !== JSON.stringify(id)) {
      try {
        pi.appendEntry(IDENTITY_ENTRY, id);
      } catch {
        // the session file is not writable now: the next start tries again
      }
    }
    writeLive(id.handoff, id.child, s.id);
  }

  /** `restoredModel` (an identity restored this start): the model the session was opened on wins over the foreman role model. */
  async function applyForemanModel(s: Session, ctx: ExtensionContext, restoredModel?: string | null): Promise<void> {
    const role = s.config.roles.foreman;
    const codemode = role && typeof role.codemode === "boolean" ? role.codemode : get(s.config.config, "roles.foreman.codemode") === true;
    if (codemode) {
      const active = pi.getActiveTools();
      if (!active.includes("codemode")) pi.setActiveTools([...active, "codemode"]);
    }
    if (!restoredModel && (!role || typeof role.model !== "string")) {
      // Only worth a warning when the map names this provider; an empty map is a fresh install.
      const provider = ctx.model?.provider;
      if (role && typeof role.error === "string" && provider && get(s.config.config, `providers.${provider}`)) ctx.ui.notify(`pi-foreman: foreman model not applied: ${role.error}`, "warning");
      return;
    }
    if (userPickedModel) return;
    // `foreman session open --model X` wins over the overlay/preset role model (model and thinking) for this session
    const spec = restoredModel ? (cliModelOf(process.argv) ? null : restoredModel) : foremanModelSpec(role!.model as string, sessionModelOf(process.env), cliModelOf(process.argv));
    if (spec === null) return;
    const slash = spec.indexOf("/");
    const provider = slash > 0 ? spec.slice(0, slash) : ctx.model?.provider ?? "";
    const modelId = slash > 0 ? spec.slice(slash + 1) : spec;
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model) {
      ctx.ui.notify(`pi-foreman: foreman model ${spec} is not in the model registry; keeping the current model.`, "warning");
    } else {
      applyingModel = true;
      try {
        const ok = await pi.setModel(model);
        if (!ok) ctx.ui.notify(`pi-foreman: no auth for ${provider}; keeping the current model. Log in or set the API key, then /foreman doctor.`, "warning");
      } finally {
        applyingModel = false;
      }
    }
    if (role && typeof role.thinking === "string" && role.thinking) pi.setThinkingLevel(role.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
  }

  async function registerChildExtensions(s: Session, ctx: ExtensionContext): Promise<void> {
    const extra = normaliseChildExtensions(get(s.config.config, "safety.requiredChildExtensions"), s.agentDir);
    s.childExtensionErrors = extra.errors;
    for (const e of extra.errors) ctx.ui.notify(`pi-foreman: ${e}`, "error");
    s.childExtensions = [{ id: ADAPTER_ID, path: ENTRY }, ...extra.list.filter((e) => e.id !== ADAPTER_ID && e.id !== REMOVED_GIT_GUARD_ID)];
    try {
      const { fn, via } = await loadRegister();
      s.registration = fn({ sessionId: s.id, extensions: s.childExtensions, requireForAllRunners: true });
      s.registrationVia = via;
    } catch (err) {
      s.registrationError = (err as Error).message;
      ctx.ui.notify(`pi-foreman: could not register required child extensions (${s.registrationError}). Children would run without the guards; run /foreman doctor.`, "error");
    }
  }

  // Fail closed: a child must never start without every required child extension.
  function childLaunchBlock(s: Session, toolName: string): string | undefined {
    if (toolName !== "subagent") return undefined;
    if (!s.registration) {
      return `pi-foreman: required child extensions are not registered${s.registrationError ? ` (${s.registrationError})` : ""}, so children would run without the guards; the launch is blocked. Fix safety.requiredChildExtensions, restart the session and run /foreman doctor.`;
    }
    if (s.childExtensionErrors && s.childExtensionErrors.length > 0) {
      return `pi-foreman: required child extension config has errors (${s.childExtensionErrors.join("; ")}); the launch is blocked. Fix safety.requiredChildExtensions and restart the session.`;
    }
    return undefined;
  }

  /**
   * Role models for the provider the session is on now. The merged config is resolved for the
   * provider at session start; after a model switch to another provider (user, or the foreman
   * model itself) the roles are resolved again for the new one. A failed re-resolve fails closed.
   */
  /** Once per foreman model (session start, model change): no ceremony.reviewModel pair covers it and the reviewer would be swapped or stay on it (reviewerclimb.ts missingPairWarning). Never blocks. */
  async function reviewPairNotice(s: Session, ctx: ExtensionContext, model: { provider: string; id: string } | undefined): Promise<void> {
    if (s.isChild || !model) return;
    try {
      const id = `${model.provider}/${model.id}`;
      const w = missingPairWarning(s.config.config, (await currentRoles(s, ctx)).roles, id);
      if (w) notifyOnce(s, ctx, `review-pair:${id}`, `pi-foreman: ${w}`);
    } catch {
      // advice only
    }
  }

  async function currentRoles(s: Session, ctx: ExtensionContext): Promise<RoleResolution> {
    const provider = idleModel.baseRef(ctx.model)?.provider; // the base model's map while downshifted: children and the finalizer keep it
    if (s.config.source === "cli" && provider !== s.configProvider) {
      const fresh = await loadMergedConfig({ python: pyPath(s), pkgRoot: PKG_ROOT, provider, agentDir: s.agentDir, projectDir: s.cwd, trusted: safeTrusted(ctx), spawner });
      if (fresh.source !== "cli") return { provider, roles: {}, source: "defaults" };
      s.config.roles = fresh.roles;
      s.configProvider = provider;
    }
    return { provider: s.configProvider, roles: s.config.roles, source: s.config.source };
  }

  function payloadCtx(s: Session, ctx: ExtensionContext): PayloadContext {
    let transcriptPath: string | undefined;
    try {
      transcriptPath = ctx.sessionManager.getSessionFile();
    } catch {
      transcriptPath = undefined;
    }
    return { sessionId: s.id, cwd: ctx.cwd, transcriptPath, home: os.homedir() };
  }

  /** `safety.git.protectedBranches` as configured: the strings of the list, nothing else. */
  function configuredProtected(s: Session | undefined): string[] {
    const v = s ? get(s.config.config, "safety.git.protectedBranches") : undefined;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  }

  /** The floor environment of a session: the permission gate and the PR tool's push check build it the same way. */
  function floorEnvOf(s: Session | undefined, cwd: string, sessionDir?: string, readOnlyChild = false): FloorEnv {
    // the session's own scratch dirs, as gateRootsOf has them: the one source of the floors' inside scratch roots (the process env is never read)
    const scratch = s ? (s.isChild ? childScratchDirs : s.scratch.live(null)) : [];
    return baseFloorEnv(cwd, { scratch, ...(s?.agentDir ? { agentDir: s.agentDir } : {}), ...(sessionDir ? { sessionDir } : {}), pkgRoot: PKG_ROOT, protectedBranches: configuredProtected(s), ...(s ? { scratchBase: s.owned.childScratchRoot } : {}), ...(s?.isChild ? { child: true } : {}), ...(s?.isChild && launchBinding?.role === "builder" ? { builder: true } : {}), ...(readOnlyChild ? { readOnlyChild: true } : {}) });
  }

  async function run(s: Session, ctx: ExtensionContext, guard: GuardName, payload: unknown, toolFamily: string | null) {
    const env = buildGuardEnv({ base: process.env, coreDir: CORE_DIR, sessionId: s.id, guard, markerDir: s.markerDir, threshold: guard === "ledger_guard_spawn" ? gateThreshold(s.ceremony) : null });
    const started = Date.now();
    const r = await runGuard({ python: pyPath(s), coreDir: CORE_DIR, guard, payload, env, cwd: ctx.cwd, spawner });
    const outcome = evaluateRun(guard, r, pyPath(s));
    const decision = outcome.kind === "failure" ? "error" : outcome.d.decision;
    // a deny keeps its reason and redacted command like the gate's denials (trace.ts isDeny)
    const deny = decision === "deny" ? { rule: guard, ...denyFields(outcome.kind === "decision" ? outcome.d.reason : "", toolFamily ?? guard, payload && typeof payload === "object" ? (payload as { tool_input?: unknown }).tool_input : undefined, s.isChild ? s.usage.line.role : "foreman", [PKG_ROOT, ctx.cwd]) } : {};
    s.trace?.emit({ event: "guard", guard, toolFamily, decision, latencyMs: Date.now() - started, ...deny });
    return outcome;
  }

  /** The PR feed is on: radar.openPrs.enabled is not false and tools.prHost is auto or gh (what the search refresher and `foreman prs poll` require). */
  function prFeedOn(s: Session): boolean {
    const h = get(s.config.config, "tools.prHost") ?? "auto";
    return openPrsConfig(get(s.config.config, "radar.openPrs")).enabled && (h === "auto" || h === "gh");
  }

  /** Draft handling (tools.prDraft, default true; docs/review.md): needs the review gate and the PR feed, which the readiness rule and the draft state's host facts come from. */
  function draftFlowOn(s: Session): boolean {
    return get(s.config.config, "tools.prDraft") !== false && get(s.config.config, "ceremony.reviewBeforePr") !== false && prFeedOn(s);
  }

  /** The config the PR ops get: the merged safety.ops plus the effective tools.prHost and, when set, tools.prGithubHosts (only a valid list; unset or invalid means the read tools add no host). */
  function prOpsConfig(s: Session): Record<string, unknown> {
    const ops = get(s.config.config, "safety.ops");
    const h = resolveGithubHosts(s.config.config);
    return { ...(ops && typeof ops === "object" ? (ops as Record<string, unknown>) : {}), prHost: get(s.config.config, "tools.prHost") ?? "auto", ...("hosts" in h ? { githubHosts: h.hosts } : {}) };
  }

  function prRun(s: Session, cwd: string, op: PrOp, args: Record<string, unknown>, timeoutMs?: number) {
    return runSafeOp({ python: pyPath(s), script: path.join(PKG_ROOT, "scripts", "safe_ops.py"), op, args, cwd, config: prOpsConfig(s), env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")), spawner, timeoutMs });
  }

  /** Failed PR checks as one line for the review panel block ("" when none, off, or on any failure). */
  function prChecksLine(s: Session): Promise<string> {
    return panelChecksLine({
      enabled: () => s.prPack && !s.isChild,
      // No prompt from a panel: a drift needs the user's answer, so it blocks the line.
      preflight: () => safeOpDriftPreflight(s.gitDrift, s.isChild, s.cwd, os.homedir(), "foreman_pr_checks", { mode: "print", hasUI: false }, (r) => s.trace?.emit(r), "panel-checks"),
      head: () => headOf(s.cwd),
      turn: () => s.turnSeq,
      fetch: async () => {
        const r = await prRun(s, s.cwd, "pr_checks", {}, 30_000);
        return r.kind === "ran" ? checksLine(r.result as never) : "";
      },
    }, s.checksCache);
  }

  // ------------------------------------------------------------------ events

  pi.on("session_start", async (event, ctx) => {
    markCoreStarted(core.claim); // from here on no other copy may take the claim over (registry.ts)
    toolUsage = new ToolUsageTracker();
    // First: startSession, intercom and the sidebar read the identity env, and pi-intercom (loaded after this extension) reads PI_INTERCOM_STABLE_ID.
    const restored = restoreIdentity({ env: process.env, reason: event.reason, piSessionId: ctx.sessionManager.getSessionId?.() ?? "", branch: (ctx.sessionManager.getBranch?.() ?? []) as unknown[], currentName: pi.getSessionName?.(), setSessionName: (name) => pi.setSessionName?.(name) });
    const s = await startSession(ctx);
    if (!s.isChild) {
      try {
        sweepKept(s.agentDir);
      } catch {
        // a failed sweep never stops the session
      }
    }
    if (s.live && !s.isChild) {
      s.paneResume = PaneResume.start({
        agentDir: piAgentDir(process.env, os.homedir()),
        sessionId: s.id,
        sessionFile: ctx.sessionManager.getSessionFile?.(),
        cwd: s.cwd,
        mode: ctx.mode,
        platform,
        env: process.env,
        reason: event.reason,
        hcTerminal: (process.env.HERDR_PANE_ID ?? "").trim() ? null : (process.env.HC_TERMINAL_ID ?? "").trim() || null, // as the live record's hcTerminal (livestate.ts)
        setting: readResumeSetting(piAgentDir(process.env, os.homedir())),
        prevHeartbeatMs: prevHeartbeats.get(s.id) ?? null,
        send: (text) => pi.sendMessage({ customType: RESTART_MESSAGE_TYPE, content: text, display: true }, { triggerTurn: false }), // appended, never system text: the cache prefix stays
        trace: (r) => s.trace?.emit(r),
      });
      prevHeartbeats.delete(s.id);
    }
    recordIdentity(s, ctx, event.reason, restored);
    readoptChildAsks(s, ctx);
    await initSkills(s);
    await mcpChild?.start(get(s.config.config, "roles"), (r) => s.trace?.emit(r), get(s.config.config, "mcp.directProviders"), get(s.config.config, "mcp.directMaxTools"));
    if (hidesDeclaredTools(s.isChild) && get(s.config.config, "retro.report") === false && pi.getActiveTools().includes(REPORT_TOOL)) pi.setActiveTools(pi.getActiveTools().filter((n) => n !== REPORT_TOOL)); // retro.report: false = the tool is not offered (a child keeps a declared tool; execute refuses there)
    restoreToolFloor(s, ctx); // before the hidden set, so a floor tool that is also deferred is active when it is built
    initDeferred(s, ctx);
    restoreCeremonyState(s, ctx, event.reason);
    restoreLedgerRoutes(s, ctx);
    if (!s.isChild) {
      try {
        sweepRecords(s.agentDir, Date.now(), s.id);
      } catch {
        // a failed sweep never stops the session
      }
    } else noToolVerdict(s);
    restoreRounds(s, ctx, event.reason);
    if (hsModel(s)) {
      // the review base fallback: the first HEAD of each repository the session saw (a pre-upgrade entry's per-checkout sightings first; the first one wins)
      for (const l of s.hs.takeLegacy()) if (fs.existsSync(l.cwd)) {
        const key = await repoKeyOf(l.cwd);
        if (key) s.hs.noteBase(key, l.seenHead);
      }
      await hsSee(s, s.cwd);
      persistCeremonyState(s);
    }
    if (!s.isChild && process.env.PI_SUBAGENT_CHILD !== "1") {
      // PR watches survive a restart of the same Pi session (prwatch.ts): resumed, or one visible "lost" notice each.
      s.prCtx ??= ctx;
      s.prWatches.restore(latestWatches((ctx.sessionManager.getBranch?.() ?? []) as unknown[], ctx.sessionManager.getSessionId?.() ?? ""));
      await waits.restore(ctx); // foreman_wait waits do not survive a restart: one visible notice (waitstate.ts)
    }
    if (event.reason === "reload" || event.reason === "resume") restoreStoredPlans(s, ctx);
    emitReady(pi.events as EventBus | undefined, core.claim);
    if (!s.isChild) {
      idleBind = { s, ctx };
      await idleModel.onSessionStart(ctx.sessionManager.getBranch?.() ?? []); // before applyForemanModel: a downshift left open is closed first
    }
    if (!s.isChild && (event.reason === "startup" || event.reason === "new" || (event.reason === "resume" && restored.status === "restored"))) await applyForemanModel(s, ctx, restored.status === "restored" ? restored.entry.model : undefined);
    await registerChildExtensions(s, ctx);
    const orderNotice = s.isChild ? null : loadOrderNotice(s.cwd, s.agentDir, PKG_ROOT);
    if (orderNotice) notifyOnce(s, ctx, "load-order", orderNotice, "warning");
    const provider = ctx.model?.provider;
    if (!s.isChild && provider && get(s.config.config, `providers.${provider}`)) {
      const registry = ctx.modelRegistry as unknown as RegistryLike;
      for (const gap of modelGaps(s.config.config, provider, registry)) notifyOnce(s, ctx, `model-gap:${gap}`, gap.includes(".roles.foreman.idle)") ? `pi-foreman: ${gap}; the foreman idle rung is unavailable and the downshift stays off. Fix the provider map or the login, then run /foreman doctor.` : `pi-foreman: ${gap}; launches that need it fail. Fix the provider map or the login, then run /foreman doctor.`);
      for (const w of familyWarnings(s.config.roles, provider, registry)) notifyOnce(s, ctx, `family:${w}`, w);
    }
    await reviewPairNotice(s, ctx, ctx.model);
    herdrMeta.start(ctx, get(s.config.config, "herdr.groupTag") !== false);
    evalOwnAsk(s);
    if (!s.isChild) bgTrace = (r) => s.trace?.emit(r);
    remoteWatch?.stop();
    remoteWatch = null;
    if (!s.isChild) {
      remoteWatch = new RemoteWatcher({
        agentDir: s.agentDir,
        opener: () => openerIntercomId(process.env, s.agentDir, s.id),
        fetchTimeoutSeconds: () => get(s.config.config, "sessions.remote.fetchTimeoutSeconds"),
        wake: (label, kind, text) => void waits.childNotice(s.id, label, kind, text),
        notify: (msg, level) => ctx.ui.notify(msg, level),
        trace: (rec) => s.trace?.emit(rec),
      });
      remoteWatch.start();
    }
    childBlocked?.stop();
    childBlocked = null;
    if (!s.isChild && process.env.PI_SUBAGENT_CHILD !== "1") {
      const watch = remoteWatch;
      // one custom message of its own type (never foreman_wake, never system text); the quiet "answered" note starts no turn
      childBlocked = new ChildBlocked({
        agentDir: s.agentDir,
        sessionId: s.id,
        opener: () => openerIntercomId(process.env, s.agentDir, s.id),
        seconds: () => noticeSeconds(get(s.config.config, "sessions.blockedNoticeSeconds")),
        carry: s.carry,
        contact: (child) => (watch as RemoteWatcher | null)?.lastContact(child),
        send: (text, wake) => {
          let idle = true;
          try {
            idle = ctx.isIdle();
          } catch {
            // a stale context: treat as idle
          }
          pi.sendMessage({ customType: CHILD_BLOCKED_TYPE, content: text, display: true }, wake ? (idle ? { triggerTurn: true } : { deliverAs: "followUp" }) : { triggerTurn: false });
        },
        trace: (rec) => s.trace?.emit(rec),
      });
      childBlocked.start();
    }
    sidebarLive.start(ctx, { python: pyPath(s), pkgRoot: PKG_ROOT, agentDir: s.agentDir, sessionId: s.id, symbols: get(s.config.config, "ui.symbols"), spinner: get(s.config.config, "ui.spinner") !== false, live: s.live });
    if (!s.isChild && s.live) {
      s.extStatus.start();
    }
    // Host pressure (pressure.ts): the foreman samples on a timer; the launch path only reads the file.
    if (!s.isChild && !s.pressureSampler) {
      s.pressureSampler = new PressureSampler({
        file: pressurePath(s.agentDir),
        workspace: s.cwd,
        config: () => s.config.config,
        run: deps.pressureRun ?? ((args, signal) => runScript(s, "foreman_pressure.py", args, 20_000, undefined, signal)),
        trace: (r) => s.trace?.emit(r),
        fixture: process.env[PRESSURE_FIXTURE_ENV]?.trim() || undefined,
      });
      s.pressureSampler.start();
    }
  });
  // After core-adapter's own session_start handler: Pi runs handlers in registration order, so the allowed set is known when Pi's MCP extension loads its config.
  mcpChild?.install();

  /** The first tool-usage snapshot (toolusage.ts): declared (active minus hidden), hidden, the listed and hidden skills, each tool's package. */
  function startToolUsage(s: Session, listed: SkillRef[]): void {
    let active: string[] = [];
    const sources: Record<string, string> = {};
    try {
      active = pi.getActiveTools();
      for (const t of pi.getAllTools()) sources[t.name] = packageOf(t.sourceInfo);
    } catch {
      // a host without the tool api records empty sets
    }
    const hidden = new Set(deferred.hidden);
    const skillFiles: Record<string, string> = {};
    for (const k of [...listed, ...skillState.hidden]) if (k.filePath) skillFiles[k.name] = k.filePath;
    toolUsage.start({ declared: active.filter((n) => !hidden.has(n)), hidden: [...hidden], skillsListed: listed.map((k) => k.name), skillsHidden: skillState.hidden.map((k) => k.name), skillFiles, sources });
  }

  /** Write the tool-usage line when it is the first or `used`, `found` or `skillsRead` changed. */
  function flushToolUsage(s: Session): void {
    const line = toolUsage.take({ session: s.id, role: s.usage.line.role, workspace: s.usage.line.workspace, foremanSession: s.usage.line.foremanSession });
    if (line) appendUsage(s.usage.file, line);
  }

  /** Skill visibility at session start: the rules from the merged config; a child splits the skills its role names now (its prompt is made from the agent file), the foreman splits its listed skills at the first turn. */
  async function initSkills(s: Session): Promise<void> {
    skillState.rules = skillRulesOf(s.config.config);
    skillState.hidden = [];
    skillState.split = false;
    skillState.hint = "";
    if (!s.isChild) return;
    const refs = await childSkillRefs(get(s.config.config, "roles"), s.usage.line.role, s.cwd);
    skillState.hidden = splitSkills(refs, skillState.rules).hidden;
    skillState.split = true;
  }

  /** Re-activates the registered floor tools another extension's tool reset left inactive (toolfloor.ts): append only. */
  function restoreToolFloor(s: Session, ctx: ExtensionContext): string[] {
    try {
      const missing = missingFloorTools({ all: pi.getAllTools().map((t) => t.name), active: pi.getActiveTools(), isChild: s.isChild, planMode: planModeOn((ctx.sessionManager.getBranch?.() ?? []) as unknown[]) });
      if (!missing.length) return [];
      pi.setActiveTools([...pi.getActiveTools(), ...missing]);
      s.trace?.emit({ event: "tools_floor_restored", names: missing.join(",") });
      return missing;
    } catch {
      // a host without the tool api restores nothing
      return [];
    }
  }

  /** The hidden set, once per session start from the merged config, the recorded un-hidden names and the plan-mode decision. */
  function initDeferred(s: Session, ctx: ExtensionContext): void {
    const branch = (ctx.sessionManager.getBranch?.() ?? []) as unknown[];
    const recorded = latestDeferredLoaded(branch);
    const base = get(s.config.config, "tools.deferred");
    const merged = mergeDeferredLayers(base, safeTrusted(ctx) ? [{ who: "project", value: readProjectDeferred(s.cwd) }] : []);
    for (const w of merged.warnings) notifyOnce(s, ctx, `deferred:${w}`, `pi-foreman: ${w}`, "warning");
    deferred.patterns = merged.list;
    deferred.loaded = new Set(recorded?.names ?? []);
    deferred.hint = "";
    modelOnly.done = false;
    modelOnly.hint = "";
    deferred.planMode = recorded ? recorded.planMode : planModeOn(branch);
    deferred.trace = (r) => s.trace?.emit(r);
    let declared: string[] = [];
    try {
      declared = pi.getActiveTools();
    } catch {
      // a host without the tool api hides nothing
    }
    // The hook runs only for an active tool_search, so without one nothing is hidden.
    // A child hides nothing (childtools.ts): pi-subagents 0.89 aborts a child whose registered allowlisted tool is missing from the request.
    // The branch that adds the role's searchable names for a child stays, behind that rule.
    const patterns = s.isChild ? [...deferred.patterns, ...searchableOf(get(s.config.config, "roles"), s.usage.line.role)] : deferred.patterns;
    deferred.hidden = hidesDeclaredTools(s.isChild) && declared.includes("tool_search") ? hiddenSet({ patterns, declared, loaded: [...deferred.loaded], planMode: deferred.planMode }) : [];
    if (!recorded || recorded.planMode !== deferred.planMode) persistDeferred();
    if (deferred.hidden.length) {
      s.trace?.emit({ event: "tools_deferred", count: deferred.hidden.length, names: deferred.hidden.join(",") });
      try {
        pi.setActiveTools(pi.getActiveTools()); // re-run the loadout hooks with the set in place
      } catch {
        // the next change of the active set applies it
      }
    }
  }

  pi.on("session_shutdown", async (event, ctx) => {
    const s = sessionFor(ctx);
    if (!s) return;
    shutdownAborts.get(s.id)?.abort(); // closes every open permission dialog of this session without an answer
    shutdownAborts.delete(s.id);
    ownAsks.get(s.id)?.releaseAll();
    ownAsks.delete(s.id);
    for (const [id, h] of [...ledgerHolds]) if (h.sid === s.id) releaseLedgerHold(id);
    gateRuntimes.delete(s.id);
    gateOwnerMessages.delete(s.id);
    try {
      s.registration?.dispose();
    } catch {
      // already gone
    }
    s.registration = undefined;
    s.panels.clear();
    s.prWatches.clear();
    s.extStatus.clear();
    s.selfWarm.onShutdown();
    // a detached owner script does not outlive its session: killed, recorded as aborted
    if (s.scriptRun) {
      s.scriptRun.shutdown = true;
      s.scriptRun.stop("aborted");
      await s.scriptRun.done.catch(() => undefined);
    }
    addonSeen.delete(s.id);
    if (!s.isChild) {
      syncKeepalives(s, ctx);
      idleModel.stop();
    }
    sweepScratch(s);
    closeChildAsks(s, event?.reason === "reload");
    if (!s.isChild && event?.reason !== "reload") {
      try {
        fs.rmSync(recordSessionDir(s.agentDir, s.id), { recursive: true, force: true }); // verdict records; a reload keeps them for the runs still going
      } catch {
        // the next start's sweep takes it; a failed removal never stops the shutdown
      }
    }
    await s.show?.idle();
    s.paneResume?.stop(event?.reason); // before live.stop(): the signal flag it reads is also what stop() writes as endedBy
    s.paneResume = null;
    s.live?.stop();
    s.openPrs?.stop();
    await s.pressureSampler?.stop();
    usageFooter.drop(s.id);
    compactionGate.reset(s.id);
    pythonCache.drop(s.id);
    sessions.delete(s.id);
  });

  pi.on("model_select", async (event, ctx) => {
    const ps = sessionFor(ctx);
    if (ps) tracePoint(ps, event.model);
    const warmed = sessionFor(ctx);
    if (warmed) warmed.selfWarm.onModelChange(); // a model change drops the provider cache and starts a new warm budget
    bridgeTtl.apply(process.env, ttlSetting, event.model?.provider, process.env.PI_SUBAGENT_CHILD === "1");
    try {
      bridgeIso.apply(process.env, sessionFor(ctx)?.agentDir ?? piAgentDir(process.env, os.homedir()), isoSetting, event.model?.provider);
    } catch {
      // doctor reports the folder
    }
    const risks = event.model?.provider === BRIDGE_PROVIDER ? projectClaudeRisks(ctx.cwd) : [];
    if (risks.length) ctx.ui.notify(`pi-foreman: project Claude Code config runs in claude-bridge turns: ${risks.join(", ")}. Fix: ${PROJECT_CLAUDE_FIX}`, "error");
    if (ps) await reviewPairNotice(ps, ctx, event.model);
    if (applyingModel) return;
    if (event.source === "set" || event.source === "cycle") userPickedModel = true;
    if (event.source === "set" || event.source === "cycle") idleModel.onUserPick(); // the user's pick is the base, not ours to restore
    const ms = sessionFor(ctx);
    if (ms && !ms.isChild && event.model?.provider === BRIDGE_PROVIDER && event.previousModel?.provider !== BRIDGE_PROVIDER) {
      const b = await ms.claudeCfg.check(ctx.cwd, "claude-bridge turns", driftAsk(ctx, ms.trace), (r) => ms.trace?.emit(r));
      if (b) ctx.ui.notify(`${b.reason}\nThe next claude-bridge prompt asks again.`, "error");
    }
  });

  // Project Claude Code config drift: ask before a claude-bridge prompt runs (claudedrift.ts).
  pi.on("input", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild || ctx.model?.provider !== BRIDGE_PROVIDER) return { action: "continue" as const };
    const b = await s.claudeCfg.check(ctx.cwd, "this claude-bridge prompt", driftAsk(ctx, s.trace), (r) => s.trace?.emit(r));
    if (!b) return { action: "continue" as const };
    ctx.ui.notify(b.reason, "error");
    if (!ctx.hasUI) process.stderr.write(`${b.reason}\n`);
    return { action: "handled" as const };
  });

  // Every model request, so every run start: typed/RPC prompts, runs a child's completion
  // notice starts (triggerTurn), follow-ups, steers (R2-H1). Blocking = abort before the request.
  pi.on("context", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild || ctx.model?.provider !== BRIDGE_PROVIDER) return undefined;
    const b = await s.claudeCfg.check(ctx.cwd, "this claude-bridge run", driftAsk(ctx, s.trace), (r) => s.trace?.emit(r));
    if (!b) return undefined;
    ctx.abort();
    ctx.ui.notify(b.reason, "error");
    if (!ctx.hasUI) process.stderr.write(`${b.reason}\n`);
    pi.sendMessage({ customType: "pi-foreman-blocked", content: `The claude-bridge run was stopped before the model request.\n${b.reason}`, display: true }, { triggerTurn: false });
    return undefined;
  });

  // Compaction and branch summaries on claude-bridge start a separate Claude Code process that
  // re-reads .pi/claude-bridge.json (bridge src/index.ts:576-596); mid-run compaction comes
  // before the next request's `context` event. Cancel on unapproved drift (R3-H1). Effective
  // only when pi-foreman loads before pi-claude-bridge (the doctor checks the order).
  async function bridgeSummaryGate(ctx: ExtensionContext, what: string): Promise<{ cancel: true } | undefined> {
    const s = sessionFor(ctx);
    if (!s || s.isChild || ctx.model?.provider !== BRIDGE_PROVIDER) return undefined;
    const b = await s.claudeCfg.check(ctx.cwd, `this ${what}`, driftAsk(ctx, s.trace), (r) => s.trace?.emit(r));
    if (!b) return undefined;
    ctx.ui.notify(`${b.reason}\nThe ${what} was cancelled.`, "error");
    if (!ctx.hasUI) process.stderr.write(`${b.reason}\n`);
    return { cancel: true };
  }
  pi.on("session_before_compact", async (_event, ctx) => {
    sessionFor(ctx)?.selfWarm.onCompactStart(); // no warm goes out while a compaction runs
    const r = await bridgeSummaryGate(ctx, "claude-bridge compaction summary");
    const s = sessionFor(ctx);
    if (r) s?.selfWarm.onCompactFailed(); // cancelled by the gate: the cache is as warm as before
    if (!r && s && !s.isChild) s.retro.prepare(boundLedger(s.markerDir, s.id));
    return r;
  });
  pi.on("session_compact", async (event, ctx) => {
    const s = sessionFor(ctx);
    if (!s) return;
    compactionGate.reset(s.id);
    s.noticeVerdicts.clear(); // the prefix is rewritten anyway: the next request decides afresh
    s.selfWarm.onCompact();
    if (!s.isChild) void onForemanCompact(s, ctx, event.compactionEntry.summary, event.reason);
  });
  pi.on("session_compact_failed", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s) return;
    compactionGate.reset(s.id);
    s.selfWarm.onCompactFailed();
    s.retro.drop();
  });
  /** D8: re-put the section with the digest; append the retro entry (counters + Retro section) and a V hint. */
  async function onForemanCompact(s: Session, ctx: ExtensionContext, summary: string, reason: string): Promise<void> {
    const section = s.retro.commit();
    if (section) s.foremanSection = section;
    const r = await runScript(s, "foreman_retro.py", [...retroInputs(s, ctx, "--session"), "--json"]);
    let counters: unknown = null;
    try {
      counters = r.ok ? JSON.parse(r.text) : null;
    } catch {
      // counters: no data
    }
    try {
      appendCompactionRetro(s.cwd, s.id, { reason, counters, retro: extractRetro(summary) });
      writeHint(boundLedger(s.markerDir, s.id), ["V"], "retro written", s.retro.hints, hintOpts(s));
    } catch (err) {
      notifyOnce(s, ctx, "retro-file", `pi-foreman: could not write the compaction retro: ${(err as Error).message}`);
    }
  }
  pi.on("session_before_tree", async (_event, ctx) => bridgeSummaryGate(ctx, "claude-bridge branch summary"));

  // Pi's own cache warmer is never used: pi-foreman sends every idle warm itself (selfwarm.ts), so Pi is always told `stop`.
  // It answers first and reads nothing: a throwing hook would make Pi fall back to its own decision.
  pi.on("cache_warming_decision", async () => ({ action: "stop" as const }));
  pi.on("turn_start", async (_event, ctx) => {
    const s = sessionFor(ctx);
    // A launch whose tool_result never came does not keep finalization off past its turn.
    s?.pendingLaunches.clear();
    s?.mutating.clear();
    s?.commandCalls.clear();
    s?.questionCalls.forEach(releaseQuestion);
    s?.questionCalls.clear();
    s?.runningCalls.clear();
  });
  pi.on("turn_end", async (event, ctx) => {
    const s = sessionFor(ctx);
    if (!s) return;
    s.selfWarm.requestFailed(); // the request of this turn is over (a reply already ended it; an error or abort did not)
    toolUsage.noteMessage(event.message);
    flushToolUsage(s);
  });
  pi.on("agent_start", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s) return;
    s.idleCtx = ctx;
    s.running = true;
    if (s.isChild) return;
    syncKeepalives(s, ctx);
    idleBind = { s, ctx };
    idleModel.setRunning(true);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const s = await ensureSession(ctx);
    s.stopContinued = false;
    const restored = restoreToolFloor(s, ctx);
    if (restored.length && deferred.patterns.length && deferred.hidden.length) {
      // a floor tool restored here that the deferred list names is hidden like the rest
      const more = hiddenSet({ patterns: deferred.patterns, declared: restored, loaded: [...deferred.loaded], planMode: deferred.planMode }).filter((n) => !deferred.hidden.includes(n));
      if (more.length) {
        deferred.hidden = [...deferred.hidden, ...more];
        try {
          pi.setActiveTools(pi.getActiveTools());
        } catch {
          // the next change of the active set applies it
        }
      }
    }
    if (deferred.hidden.length) {
      let codemode = false;
      try {
        codemode = pi.getActiveTools().includes("codemode");
      } catch {
        // no tool api: the plain wording
      }
      deferred.hint = deferredHint(deferred.hidden, codemode);
      event.systemPromptOptions.sections[DEFERRED_SECTION] = deferred.hint;
    } else deferred.hint = "";
    if (!modelOnly.done) {
      modelOnly.done = true;
      try {
        if (pi.getActiveTools().includes("codemode")) modelOnly.hint = modelOnlyHint(pi.getAllTools().filter((tool) => tool.exposure === "model-only").map((tool) => tool.name));
      } catch {
        // no tool api: no line
      }
    }
    if (modelOnly.hint) event.systemPromptOptions.sections[MODEL_ONLY_SECTION] = modelOnly.hint;
    if (!s.isChild) {
      const listed = (event.systemPromptOptions as { skills?: (SkillRef & { disableModelInvocation?: boolean })[] }).skills;
      if (Array.isArray(listed)) {
        if (!skillState.split) {
          skillState.hidden = splitSkills(listed.filter((k) => !k.disableModelInvocation), skillState.rules).hidden.map((k) => ({ name: k.name, description: k.description, filePath: k.filePath }));
          skillState.split = true;
        }
        const gone = new Set(skillState.hidden.map((k) => k.name));
        if (gone.size) listed.splice(0, listed.length, ...listed.filter((k) => !gone.has(k.name)));
      }
    }
    if (skillState.hidden.length) {
      skillState.hint = skillsHint(skillState.hidden);
      event.systemPromptOptions.sections[SKILLS_SECTION] = skillState.hint;
    } else skillState.hint = "";
    if (!toolUsage.started) startToolUsage(s, (event.systemPromptOptions as { skills?: SkillRef[] }).skills ?? []);
    flushToolUsage(s);
    if (!s.isChild) {
      // Idle downshift: a custom message has not passed message_end yet, so its cause is read here; a user message carries the input handler's.
      idleBind = { s, ctx };
      // An inbound intercom message (Pi 1.2+ triggerTurn run) gets its cause and downshift in the handler registered
      // after registerClose (close claims a foreman:close run first); every other run is handled here.
      const customType = (event as { message?: { customType?: unknown } }).message?.customType;
      const inbound = intercomInbound({ hook: "before_agent_start", messageType: (event as { messageType?: unknown }).messageType, message: (event as { message?: unknown }).message });
      if (!inbound) await idleModel.beforeTurn((event as { messageType?: string }).messageType === "custom" ? causeOfCustom(customType) : s.turn.cause);
    }
    // Pi 1.2: a wake or child-notice run (messageType "custom") also lands here, without a prompt.
    // Only a user run sets the review intent and triages; the section below is built for every run.
    const prompt = userPromptOf(event);
    // ceremony.heavyThreshold strict: heavySignals hit in this request. It rides as a message for this prompt only, never in the
    // system text, so the system prompt stays byte-stable between prompts (prompt cache).
    let triageHint = "";
    if (prompt !== null) {
      if (!s.isChild) gateOwnerMessages.set(s.id, [prompt, ...(gateOwnerMessages.get(s.id) ?? [])].slice(0, MAX_OWNER_MESSAGES));
      if (!gateFirstPrompt.has(s.id)) gateFirstPrompt.set(s.id, prompt);
      // D7: a child never triages; only the foreman's request can escalate on a signal.
      const signals = s.isChild ? [] : promptSignals(prompt, get(s.config.config, "ceremony.heavySignals"));
      if (signals.length) {
        if (heavyStrict(s)) {
          // D6 strict: keyword hits are a hint for the foreman's own triage, not an escalation.
          triageHint = `Signals seen: ${signals.join(", ")} — heavy only if the heavy criteria apply.`;
          s.trace?.emit({ event: "triage_hint", signals: signals.join(", ") });
        } else setCeremony(s, escalate(s.ceremony, "heavy", "auto", `heavy signal in the request: ${signals.join(", ")}`));
      }
    }
    if (s.isChild) {
      const mcpNote = mcpChild?.note();
      if (mcpNote) event.systemPromptOptions.sections["pi-foreman-mcp"] = mcpNote;
      // every ceremony.ledgerHelper mode: reviewer roles learn to close V through review_verdict (instructions/reviewer.md).
      if (!REVIEW_ROLES.includes(s.usage.line.role)) return;
      if (reviewerInstructionsCache === undefined) {
        try {
          reviewerInstructionsCache = fs.readFileSync(path.join(PKG_ROOT, "instructions", "reviewer.md"), "utf8");
        } catch {
          reviewerInstructionsCache = null;
        }
      }
      const extra = applyVariants(reviewerInstructionsCache ?? "", promptVariants(s)).trim();
      if (extra) event.systemPromptOptions.sections["pi-foreman"] = extra;
      return;
    }
    if (instructionsCache === undefined) {
      try {
        instructionsCache = fs.readFileSync(path.join(PKG_ROOT, "instructions", "foreman.md"), "utf8").replaceAll("{{planSkeleton}}", () => path.join(PKG_ROOT, "instructions", "plan-skeleton.html")); // fixed per installation: the same bytes every turn
      } catch {
        instructionsCache = null;
      }
    }
    if (instructionsCache === null) notifyOnce(s, ctx, "instructions", "pi-foreman: instructions/foreman.md is missing; the foreman runs without its rules.");
    if (s.orientation === undefined) {
      // Once per session, so every later turn (and a compaction re-put) carries identical bytes.
      s.orientation = get(s.config.config, "ceremony.orientation.enabled") === false ? "" : await collectOrientation(ctx.cwd, { reads: readLimits(get(s.config.config, "ceremony.foremanReads")).before, maxLines: Math.max(1, Number(get(s.config.config, "ceremony.orientation.maxLines")) || 120), roots: await piRootsOf(s), platform, msysNoPathconv: Object.keys(msysEnv(platform, s.config.config)).length > 0 });
      s.trace?.emit({ event: "orientation", lines: s.orientation ? s.orientation.split("\n").length : 0 });
    }
    const text = [applyVariants(instructionsCache ?? "", promptVariants(s)), tierLine(s.ceremony), finishLine({ [s.ceremony.tier]: requiredOf(s, s.ceremony.tier) }, s.ceremony.tier)].concat(s.orientation).filter(Boolean).join("\n\n");
    s.retro.base = text;
    s.foremanSection = withDigest(text, s.retro.digest);
    event.systemPromptOptions.sections["pi-foreman"] = s.foremanSection;
    return triageHint ? { message: { customType: "foreman_triage_hint", content: triageHint, display: false } } : undefined;
  });
  let piInstallRoot: Promise<string | null> | undefined;
  /** The roots of the running pi: its coding-agent package dir (resolved from the package itself, never a literal path), the global npm root, this package's root. */
  async function piRootsOf(s: Session): Promise<PiRoots> {
    return { installRoot: await installRootOfPi(), npmRoot: s.owned.npmRoot ?? null, pkgRoot: PKG_ROOT };
  }
  function installRootOfPi(): Promise<string | null> {
    piInstallRoot ??= (async () => {
      try {
        const d = ((await import("@earendil-works/pi-coding-agent")) as { getPackageDir?: () => unknown }).getPackageDir?.();
        return typeof d === "string" && d ? d : null;
      } catch {
        return null;
      }
    })();
    return piInstallRoot;
  }
  /** Values for the tagged variant lines of the prompt files (ledgercall.ts applyVariants). */
  function promptVariants(s: Session): Record<string, string> {
    return {
      ledgerHelper: ledgerHelperMode(get(s.config.config, "ceremony.ledgerHelper")),
      heavyThreshold: heavyStrict(s) ? "strict" : "eee843d",
      reviewPerRevision: get(s.config.config, "ceremony.reviewPerRevision") === false ? "off" : "on",
      trivialPath: trivialBuilderPath(get(s.config.config, "ceremony.required")) ? "builder" : "off",
      ladder: "on",
      // Launch sizing (sizing.ts): the builder launch carries size and risk ("off" only renders the eee843d baseline).
      sizing: sizingConfig(s.config.config).enabled ? "on" : "off",
      // Multi-session plan for a heavy task with several phases (sessions.md; "off" only renders the eee843d baseline).
      multiSession: "on",
      "tools.pr": s.prPack ? "on" : "off",
      // The foreman_report rule (retro.report: false takes the tool away, so the rule goes too).
      "retro.report": get(s.config.config, "retro.report") === false ? "off" : "on",
      // Foreman rulings never put a diff fact in scope (review rule; "off" only renders the eee843d baseline).
      factRulings: "on",
      // Launch skeletons and tier rules (retro-harvest; "off" only renders the eee843d baseline).
      launchBriefs: "on",
      // Research markers (research.ts; "off" only renders the eee843d baseline).
      research: "on",
      // Sibling repos are out of scope and the orientation names the bundled package roots (orient.ts; "off" only renders the eee843d baseline).
      orientationRoots: "on",
      // A reviewer PASS marks its items (reviewmarks.ts; "off" only renders the eee843d baseline).
      reviewMarks: "on",
      // The foreman_show explain rule (show.ts; "off" only renders the pre-show baseline).
      show: "on",
      // The foreman_protect rule in Approvals ("off"/absent only renders the pre-protect baseline).
      protect: "on",
      // The foreman_script rules ("off"/absent only renders the baseline before owner scripts).
      ownerScript: "on",
      // Owner-readable plans, questions and notes (ownertext.ts; "off" only drops the added lines).
      ownerReadable: "on",
      // The working-ahead rules ("off"/absent only renders the baseline before them).
      proactive: "on",
      // ceremony.planReview at heavy: the plan-review step before the checkpoint (planreview.ts).
      planReview: planReviewOn(s.config.config, "heavy") ? "on" : "off",
      // ladder.reviewPanel with shadow models: the foreman issues the listed shadow launches (panel.ts).
      reviewPanel: panelConfig(s.config.config).shadows.length > 0 ? "on" : "off",
    };
  }
  /** ceremony.heavyThreshold: anything but "eee843d" is the default strict. */
  function heavyStrict(s: Session): boolean {
    return get(s.config.config, "ceremony.heavyThreshold") !== "eee843d";
  }
  // Review S3: on Pi 1.2 a run a custom message starts while idle (wake, child notice) passes
  // before_agent_start (messageType "custom") and gets the section there. On Pi 1.1 such a run
  // skipped before_agent_start, and its later model calls rebuilt the prompt from Pi's base
  // options, which lack the section (Pi records a `pi-foreman: null` patch). Event contexts cannot
  // reach the base options, so the request keeps the section: the null patch is dropped from what
  // the provider gets. Kept for Pi 1.1 compatibility (peer range `*`) and because after a
  // compaction (its stored head lacks the section, review N2) the cached text is put back.
  /** `ctx.getSystemPrompt()`: what the request's head renders to (a forced prompt verbatim), or undefined without the api. */
  const livePrompt = (ctx: ExtensionContext): string | undefined => {
    try {
      return ctx.getSystemPrompt();
    } catch {
      return undefined;
    }
  };
  pi.on("context_with_system", async (event, ctx) => {
    const s = sessionFor(ctx);
    if (s?.isChild) s.selfWarm.capture(forcedProjection(event.messages, livePrompt(ctx))); // a child replays its request unchanged (a forced prompt projected as Pi does after this hook)
    if (!s || s.isChild) return undefined;
    let messages = keepSection(event.messages, "pi-foreman", s.foremanSection);
    // after a compaction the stored head lacks the stable hint sections too: put them back the same way
    for (const [name, text] of [[DEFERRED_SECTION, deferred.hint], [MODEL_ONLY_SECTION, modelOnly.hint], [SKILLS_SECTION, skillState.hint]]) if (text) messages = keepSection(messages ?? event.messages, name, text) ?? messages;
    // a section that first appears mid-session sits in another place of Pi's replay than in the fresh build: align the order
    // providers with mid-conversation system messages render the head and each later patch apart: folding patches into the head would break their prompt cache
    const midConvo = (ctx.model as { compat?: { supportsMidConvoSystemMessages?: boolean } } | undefined)?.compat?.supportsMidConvoSystemMessages === true;
    const live = livePrompt(ctx); // no prompt api: undefined, the order stays
    if (!midConvo && typeof live === "string") messages = alignSections(messages ?? event.messages, live) ?? messages;
    s.selfWarm.capture(forcedProjection(subagentNoticeWrap(messages ?? event.messages), live)); // pi-subagents wraps its notices after this hook, Pi projects a forced prompt after it; the warm replays what the request carries
    return messages ? { messages } : undefined;
  });
  // Review S12: each run (a wake or child-notice run too) gets its own single stop-gate continue.
  pi.on("agent_settled", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (s) s.stopContinued = false;
    s?.live?.onSettled(ctx.isIdle?.());
    radarTouch(s, ctx);
    if (s) {
      s.idleCtx = ctx;
      s.selfWarm.requestFailed(); // an errored or aborted request ended no turn: its flag must not hold the warm back
      s.running = false;
    }
    if (s && !s.isChild) {
      syncKeepalives(s, ctx);
      s.selfWarm.start();
      idleBind = { s, ctx };
      idleModel.setRunning(false);
    }
    // Last, so a throw in the wake send skips nothing above. A wake that resolved during this run starts its own run (pi defers a triggerTurn sent while it emits agent_settled), after the stopContinued reset.
    if (s && !s.isChild) waits.settled(s.id);
  });

  /** Running bg_run tasks of a session, read from disk at most every 2 s (the footer asks on each render). */
  const addonSeen = new Map<string, { at: number; on: boolean }>();
  function addonTasksRunning(s: Session): boolean {
    const now = Date.now();
    const hit = addonSeen.get(s.id);
    if (hit && now - hit.at < 2000) return hit.on;
    let on = false;
    try {
      on = readOwnAddonTasks(s.cwd, s.id).length > 0;
    } catch {
      // no task records: none running
    }
    addonSeen.set(s.id, { at: now, on });
    return on;
  }
  /** What the session is doing right now, for the warm tier (selfwarm.ts). Synchronous, never throws. */
  function warmSignals(s: Session): WarmSignals {
    let idle = true;
    try {
      idle = s.idleCtx ? s.idleCtx.isIdle() : true;
    } catch {
      idle = false; // a stale context counts as a running turn
    }
    const w = waits.active(s.id);
    const other = addonTasksRunning(s) ? "bg_task" : w.length > 0 ? "wait" : null;
    const strongA = s.activeRuns.size > 0 || s.pendingLaunches.size > 0 || launchWaits.holding > 0 ? "subagent" : other;
    // for the tier only: a launch with an open permission ask is not working (active run, pending launch or held launch alike)
    const open = new Set(childAskWatches.get(s.id)?.openDirs() ?? []);
    const park = childAskParks.get(s.id);
    const waiting = (launch: string | undefined): boolean => !!launch && open.has(childAskDir(s.agentDir, s.id, launch));
    const working = open.size === 0 ? strongA === "subagent" : [...s.activeRuns].some((r) => !waiting(park?.launchFor(r))) || [...s.pendingLaunches].some((c) => !waiting(park?.launchOfCall(c))) || launchWaits.holdingWhere((r) => !waiting(park?.launchFor(r))) > 0;
    const strongWorking = working ? "subagent" : other;
    const parentWaitSince = s.isChild ? parentOpen.get(s.id)?.since ?? null : undefined;
    return { strongA, strongWorking, ...(parentWaitSince !== undefined ? { parentWaitSince } : {}), turn: s.running || !idle, question: s.questionCalls.size > 0, dialog: s.live?.isBlocked() === true, command: s.commandCalls.size > 0, toolRunning: s.runningCalls.size > 0 };
  }
  /** A message is queued in the session (a stale context counts as queued: no warm). */
  function warmQueued(s: Session): boolean {
    try {
      return s.idleCtx ? s.idleCtx.hasPendingMessages() : false;
    } catch {
      return true;
    }
  }
  /** A claude-bridge config approval is pending: the warm replay would start Claude Code on unapproved config (security re-check gate). */
  function warmDriftPending(s: Session): boolean {
    const ctx = s.idleCtx;
    return !!ctx && ctx.model?.provider === BRIDGE_PROVIDER && s.claudeCfg.pending(ctx.cwd).length > 0;
  }
  /** The point Pi's own auto-compaction fires at for a model (window minus the effective reserve); null when off or unknown. */
  function piRuntimePoint(model: { provider?: string; id?: string; contextWindow?: number } | null | undefined): number | null {
    try {
      return runtimePoint(model, pi.getSettings());
    } catch {
      return null;
    }
  }
  /** Trace the runtime compaction point of the session's model (session start, model change). */
  function tracePoint(s: Session, model: ExtensionContext["model"]): void {
    s.trace?.emit({ event: "compaction_point", model: model ? `${model.provider}/${model.id}` : null, point: piRuntimePoint(model) });
  }
  /** Final-warm compaction: the only ctx.compact() call of the idle cache; foreman sessions only, above 0.6 x the context window (a null runtime point does not block it). The Retro section rides on this compaction. */
  function idleCompact(s: Session): { point: number | null; model: string | null } | null {
    const ctx = s.idleCtx;
    if (!ctx || s.isChild) return null;
    const point = piRuntimePoint(ctx.model);
    if (!compactionGate.decideFinal(s.id, ctx.getContextUsage())) return null;
    ctx.compact({ customInstructions: RETRO_INSTRUCTIONS });
    return { point, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null };
  }
  /** Copy new Pi cache-warming usage entries to the usage log (keepalive.ts); never throws. */
  function syncKeepalives(s: Session, ctx: ExtensionContext | null): KeepaliveResult {
    const none = { newEntries: 0, lastReadAt: null };
    if (s.isChild || !ctx) return none;
    try {
      return s.keepalive.sync({ entries: ctx.sessionManager.getEntries(), file: s.usage.file, line: s.usage.line, registry: ctx.modelRegistry as never, trace: (r) => s.trace?.emit(r), onLine: (l) => s.selfWarm.noteWarmLine(l) });
    } catch {
      return none;
    }
  }

  /** Layer 6: while a child's supervisor request is open, only that role's tools (supervisor.ts). */
  function supervisorBlock(s: Session | undefined, toolName: string, input: unknown): { block: true; reason: string } | undefined {
    if (!s) return undefined;
    const hit = s.supervisor.check(toolName, input, (role) => roleToolsFrom(s.config.roles, get(s.config.config, "roles"), role));
    if (!hit) return undefined;
    s.trace?.emit({ event: "supervisor_request", role: hit.role, decision: "blocked_tool", toolFamily: toolName });
    return { block: true, reason: hit.reason };
  }

  const normFile = (p: string): string => (platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p);
  /** Record child result locations (resolved, so no `..` survives); a location containing the cwd is skipped. */
  const recordChild = (s: Session, paths: string[]): void => recordFiles(s.childFiles, paths, (p) => normFile(path.resolve(p)), s.cwd);
  /** Pi's bash tool_result `details.fullOutputPath` is the session's own readable log; the realpath spelling too. Never the result text. */
  const recordBashLog = (s: Session, details: unknown): void => recordBashOutputLog(s.bashLogs, details, platform);

  const knownRun = (s: Session) => (runId: string): boolean => s.launchedRoles.has(runId) || s.runs.has(runId);

  /** Item 4: a path the session's own work may change, inside its workspace root and outside the owned roots (handoff dirs, agent state). */
  const ownWorkPath = (s: Session, file: string): boolean => {
    const realOf = (p: string): string => {
      try {
        return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
      } catch {
        return p;
      }
    };
    const ws = workspaceOf(s.cwd).root;
    const targets = [file, realOf(file)];
    if (![ws, realOf(ws)].some((r) => targets.some((t) => underOwned(r, t, platform)))) return false;
    return ![...s.owned.readWrite, ...s.owned.readOnly].some((o) => [o, realOf(o)].some((r) => targets.some((t) => underOwned(r, t, platform))));
  };

  /** Read budget (budget.ts): foreman only; undefined = let the call go on. */
  function readBudgetCheck(s: Session | undefined, ctx: ExtensionContext, toolName: string, callId: string, input: unknown) {
    if (!s || s.isChild || !isReadCall(toolName, input)) return undefined;
    const inp = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const file = toolName === "read" ? resolveToolPath(inp.path, ctx.cwd, os.homedir()) : null;
    // ceremony.ledgerHelper tool/bash: a pure-ledger shell command is not a re-check (ledgercall.ts).
    const ledgerOnly = toolName === "bash" && ledgerHelperMode(get(s.config.config, "ceremony.ledgerHelper")) !== "off" && isLedgerOnlyCommand(inp.command);
    // harness-friction: a handoff poll (ruling.md, owned dirs) or a git worktree add|list|prune is no read (recheckexempt.ts).
    // R12 item 8: reads of the session's own bg_run outputs (`.pi/tasks/<session id>-*`) are exempt too, another session's are not.
    const handoff = recheckExempt(toolName, input, { cwd: ctx.cwd, home: os.homedir(), platform, owned: s.owned, ownTasks: ownTaskReadable([ctx.cwd, workspaceOf(ctx.cwd).root, s.usage.line.workspace], s.usage.line.foremanSession, platform) });
    const exempt = ledgerOnly || handoff || s.supervisor.open.size > 0 || (file !== null && inRecorded(s.childFiles, normFile(file)));
    // MCP and subagent get|guide calls are counted under the name `read`, after the exemptions above.
    const d = s.budget.check(READ_CLASS.has(toolName) ? toolName : "read", callId, readLimits(get(s.config.config, "ceremony.foremanReads")), exempt, coordinationCall(toolName, input));
    if (d.kind === "remind") {
      if (s.planPhase) return undefined; // the plan phase reads freely: no reminder
      s.readNotices.set(callId, d.text);
      s.trace?.emit({ event: "read_budget", phase: d.phase, count: d.count, action: "remind" });
    }
    return undefined;
  }

  /** Child read budget (childreads.ts): children only; undefined = let the call go on. */
  function childReadCheck(s: Session | undefined, toolName: string, callId: string, input: unknown) {
    if (!s || !s.isChild) return undefined;
    const role = s.usage.line.role;
    const found = childReadLimits(s.config.config, role, launchBinding?.reads);
    const limits = found ? { ...found, role } : null;
    const d = s.childReads.check(toolName, callId, input, limits);
    if (d.kind === "warn") {
      s.readNotices.set(callId, d.text);
      s.trace?.emit({ event: "child_read_budget", role, count: d.count, action: "warn", allowance: limits?.deny });
    } else if (d.kind === "deny") {
      s.trace?.emit({ event: "child_read_budget", count: d.count, action: "deny", allowance: limits?.deny, ...denyFields(d.reason, toolName, input, role) });
      return { block: true as const, reason: d.reason };
    }
    return undefined;
  }

  // Knob 3 launch-wait (launchwait.ts): held launch results, released by run end, supervisor request, abort or timeout.
  const launchWaits = new LaunchWaits();
  const steerWatches = new Map<string, SteerWatch>();
  const sessionStartMs = Date.now();
  const steerWatchFor = (s: Session): SteerWatch => {
    let w = steerWatches.get(s.id);
    if (!w) steerWatches.set(s.id, (w = new SteerWatch(() => process.env.PI_FOREMAN_HANDOFF_DIR, sessionStartMs)));
    return w;
  };
  /** A newer ruling in the handoff dir, taken before a gated action (child launch, checkpoint press); "" when none. */
  const rulingPickup = (s: Session, gate: string): string => (s.isChild ? "" : pickupRuling(steerWatchFor(s), gate));
  // A child's policy ask (childask.ts, plan Addendum 5): per parent session one watch over the ask dirs of its running children.
  const childAskWatches = new Map<string, ChildAskWatch>();
  const childAskWatchFor = (s: Session, ctx: ExtensionContext): ChildAskWatch => {
    let w = childAskWatches.get(s.id);
    if (!w) childAskWatches.set(s.id, (w = new ChildAskWatch((a) => answerChildAsk(s, ctx, a), (e) => reportChildAsk(s, e, ctx))));
    return w;
  };
  // D3: answers of asks whose run ended while the child waited, and the run -> launch map of resumes (childaskpark.ts); memory only, per session
  const childAskParks = new Map<string, ChildAskPark>();
  const parkFor = (s: Session): ChildAskPark => {
    let p = childAskParks.get(s.id);
    if (!p) childAskParks.set(s.id, (p = new ChildAskPark()));
    return p;
  };
  /**
   * A run of `launchId` ended. With no open ask of that launch (queued or shown) the dir and watch go; with one they stay, the dialog stays open and the
   * line to add to the run's result is returned (the owner's answer is parked in reportChildAsk).
   */
  const closeChildAsk = (s: Session, launchId: string | null): string | null => {
    if (!launchId) return null;
    const dir = childAskDir(s.agentDir, s.id, launchId);
    const open = childAskWatches.get(s.id)?.openAsk(dir);
    if (open) {
      parkFor(s).markEnded(dir);
      return `pi-foreman: the run ended while waiting for the owner on ${open.tool}: ${open.payload.replace(/\s+/g, " ").trim().slice(0, 100)}; the question is still open, do not work around it.`;
    }
    childAskWatches.get(s.id)?.remove(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  };
  /** `closeChildAsk` for a run end event: the added line goes out as its own message beside the run's completion notice. */
  const closeChildAskAtRunEnd = (s: Session, launchId: string | null): void => {
    const line = closeChildAsk(s, launchId);
    if (line) pi.sendMessage({ customType: "pi-foreman-ask-open", content: line, display: true }, { triggerTurn: false });
  };
  /** Stop the watch; the dirs go too, except at a reload (children keep running and the new session re-adds them at its start). */
  const closeChildAsks = (s: Session, keepDirs = false): void => {
    childAskWatches.get(s.id)?.stop();
    childAskWatches.delete(s.id);
    childAskParks.delete(s.id);
    if (!keepDirs) fs.rmSync(childAskParentDir(s.agentDir, s.id), { recursive: true, force: true });
  };
  /** session_start: every ask dir under this session's own child-asks folder is watched again (a ruling that exists is skipped by `add`). */
  const readoptChildAsks = (s: Session, ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(childAskParentDir(s.agentDir, s.id), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return; // no folder: nothing to re-add
    }
    for (const name of names) childAskWatchFor(s, ctx).add(path.join(childAskParentDir(s.agentDir, s.id), name));
  };
  /** Aborts at the session's shutdown (any reason): the signal of every owner dialog of the session. */
  const shutdownAborts = new Map<string, AbortController>();
  const shutdownSignal = (s: Session): AbortSignal => {
    let c = shutdownAborts.get(s.id);
    if (!c) shutdownAborts.set(s.id, (c = new AbortController()));
    return c.signal;
  };
  const reportChildAsk = (s: Session, e: ChildAskEvent, ctx?: ExtensionContext): void => {
    const verdict = e.kind === "answered" ? (e.allow ? "allow" : "deny") : "deny";
    gateRuntimeOf(s).log.record({ tool: e.ask.tool, layer: "child-ask", verdict, rule: e.ask.entry || "ask", reason: `child run ${e.ask.run} (${e.ask.role}): ${e.kind}${e.detail ? ` ${e.detail}` : ""}`, input: e.ask.payload, role: e.ask.role, kind: "owner" });
    if (e.kind !== "answered" || !childAskParks.get(s.id)?.isEnded(e.ask.dir)) return;
    // the run ended while this ask was open (D3): the answer is parked for exactly this call, once, and the parent is told (data, not an instruction)
    const w = childAskWatches.get(s.id);
    if (!w?.openAsk(e.ask.dir)) {
      // the dir goes too: a recognised resume re-creates and watches it (resumeAskDir), an unrecognised one finds no dir and gets the gone denial
      w?.remove(e.ask.dir);
      fs.rmSync(e.ask.dir, { recursive: true, force: true });
    }
    if (!e.ask.inputHash) return; // no hash, no parking: the resumed run's ask gets a dialog
    parkFor(s).park(parkKey(e.ask.dir, e.ask.tool, e.ask.cwd, e.ask.inputHash), e.allow === true);
    let idle = true;
    try {
      idle = ctx?.isIdle() ?? true;
    } catch {
      // a stale context: treat as idle
    }
    pi.sendMessage({ customType: "pi-foreman-ask-answered", content: `pi-foreman notice: the owner answered the question the ended run (${e.ask.role}, launch ${e.ask.run}) left open on ${e.ask.tool}: ${e.allow ? "allowed" : "denied"}. The run can be resumed; its identical call is answered once without asking again.`, display: true }, idle ? { triggerTurn: true } : { deliverAs: "followUp" });
  };
  /** The parent's answer to one child ask (r79 item 5): the owner dialog in the parent's own pane with the child's role, run and the full command; never a model. */
  async function answerChildAsk(s: Session, ctx: ExtensionContext, a: ChildAsk): Promise<ChildAnswer> {
    if (!ctx.hasUI) return { allow: false, reason: NO_PANE_TEXT };
    const rt = gateRuntimeOf(s);
    // D3: the owner already answered this exact call of a run that ended while it waited: used once, no dialog
    const parked = a.inputHash ? parkFor(s).take(parkKey(a.dir, a.tool, a.cwd, a.inputHash)) : undefined;
    if (parked !== undefined) {
      s.trace?.emit({ event: "ask_parked_used", role: a.role, toolFamily: a.tool, decision: parked ? "allow" : "deny" });
      return parked ? { allow: true, how: "allow-parked" } : { allow: false, reason: "pi-foreman: the owner denied this call while the run had ended; it is not run again. Report this line to the foreman and continue with what you can.", how: "deny-parked" };
    }
    const dangerName = /^danger-[a-z-]+$/.test(a.cause) ? a.cause : null;
    const proposed = dangerName ? rememberOf(dangerName, a.tool, a.payload, undefined, undefined, s.cwd) : undefined;
    // under the parent's own mode allow a sentence would never be used: only the exact-command rule is offered
    const remember = proposed && rt.store.resolve().mode === "allow" ? { ...proposed, noSentence: true } : proposed;
    const ans = await withBlockedOn(herdrEvents, BLOCK_APPROVAL, `ask ${a.n}: child ${a.role} ${a.tool}`, () => askOwner({ tool: a.tool, payload: a.payload, cwd: a.cwd, cause: a.cause, ...(a.reason ? { classifierReason: a.reason } : {}), child: { role: a.role, run: a.run }, ...(remember ? { remember } : {}) }, ownerDeps(s, ctx, rt)));
    if (ans.allow === false && ans.how === "aborted") return { allow: false, reason: ans.reason, how: ans.how, noRuling: true };
    return ans.allow === true ? { allow: true, how: ans.how === "remember" ? "allow-remember" : ans.refused ? "allow-remember-refused" : "allow-once" } : { allow: false, reason: ans.reason, how: ans.how };
  }
  let childAskChain: Promise<void> = Promise.resolve();
  pi.events?.on(SUPERVISOR_SURFACED_EVENT, (data: unknown) => launchWaits.onSupervisorRequest(data));
  pi.on("session_shutdown", async () => launchWaits.abortAll());

  /**
   * Run-end state hint (readonlystate.ts, plan readonly-target B.1-B.2): at a reviewer or explorer launch, one picture per tree root the run works in, taken before the child starts.
   * A launch that includes any other role, a workflow launch and a resume of an unknown or non-read-only run get the `not pictured` entry (no notice at run end).
   */
  async function noteReadonlyStart(s: Session, callId: string, input: Record<string, unknown>, cwd: string): Promise<void> {
    try {
      const action = actionOf(input);
      if (action !== null && action !== "resume") return;
      const target = action === "resume" ? resumeTarget(input) : null;
      const roles = action === "resume" ? (target ? (s.launchedRoles.get(target) ?? []) : []) : subagentAgents(input);
      if (!readonlyRoles(roles)) {
        capSet(s.readonlyStartByCall, callId, { kind: "not pictured" });
        return;
      }
      const ceiling = (c: string): string => treeCeilingOf({ cwd: c, agentDir: s.agentDir, foremanSession: s.id });
      const known = target ? s.readonlyRoots.get(target) : undefined;
      const roots = known ?? [...new Set((action === "resume" ? [cwd] : launchRunCwds(input, cwd)).map((c) => treeRootOf(c, ceiling(c))).filter((r): r is string => !!r))];
      capSet(s.readonlyStartByCall, callId, await takeStartEntry(roots, os.homedir(), readonlyGit, deps.readonlyDeadlineMs));
    } catch {
      // no entry: the run end traces `not_compared`
    }
  }
  /**
   * Run end of a run this session launched: the end picture runs in the background; a difference is one notice, never a stop.
   * A reviewer or explorer run end without a start entry gets only a trace; it may also fire for a run this session did not launch (a reloaded session cannot tell them apart).
   */
  function readonlyRunEnd(s: Session, runId: string, data: unknown): void {
    const entry = s.readonlyStart.get(runId);
    s.readonlyStart.delete(runId);
    const ended = runEndOf(data);
    const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    if (!entry) {
      const workflow = d.awaitedByWorkflow === true || !!d.parentWorkflowRunId;
      if (!workflow && (ended?.role === "reviewer" || ended?.role === "explorer")) s.trace?.emit({ event: "readonly_state_diff", runId, role: ended.role, outcome: "not_compared", reason: "no start entry" });
      return;
    }
    if (entry.kind !== "picture") return;
    const role = [...new Set(s.launchedRoles.get(runId) ?? [])].join("+") || ended?.role || "child";
    void compareRunEnd(entry, os.homedir(), readonlyGit, deps.readonlyDeadlineMs)
      .then((r) => {
        const lines = traceLines(r);
        s.trace?.emit({ event: "readonly_state_diff", runId, role, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}), roots: entry.roots.join("; "), count: entry.roots.length, lines: r.perRoot.reduce((n, x) => n + x.lines.length, 0), ...(lines.length ? { items: lines.join("; ") } : {}) });
        if (r.outcome === "unchanged") return;
        let idle = true;
        try {
          idle = s.idleCtx ? s.idleCtx.isIdle() : true;
        } catch {
          // a stale context: treat as idle
        }
        pi.sendMessage({ customType: "pi-foreman-readonly-state", content: noticeText(role, runId, r), display: true }, idle ? { triggerTurn: true } : { deliverAs: "followUp" });
      })
      .catch(() => undefined);
  }

  for (const channel of RUN_END_EVENTS) {
    pi.events?.on(channel, (data) => {
      launchWaits.onRunEnd(data);
      for (const s of sessions.values()) {
        s.supervisor.onRunEnd(data);
        endActive(s.activeRuns, data);
        const runId = data && typeof data === "object" ? (data as { runId?: unknown }).runId : undefined;
        if (typeof runId === "string") s.attention.onRunEnd(runId);
        if (typeof runId === "string") s.hs.ended(runId); // a run that ended, with or without a verdict, no longer counts as running
        if (typeof runId === "string") {
          const ended = s.scratch.onRunEnd(runId);
          finishScratch(s, ended);
          const resumedLaunch = s.isChild ? null : parkFor(s).resumedRunEnd(runId);
          closeChildAskAtRunEnd(s, ended ?? resumedLaunch);
        }
        if (typeof runId === "string" && !s.isChild) {
          s.childRuns.onRunEnd(runId);
          s.live?.touch();
          // D27: a builder run that ends (any outcome) is work of the prompt it ends in, also when it was launched before that prompt
          if ((s.launchedRoles.get(runId) ?? []).includes("builder")) s.work.builders++;
        }
        // a review run launched before a reload (restored route, no launched roles) that ends not completed: its record is ignored too (T7)
        if (typeof runId === "string" && !s.isChild && !s.launchedRoles.has(runId) && s.ledgerByRun.get(runId)?.review) {
          const status = runEndOf(data)?.status;
          if (status !== undefined && status !== "completed") failedReviewRun(s, runId);
        }
        if (typeof runId === "string" && s.launchedRoles.has(runId)) {
          const ended = runEndOf(data);
          s.ladder.onRunEnd(ended);
          // policy_block (launchwait.ts): the stop record; the run is not climb-eligible and the harness never relaunches it.
          if (ended?.policyBlock && !s.isChild) s.trace?.emit({ event: "child_policy_block", role: ended.role ?? (s.launchedRoles.get(runId) ?? [])[0] ?? "?", runId, kind: "policy_block", outcome: ended.status, exit: ended.status === "completed" ? 0 : 1, decision: "stopped" });
          // repeat_refusal (launchwait.ts, R12 item 4): the child stopped itself after the same refusal twice; the same family, the parent's stop record
          if (ended?.repeatRefusal && !s.isChild) s.trace?.emit({ event: "child_repeat_refusal", role: ended.role ?? (s.launchedRoles.get(runId) ?? [])[0] ?? "?", runId, kind: "repeat_refusal", outcome: ended.status, exit: ended.status === "completed" ? 0 : 1, decision: "stopped" });
          // Review results with their occasion (occasion.ts); the verdict consumers see only the counting ones.
          const reviewLaunch = s.isChild ? undefined : s.reviewRuns.byRun.get(runId);
          const hsOwner = s.isChild ? null : s.hs.ownerOf(runId);
          const reviewResults = s.isChild ? [] : reviewResultsOfRun(s, runId, data);
          // a record of a run that did not complete is ignored (T7)
          if (!s.isChild && reviewResults.length === 0 && (s.launchedRoles.get(runId) ?? []).some((r) => REVIEW_ROLES.includes(r))) {
            if (s.reviewRecords.get(runId)) s.trace?.emit({ event: "review_record_ignored", runId, reason: "not_completed" });
            failedReviewRun(s, runId);
          }
          if (!s.isChild) s.reviewerFails.onRun(runId, reviewResults.filter((r) => r.counts && r.role === "reviewer").map((r) => failedItemIds(r.items)), boundLedger(s.markerDir, s.id));
          if (reviewResults.length > 0) recordRunFindings(s, runId, reviewResults);
          if (!s.isChild) {
            const roles = s.launchedRoles.get(runId) ?? [];
            // Lane 3f: review_done for every review run (re-reviews and panel shadows too, kind shadow); a review that ended without a result is a no-verdict.
            const done = reviewResults.length > 0 ? reviewResults.map((r) => ({ role: r.role, decision: r.verdict ?? (r.incomplete ? "incomplete" : "no-verdict"), shadow: r.shadow !== null })) : roles.filter((r) => REVIEW_ROLES.includes(r)).map((role) => ({ role, decision: "no-verdict", shadow: shadowRun(reviewLaunch) }));
            for (const d of done) s.trace?.emit({ event: "review_done", role: d.role, decision: d.decision, runId, ...(d.shadow ? { kind: "shadow" } : {}), ...(hsOwner !== null ? { occasion: "high-stakes" } : {}) });
            // Item-only re-review: the failed items of the latest FAIL verdict, cleared by a pass.
            for (const r of reviewResults) if (r.counts) {
              s.trace?.emit(s.critique.onReview(r.findings, r.role, runId, reviewLaunch?.lines));
              const items = failedItemIds(r.items);
              if (items.length > 0) s.failItems = items;
              else if (r.verdict === "pass") s.failItems = [];
              if (r.verdict === "pass" && (r.occasion === "item" || r.occasion === "pre-pr")) s.ladder.probeRisks.clear(); // R39: the bypass probes were asked for and the review passed
            }
            // Lane 3g: the real end of each role of the run, with the run's priced cost and duration from the presence row.
            const info = s.childRuns.info(runId);
            const status = runEndOf(data)?.status;
            for (const role of roles) s.trace?.emit({ event: "role_result", role, runId, exit: status === "completed" ? 0 : 1, ...(info?.ms != null ? { ms: info.ms } : {}), ...(info ? { cost: Math.round(info.cost * 10000) / 10000 } : {}) });
          }
          // A panel shadow (panel.ts) reports to its pending panel, also without a result (null: not run).
          if (reviewLaunch?.bind) s.panels.ended(reviewLaunch.bind, reviewLaunch.panel?.shadows[0] ?? "", reviewResults.length > 0 ? (s.reviewRuns.findings.get(runId) ?? Promise.resolve([])).then((b) => b.find((x) => !x.result.primary)?.findings ?? null) : Promise.resolve(null));
          if (!s.isChild) recordPlanReviews(s, runId, reviewResults);
          if (!s.isChild) s.brief.onRunEnd(runEndOf(data), s.launchedRoles.get(runId), (id, text) => storeBrief(s, id, text));
          if (!shadowRun(reviewLaunch)) for (const step of stepsOfRunEnd(data, reviewResults)) s.steps[step]++;
          const verdicts = reviewVerdictsOfRunEnd(reviewResults);
          const roots = s.isChild ? null : (s.reviewRoots.get(runId) ?? null); // a launch whose checkout is unknown (or evicted) clears the session-wide entry only
          s.reviewGates = gatesVerdict(s.reviewGates, roots, verdicts, Date.now(), runId);
          persistCeremonyState(s);
          if (!s.isChild) onRunEndReview(s, runId, reviewResults, verdicts.length > 0, roots, data);
          const cited = s.retro.launchItems.get(runId) ?? [];
          s.retro.launchItems.delete(runId);
          if (!s.isChild && verdicts.length) for (const [f, items] of hintTargets(s, runId, cited)) writeHint(f, items, `review ${verdicts.map((v) => (v ?? "no verdict").toUpperCase()).join(", ")} (run ${runId.slice(0, 8)})`, s.retro.hints, hintOpts(s));
        }
        if (!s.isChild && typeof runId === "string" && s.launchedRoles.has(runId)) {
          // PR gate: the verdict is recorded with HEAD of the run's cwd if unchanged since launch (reviews.ts).
          const start = s.launchHeads.get(runId);
          s.launchHeads.delete(runId);
          const startTrees = s.launchTrees.get(runId);
          s.launchTrees.delete(runId);
          const hsRoot = s.hs.ownerOf(runId);
          if (hsRoot !== null && hsModel(s)) hsRunEnd(s, runId, hsRoot, data, start, startTrees);
          const counting = reviewResultsOfRun(s, runId, data).filter((x) => x.counts && x.verdict !== null);
          let nth = 0;
          for (const r of reviewsWithOutput(data, counting)) {
            const full = counting[nth]?.role === r.role ? counting[nth] : undefined;
            const first = nth++ === 0;
            s.reviewFailOpen = r.verdict === "fail";
            s.reviewSync = s.reviewSync.then(async () => {
              const cwd = r.cwd ?? s.cwd;
              const h = await reviewedHeadVia(start, startTrees, cwd, await headOf(cwd));
              const prev = s.reviews.findLast((x) => x.kind === "code");
              const top = await rootOf(cwd);
              const rec: ReviewRecord = { role: r.role, verdict: r.verdict, head: h.head, ...(top ? { cwd: top } : {}), ...(h.why ? { why: h.why } : {}), ...(full && (full.occasion === "pre-pr" || full.occasion === "item") ? { occasion: full.occasion } : {}), ...(await loopFieldsOf(s, runId, full, "code", worktreeTree(cwd, true))) };
              appendReview(s.reviews, rec);
              if (rec.verdict === "pass" && (rec.occasion === "pre-pr" || rec.occasion === "item")) await hsNormalPass(s, rec.cwd ?? cwd, runId, rec.head).catch(() => undefined); // clears a high-stakes FAIL when this run got its findings
              if (rec.verdict === "pass" && rec.occasion === "pre-pr") s.sentBack = false; // only a [pre-pr] PASS ends a send-back
              s.sentBackHeads = sentBackUnmark(s.sentBackHeads, rec);
              s.live?.flush(); // the pill's review facts
              if (first) loopCheck(s, runId, prev, rec);
              // pi-subagents wrote the run's output file before this run-end event; the last line names the head the verdict covers
              if (r.outputPath) appendHeadLine(r.outputPath, h);
              s.trace?.emit({ event: "review_recorded", role: r.role, runId, verdict: r.verdict, head: h.head, why: h.why, ...(h.via ? { via: h.via } : {}) });
              persistCeremonyState(s);
            });
          }
        }
        if (!s.isChild && typeof runId === "string") readonlyRunEnd(s, runId, data);
      }
    });
  }

  /** Workspace key, remote repository and branch of a checkout for the findings store; each null when it cannot be told. */
  async function repoIdentity(s: Session, cwd: string): Promise<{ workspace: string | null; repo: string | null; branch: string | null }> {
    let workspace: string | null = null;
    try {
      workspace = workspaceKeyOf(cwd, get(s.config.config, "retro.workspaceKey"));
    } catch {
      // a key that does not sanitise: the row stays unkeyed
    }
    return { workspace, repo: await repoOf(cwd).catch(() => null), branch: currentBranch(cwd) };
  }

  /**
   * Run-end findings (findings.ts): each review result is recorded through foreman_findings.py
   * (awaited, 10 s, fail-soft), its findings traced. A completed gate primary of a panel opens a
   * pending panel; its shadow instruction goes to the held launch result, else to its own message.
   * Reviewer launches wait on `sync`.
   */
  function recordRunFindings(s: Session, runId: string, results: ReturnType<typeof reviewResultsOfRunEnd>): void {
    const launch = s.reviewRuns.byRun.get(runId);
    const entry = { text: Promise.resolve(""), claimed: false };
    const work = (async (): Promise<RunEndFindings> => {
      const cwd = results.find((r) => r.cwd)?.cwd ?? s.cwd;
      const head = await headOf(cwd);
      const where = await repoIdentity(s, cwd);
      const out = await onReviewRunEnd(
        {
          results,
          launch,
          context: { session: s.usage.line.foremanSession, agentDir: s.agentDir, runId, cwd, head, live: s.ladder.live.get("reviewer") ?? null, now: Date.now(), ...where },
          tmpDir: s.markerDir,
        },
        (args, input) => runScript(s, "foreman_findings.py", args, RECORD_TIMEOUT_MS, input),
      );
      for (const rec of out.traces) s.trace?.emit(rec);
      return out;
    })().catch((): RunEndFindings => ({ traces: [], byResult: [] }));
    capSet(s.reviewRuns.findings, runId, work.then((o) => o.byResult));
    const primary = launch?.panel && !launch.bind ? results.find((r) => r.primary && r.role === "reviewer") : undefined;
    if (launch?.panel && primary) {
      const cfg = panelConfig(s.config.config);
      const primaryFindings = work.then((o) => o.byResult.find((x) => x.result.index === primary.index)?.findings ?? []);
      s.panels.open({ id: runId, gate: launch.panel.gate, primary: launch.panel.primary, task: launch.task ?? "", expected: launch.panel.shadows, primaryFindings, visible: cfg.visible, waitMs: cfg.waitSeconds * 1000 });
      const text = shadowInstruction(launch.panel.gate, launch.panel.shadows, cfg.waitSeconds);
      entry.text = work.then(() => text);
      capSet(s.reviewRuns.blocks, runId, entry);
    }

    s.reviewRuns.sync = s.reviewRuns.sync.then(() => work.then(() => undefined));
    // the shadow instruction must reach the foreman now: a steer mid-turn, else a new turn (a deferred message would wait for the owner)
    void entry.text.then((text) => {
      if (text && !entry.claimed) pi.sendMessage({ customType: "pi-foreman-panel", content: text, display: true }, { triggerTurn: true });
    });
  }

  /** Loop guard (reviewloop.ts): the kind, state and finding set of a counting review round, for its ReviewRecord. */
  async function loopFieldsOf(s: Session, runId: string, r: ReviewResult | undefined, kind: ReviewKind, state: Promise<string | null>): Promise<Pick<ReviewRecord, "kind" | "state" | "sig" | "work">> {
    return { kind, state: (await state) ?? "", sig: r?.verdict === "fail" ? sigOf(r.items, r.findings) : [], work: s.work.builders + s.work.edits };
  }

  /** Loop guard: the round just recorded (last of its kind in `s.reviews`) against `prev`, the last round of that kind before the run; a trip sets the stop. One round per run. */
  function loopCheck(s: Session, runId: string, prev: ReviewRecord | undefined, cur: ReviewRecord): void {
    if (!cur.kind) return;
    const rule = loopVerdictOf(cur.kind, prev ? { verdict: prev.verdict, state: prev.state ?? "", sig: prev.sig ?? [], ...(prev.work !== undefined ? { work: prev.work } : {}) } : null, { verdict: cur.verdict, state: cur.state ?? "", sig: cur.sig ?? [], ...(cur.work !== undefined ? { work: cur.work } : {}) });
    if (!rule) return;
    s.loopStop = { rule, kind: cur.kind, sig: cur.sig ?? [] };
    s.trace?.emit({ event: "review_loop", rule, kind: cur.kind, runId });
    persistCeremonyState(s);
  }

  /** A panel shadow launch (panel.ts): it never counts for steps, rounds or review_done. */
  function shadowRun(launch: ReviewLaunch | undefined): boolean {
    return !!launch?.bind;
  }

  /** The readable plans among `paths`, one per resolved plan path: a page and its markdown copy named together are one plan (checkpoint.ts readPlan returns the page's path for both). */
  function readPlansOnce(paths: readonly string[], o: Parameters<typeof readPlan>[1]): { plan: PlanFile; raw: string }[] {
    const seen = new Set<string>();
    const out: { plan: PlanFile; raw: string }[] = [];
    for (const p of paths) {
      const rp = readPlan(p, o);
      if ("plan" in rp && !seen.has(rp.plan.path)) {
        seen.add(rp.plan.path);
        out.push({ plan: rp.plan, raw: p });
      }
    }
    return out;
  }

  /** Plan review (planreview.ts): each primary `[plan-review]` verdict is kept for the plan bytes on disk now; traced `plan_review`. */
  function recordPlanReviews(s: Session, runId: string, results: ReturnType<typeof reviewResultsOfRunEnd>): void {
    const opts = { cwd: s.cwd, home: os.homedir(), platform, scratchDir: editModeOfSession(s).scratchDir };
    const plans = planPathsOf(s.reviewRuns.byRun.get(runId)?.files ?? [], opts.scratchDir);
    const reviewed = new Set<string>();
    for (const r of planReviewResults(results)) {
      s.trace?.emit({ event: "plan_review", model: r.model, decision: r.verdict });
      const findings = Promise.resolve(findingsOfResult(r));
      for (const rp of readPlansOnce(plans, opts)) {
        s.planReviews.record(rp.plan.path, { hash: rp.plan.hash, verdict: r.verdict, model: r.model, findings });
        s.planReviews.keepReviewed(rp.plan.path, rp.plan.hash);
        s.planReviews.closeLaunch(rp.plan.path);
        s.show?.planReviewed(r.verdict === "pass", rp.plan.hash); // plan page state and milestone (show.ts)
        reviewed.add(rp.plan.path);
        const state = rp.plan.hash;
        s.reviewSync = s.reviewSync.then(async () => {
          const prev = s.reviews.findLast((x) => x.kind === "plan");
          const rec: ReviewRecord = { role: r.role, verdict: r.verdict, head: null, kind: "plan", state, sig: r.verdict === "fail" ? sigOf(r.items, r.findings) : [] };
          appendReview(s.reviews, rec);
          loopCheck(s, runId, prev, rec);
        });
        const rounds = s.planReviews.lineage(rp.plan.path)?.rounds ?? 1;
        saveStored(s.agentDir, rp.plan.hash, rp.plan.topic, { review: { verdict: r.verdict, model: r.model, rounds } }); // survives /reload (checkpoint.ts)
      }
    }
    for (const p of reviewed) {
      if (s.planReviews.lineage(p)?.latest.verdict === "pass" && s.planReviews.reviewedText(p) !== null && parentPhaseByReview(s) && isTriaged(s.ceremony)) {
        // the plan's latest verdict is a PASS on the current version: below heavy a plan phase a parent's launch started ends here (persisted below)
        s.planPhase = false;
        delete process.env.PI_FOREMAN_PLAN_PHASE; // child shells must not see the ended phase
        s.trace?.emit({ event: "plan_phase", decision: "off", cause: "plan_review" });
      } else if (s.planPhase && s.planPhaseOrigin === "parent") {
        const cause = s.ceremony.tier === "heavy" ? "heavy" : s.planReviews.lineage(p)?.latest.verdict !== "pass" ? "not_pass" : s.planReviews.reviewedText(p) === null ? "no_reviewed_text" : "untriaged";
        s.trace?.emit({ event: "plan_phase", decision: "kept", cause });
      }
    }
    persistRounds(s);
  }

  const pressureNow = deps.pressureNow ?? Date.now;
  /** The pressure file as the launch path sees it (missing or stale = ok). */
  const pressureOf = (s: Session): PressureState => readPressure(pressurePath(s.agentDir), sampleSecondsOf(s.config.config), pressureNow());

  /**
   * High pressure, fan-out width 1: the first launch of an assistant message runs, the others are queued behind it (refused with a
   * wake: one `pressure` queue wait lists their arguments once no run is active). A `tasks` call keeps its first task and queues the rest.
   * Returns the refusal text of a queued call, else undefined.
   */
  async function narrowLaunch(s: Session, ctx: ExtensionContext, callId: string, input: Record<string, unknown>, raw: Record<string, unknown>, p: PressureState): Promise<string | undefined> {
    const gen = s.launchBatch.generation;
    const pos = s.launchBatch.pickedPositionOf(callId);
    const rest = pos > 0 ? null : (narrowTasks(input), narrowTasks(raw));
    if (pos <= 0 && !rest) return undefined;
    if (s.pressureQ?.gen !== gen) s.pressureQ = { gen, entries: [], started: false };
    const q = s.pressureQ;
    q.entries.push(rest ?? raw);
    let failed = "";
    if (!q.started) {
      q.started = true;
      s.trace?.emit({ event: "launch_narrowed", width: 1, reasons: p.reasons.join(",") });
      const w = await waits.startPressure(ctx, { kind: "pressure", mode: "queue", args: q.entries, pollMs: sampleSecondsOf(s.config.config) * 1000, boundSeconds: Infinity, note: "queued launches" });
      if ("error" in w) failed = ` (no wait could be started: ${w.error}; relaunch once a run has ended)`;
    }
    return rest ? undefined : `${queuedReason(p.reasons)}${failed}`;
  }

  /** Child deny reasons per child session (one child run): count by exact reason (R12 item 4). */
  const childDenyCounts = new Map<string, number>();

  /**
   * R12 item 4: the second identical stop-eligible deny reason (exact string, matching REPEAT_STOP_REASONS) within one child run stops
   * that run (repeatRefusalStop); other deny reasons (cd outside the workspace, worktree paths, temp-dir writes ...) never stop it.
   */
  function repeatedDeny(s: Session, ctx: ExtensionContext, reason: string, sentence: string = reason): { block: true; reason: string } | undefined {
    // `sentence` is the floor's own text: the tool and fragment a floor denial appends (gate.ts blocked) are neither matched nor counted
    if (!s.isChild || !REPEAT_STOP_REASONS.some((re) => re.test(sentence))) return undefined;
    // a path rule of a custom worktree root (s.owned.worktreeGlobs) is a worktree path like `*.worktrees/*`: never stop-eligible
    if ((s.owned.worktreeGlobs ?? []).some((g) => sentence.includes(`path rule '${g}'`))) return undefined;
    const key = `${s.id}\0${sentence}`;
    const n = (childDenyCounts.get(key) ?? 0) + 1;
    childDenyCounts.set(key, n);
    return n >= 2 ? repeatRefusalStop(s, ctx, reason) : undefined;
  }
  /** Child sessions stopped by repeatRefusalStop, with the block reason every later tool call of the run gets. */
  const repeatStopped = new Map<string, string>();

  /**
   * R12 item 4 (the policy_block family, launchwait.ts): the child marks its run failed with REPEAT_REFUSAL_ERROR (stderr, exit code 1, the
   * block reason the transcript keeps), aborts its turn and traces `child_repeat_refusal`; the parent's runEndOf reads the marker as
   * repeatRefusal: failed, no retry, no climb. Every later tool call of the run is blocked with the same text, so there is no third attempt.
   */
  function repeatRefusalStop(s: Session, ctx: ExtensionContext, reason: string): { block: true; reason: string } {
    const msg = `pi-foreman: ${REPEAT_REFUSAL_ERROR}: the same refusal twice in this run, so the run is stopped and not retried. Report it to the foreman. Refusal: ${reason}`;
    repeatStopped.set(s.id, msg);
    s.trace?.emit({ event: "child_repeat_refusal", runId: launchBinding?.launchId ?? s.id, role: s.usage.line.role || "?", reason, decision: "stopped" });
    try {
      process.stderr.write(`${msg}\n`);
    } catch {
      // the exit code and the block reason still carry it
    }
    process.exitCode = 1;
    try {
      ctx.abort();
    } catch {
      // the block itself stops this call
    }
    return { block: true, reason: msg };
  }

  // Session manifest (manifest.ts): pre-state here, silent `foreman_close.py record` at tool_result.
  const manifest = new ManifestRecorder((p) => fs.existsSync(p));
  const manifestCtx = (s: Session, cwd: string) => ({ cwd, stateDir: path.join(s.agentDir, "pi-foreman", "state"), platform });

  /** The session's roots for the gate's path rules and defaults (pathrules.ts GateRoots). */
  async function gateRootsOf(s: Session, cwd: string, sessionDir: string | undefined, extraReadDirs: string[] = [], folders: Resolved["workFolders"] = []): Promise<GateRoots> {
    const state = path.join(s.agentDir, "pi-foreman", "state");
    const rounds = roundWorktrees(state, s.usage.line.foremanSession, platform);
    const pi = await piRootsOf(s);
    const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
    const owned = sessionOwnedRoots(s);
    // each work folder as written and in its real spelling (the same `real()` as tmp), same mode; a child has none
    const workFolders = s.isChild ? [] : folders.flatMap((f) => (real(f.path) !== f.path ? [f, { path: real(f.path), mode: f.mode }] : [f]));
    // a child in a nested submodule checkout works on the whole tree it belongs to, bounded by its round or workspace (worktreeroot.ts treeRootOf)
    const tree = s.isChild ? treeRootOf(cwd, treeCeilingOf({ cwd, agentDir: s.agentDir, foremanSession: s.usage.line.foremanSession, binding: launchBinding })) : null;
    const worktree = tree ?? workspaceOf(cwd).root;
    // a child that reads its round worktree and has no write root on it (reviewer, explorer): the same line as the old overlay's (childSurface)
    const surface = s.isChild ? childSurface(rounds, cwd, launchBinding?.role, platform) : null;
    const norm = (p: string): string => (platform === "win32" ? path.win32.resolve(p).toLowerCase() : path.posix.resolve(p));
    const roundReadOnly = !!surface && surface.read.some((r) => norm(r) === norm(worktree)) && !surface.write.some((r) => norm(r) === norm(worktree));
    return {
      worktree,
      ...(roundReadOnly ? { roundReadOnly } : {}),
      scratch: s.isChild ? childScratchDirs : s.scratch.live(null),
      ...(s.isChild && launchBinding?.scratch && launchBinding.out ? { out: launchBinding.out } : {}),
      tmp: tmpRoots(os.tmpdir(), platform, real),
      scratchBase: s.owned.childScratchRoot,
      scratchBases: [s.owned.tmpScratchRoot],
      owned: [...owned.write, ...owned.read, ...extraReadDirs],
      install: [pi.installRoot, pi.npmRoot, ...BUNDLED_PACKAGE_ROOTS.map((r) => path.join(PKG_ROOT, r))].filter((x): x is string => !!x),
      roundFlow: mainWorkflowReadable(rounds, platform).filter((d) => !d.endsWith("/*")),
      handoffs: ownHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)),
      ...(s.isChild && launchBinding?.handoffDir ? { childHandoff: launchBinding.handoffDir } : {}),
      ...(!s.isChild && ownChildHandoff(s) ? { ownHandoff: ownChildHandoff(s) } : {}),
      ...(!s.isChild ? { childHandoffs: childHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)) } : {}),
      openedHandoffs: openedHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)),
      child: s.isChild,
      ...(s.isChild && launchBinding?.role === "builder" ? { builder: true } : {}),
      ...(s.isChild && process.env.FOREMAN_CHECKOUT ? { checkout: process.env.FOREMAN_CHECKOUT } : {}),
      agentDir: s.agentDir,
      home: os.homedir(),
      ...(process.env.XDG_CONFIG_HOME ? { configHome: process.env.XDG_CONFIG_HOME } : {}),
      ...(sessionDir ? { sessionDir } : {}),
      role: s.isChild ? s.usage.line.role : "foreman",
      tmpAccess: get(s.config.config, "gate.tmpAccess") !== false,
      workFolders,
      pkgRoot: PKG_ROOT,
    };
  }

  /** Per-session gate state: the permission files (permconfig.ts), the decision log and the classifier (one per session; it holds the allow cache). */
  interface GateRuntime {
    store: PermStore;
    log: GateLog;
    classifier: Classifier;
  }
  const MAX_OWNER_MESSAGES = 3;
  const gateRuntimes = new Map<string, GateRuntime>();
  const readToolsWarned = new Set<string>();
  /** Sessions whose owner answered "deny and stop" (until the next user prompt), and per-session allows keyed `tool\0payload`. */
  const gateStopped = new Set<string>();
  /** The owner's prompts of a session, newest first. */
  const gateOwnerMessages = new Map<string, string[]>();
  /** The first user message of a session: the task text of the protected check when no ledger is bound. */
  const gateFirstPrompt = new Map<string, string>();
  const gateRuntimeOf = (s: Session): GateRuntime => {
    let rt = gateRuntimes.get(s.id);
    if (!rt) {
      // r79 item 2: a child takes the session override and the profile from its launch binding; r76 gate.mode "floors-only" is mode allow
      const bound = s.isChild ? launchBinding?.perms : undefined;
      const sessionMode: PermMode | null = bound?.override && PERM_MODES.includes(bound.override as PermMode) ? (bound.override as PermMode) : s.isChild ? null : get(s.config.config, "gate.mode") === "floors-only" ? "allow" : null;
      const store = new PermStore({ agentDir: s.agentDir, cwd: s.cwd, home: os.homedir(), profile: bound?.profile ?? profileName(s.config.config), sessionMode });
      const log = openGateLog({ agentDir: s.agentDir, session: s.id, kind: s.isChild ? "child" : "owner", role: s.isChild ? s.usage.line.role : "foreman", cwd: s.cwd, maxBytes: get(s.config.config, "gate.logMaxBytes"), roots: { worktree: workspaceOf(s.cwd).root, scratch: s.scratch.live(null)[0], tmp: os.tmpdir(), home: os.homedir() } });
      rt = { store, log, classifier: new Classifier() };
      gateRuntimes.set(s.id, rt);
    }
    return rt;
  };

  // R79 gate: the first tool_call handler this extension registers, deciding every tool call of every session kind. Pipeline: parse, floors
  // (ask-kind hits and selfmod go to the owner dialog), deny rules, ask rules, allow rules and built-in allows, dangerous class, then the
  // permissions mode (auto: classifier, then the dialog; ask: dialog; allow: run; deny: refuse). A session with no pane denies at once.
  // A handler failure blocks. The handlers below still run for what the gate lets through.
  pi.on("tool_call", async (event, ctx) => {
    const gs = sessionFor(ctx);
    const stoppedMsg = gs?.isChild ? repeatStopped.get(gs.id) : undefined;
    if (stoppedMsg) return { block: true as const, reason: stoppedMsg };
    // Role tool denial (roledeny.ts) and MCP scope (mcpscope.ts, r68) only block and run before the gate, so a refusal never becomes an ask or a review answer:
    // a child's tool matching roles.<role>.denyTools, or an mcp__ call outside roles.<role>.mcp (and the launch's mcp, codemode inner calls included).
    if (process.env.PI_SUBAGENT_CHILD === "1") {
      const msg = roleToolDenied(gs ? get(gs.config.config, "roles") : undefined, launchBinding?.role, event.toolName);
      if (msg) {
        gs?.trace?.emit({ event: "guard", guard: "role_tool_denied", toolFamily: event.toolName, decision: "blocked", reason: "role_tool_denied" });
        return { block: true as const, reason: `pi-foreman: ${msg}.` };
      }
      const scope = mcpChild?.callBlock(event.toolName);
      if (scope) {
        gs?.trace?.emit({ event: "guard", guard: "mcp_scope", toolFamily: event.toolName, decision: "blocked", reason: "mcp_scope" });
        return { block: true as const, reason: `pi-foreman: ${scope}.` };
      }
      // A [high-stakes] review marks no ledger item: the shell helper is refused in every ledgerHelper mode, like the foreman_ledger tool.
      if (launchBinding?.highStakes && event.toolName === "bash" && marksVerifierCommand((event.input as { command?: unknown } | undefined)?.command)) {
        gs?.trace?.emit({ event: "guard", guard: "high_stakes_ledger", toolFamily: event.toolName, decision: "blocked", reason: "high_stakes_ledger" });
        return { block: true as const, reason: "pi-foreman: a [high-stakes] review marks no ledger item, item V included; report your verdict only." };
      }
    }
    const rt = gs ? gateRuntimeOf(gs) : undefined;
    const resolved = rt ? rt.store.resolve() : undefined;
    if (gs && rt) for (const n of rt.store.drainNotices()) notifyOnce(gs, ctx, n, n);
    const roots = gs ? await gateRootsOf(gs, ctx.cwd, sessionDirOf(ctx), resolved?.additionalDirectories, resolved?.workFolders) : undefined;
    const configured = configuredProtected(gs);
    // own worktrees for the push guard: the session's checkout and the worktrees it created (session manifest); other linked worktrees are not own
    const sessionFacts: GitFacts | undefined = gs && roots
      ? sessionGitFacts({ ...gitFacts, protectedBranches: (cwd: string) => [...gitFacts.protectedBranches(cwd), ...configured] }, ownWorktreeCheck([roots.worktree, ...roundWorktrees(path.join(gs.agentDir, "pi-foreman", "state"), gs.usage.line.foremanSession, platform)], platform))
      : undefined;
    // merged fact for `git branch -d|-D <b>` (default-git-branch-merged): looked up here, asynchronously, per segment cwd; the gate never spawns gh
    const mergedFacts = new Map<string, boolean>();
    const cmdText = typeof (event.input as { command?: unknown } | undefined)?.command === "string" ? (event.input as { command: string }).command : null;
    if (cmdText && event.toolName === "bash" && gs && !gs.isChild && sessionFacts && /\bbranch\b/.test(cmdText)) {
      try {
        for (const sg of parseShell(cmdText, { cwd: ctx.cwd, platform })) {
          const i = sg.argv.indexOf("branch");
          if (sg.program !== "git" || sg.opaque !== null || sg.cwd === null || i < 0 || !/^-[dD]$/.test(sg.argv[i + 1] ?? "") || sg.argv.length !== i + 3) continue;
          const key = mergedFactKey(sg.cwd, sg.argv[i + 2]);
          if (!mergedFacts.has(key)) mergedFacts.set(key, await branchMergedFact(sg.cwd, sg.argv[i + 2]));
        }
      } catch {
        mergedFacts.clear();
      }
    }
    const gateFacts: GitFacts | undefined = sessionFacts && mergedFacts.size > 0 ? withMergedFacts(sessionFacts, mergedFacts) : sessionFacts;
    const readTools = gs ? readToolsOf(gs.config.config) : undefined;
    if (readTools && gs) warnUnknownReadTools(readTools, () => pi.getAllTools().map((t) => t.name), readToolsWarned, (rec) => gs.trace?.emit(rec as Parameters<NonNullable<typeof gs.trace>["emit"]>[0]));
    const out = gateEvaluate(event.toolName, event.input, ctx.cwd, {
      ...(readTools ? { readTools } : {}),
      env: (cwd) => floorEnvOf(gs, cwd, roots?.sessionDir, roots?.roundReadOnly === true),
      ...(roots ? { roots: () => roots, facts: gateFacts ?? { ...gitFacts, protectedBranches: (cwd: string) => [...gitFacts.protectedBranches(cwd), ...configured] } } : {}),
      ...(resolved ? { rules: { sets: resolved.rules, env: { cwd: ctx.cwd, home: os.homedir(), platform, checkout: rt ? rt.store.main() : ctx.cwd } } } : {}),
      ...(resolved?.protected.length ? { protected: resolved.protected } : {}),
      ...(resolved?.noteTools.length ? { noteTools: resolved.noteTools } : {}),
    });
    const r = out.result;
    const role = gs?.isChild ? gs.usage.line.role : "foreman";
    const kind: GateKind = gs?.isChild ? "child" : ctx.hasUI ? "owner" : "headless";
    const payload = gatePayload(event.toolName, event.input);
    const note = (layer: GateLayer, verdict: string, rule: string, reason?: string, fragment?: string): void => void rt?.log.record({ tool: event.toolName, layer, verdict, rule, ...(reason ? { reason } : {}), ...(fragment ? { fragment } : {}), input: payload, role, kind });
    if (r && "block" in r) {
      gs?.trace?.emit({ event: "guard", guard: "gate", toolFamily: event.toolName, decision: "blocked", rule: r.rule, ...denyFields(r.reason, event.toolName, event.input, role, [PKG_ROOT, ctx.cwd]) });
      note(r.layer ?? "floor", "deny", r.rule, r.reason, denialFragment(r));
      return (gs && (repeatedDeny(gs, ctx, r.reason, denialSentence(r)) ?? undefined)) || { block: true as const, reason: r.reason };
    }
    // no session: no dialog, classifier or log to decide with; floors and rules ran above
    if (!gs || !rt || !resolved) return { block: true as const, reason: "pi-foreman: this tool call has no session to decide it in, so it is denied. Report this to the owner." };
    const allowed = (rule: string, layer: GateLayer, label: string, folder = false, reason?: string): undefined => {
      gs.trace?.emit({ event: "guard", guard: "gate", toolFamily: event.toolName, decision: "allowed", rule: label, role, ...(folder ? { mode: "auto", source: "workFolder" } : {}) });
      if (layer !== "classifier" && layer !== "cache") note(layer, "allow", rule, reason); // the classifier logs its own record
      return undefined;
    };
    const denied = (rule: string, layer: GateLayer, reason: string): { block: true; reason: string } => {
      gs.trace?.emit({ event: "guard", guard: "gate", toolFamily: event.toolName, decision: "blocked", rule, ...denyFields(reason, event.toolName, event.input, role, [PKG_ROOT, ctx.cwd]) });
      if (layer !== "classifier" && layer !== "cache") note(layer, "deny", rule, reason);
      return { block: true as const, reason };
    };
    if (r && "allow" in r) return allowed(r.rule, r.layer ?? "default", r.rule);
    try {
      if (gateStopped.has(gs.id)) return denied("user-stop", "dialog", STOP_TEXT);
      const base = { kind, role, tool: event.toolName, input: event.input, payload, segments: out.segments, roots, allowed, denied };
      // the foreman's shell-write refusal is deterministic: it comes before any dialog or classifier, so an owner is never asked about a write that is refused anyway
      if (((r && "ask" in r) || out.danger) && (event.toolName === "bash" || event.toolName === "powershell" || event.toolName === ADDON_BG_TOOL)) {
        const shellWrite = await shellWriteBlock(ctx, event.toolName === "powershell" ? "powershell" : "bash", event.input as Record<string, unknown>);
        if (shellWrite) return shellWrite;
      }
      // a protected-target match: the check (a small model, capped by the deterministic classes) decides allow / ask / deny; every failure asks
      if (r && "ask" in r && r.cause === "protected" && r.match) {
        const m = r.match;
        const ids = m.entries.map((e) => e.id).join(",");
        const rule = `protected:${ids}`;
        const lead = m.entries[0];
        const named = `${lead.id}${lead.note ? ` (${lead.note})` : ""}`;
        // a child or a session without UI fails closed; the owner's own session ignores presence
        const away = gs.isChild || !ctx.hasUI;
        let askCause = `${named} is protected.`;
        const checkRaw = get(gs.config.config, "gate.protected.check");
        const checkMode = effectiveCheckMode(checkRaw === "ask" || checkRaw === "read-only" ? checkRaw : "model", m.entries);
        try {
          const ledgerFile = boundLedger(gs.markerDir, gs.id);
          const ledgerText = (() => { try { return ledgerFile ? fs.readFileSync(ledgerFile, "utf8") : null; } catch { return null; } })();
          const title = ledgerText ? /^#\s+(.+)$/m.exec(ledgerText)?.[1] : undefined;
          const task = (ledgerText ? [title ?? "", ...ledgerLines(ledgerText, "")].filter(Boolean).join("\n") : "") || gateFirstPrompt.get(gs.id) || "";
          const facts = reviewGitFacts(ctx.cwd);
          const ownerMessage = (gateOwnerMessages.get(gs.id) ?? [])[0];
          const v = await rt.classifier.protectedCache.check(
            { tool: event.toolName, payload, kind, role, cwd: ctx.cwd, worktree: workspaceOf(ctx.cwd).root, branch: facts.branch, remotes: facts.remotes, ...(ownerMessage ? { ownerMessage } : {}) },
            {
              prose: resolved.prose, registry: ctx.modelRegistry as never, config: gs.config.config as never, provider: ctx.model?.provider, log: rt.log,
              recordUsage: (u) => appendUsage(gs.usage.file, usageLine({ ...gs.usage.line, role: CLASSIFIER_ROLE, launchId: null, kind: "foreman" }, u as never)),
              notify: (text) => notifyOnce(gs, ctx, "no-classifier-model", text),
              match: m, task: task.slice(0, 800), denyEntries: resolved.prose.deny.map((e) => ({ id: e.id, text: e.text })), checkMode, version: resolved.version, away,
            },
          );
          gs.trace?.emit({
            event: "protected_check", rule: v.accepted === "deny" && v.entry ? `${rule};classifier.deny:${v.entry}` : rule, entries: ids, kinds: m.kinds.join(","), classes: m.classes.join(","), remoteClasses: m.remoteClasses.join(","),
            opaque: m.opaque || m.remoteOpaque, effect: v.effect, confidence: v.confidence, verdict: v.verdict, accepted: v.accepted, away, cached: v.cached, reason: v.reason, model: v.model, latencyMs: v.latencyMs, role, mode: checkMode,
            ...(v.cause ? { cause: v.cause } : {}),
            globs: m.entries.map((e) => e.glob).join(","),
            ...denyFields(v.reason, event.toolName, event.input, role, [PKG_ROOT, ctx.cwd]),
            ...(v.accepted === "deny" && v.entry ? { entry: v.entry } : {}),
          });
          if (v.accepted === "allow") return allowed(rule, "protected", rule, false, v.reason);
          if (v.accepted === "deny" && v.entry) return denied(`${rule};classifier.deny:${v.entry}`, "protected", denyText(v.entry, resolved.prose.deny.find((e) => e.id === v.entry)?.text ?? ""));
          askCause = `${named} is protected. The check rates this ${v.effect} with ${v.confidence} confidence: ${v.reason || v.cause || "no reason given"}.`;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          askCause = `${named} is protected. The check failed (${msg}).`;
          gs.trace?.emit({
            event: "protected_check", rule, entries: ids, kinds: m.kinds.join(","), classes: m.classes.join(","), remoteClasses: m.remoteClasses.join(","),
            opaque: m.opaque || m.remoteOpaque, accepted: "ask", cause: "exception", away, mode: checkMode, globs: m.entries.map((x) => x.glob).join(","),
            ...denyFields(msg.slice(0, 200), event.toolName, event.input, role, [PKG_ROOT, ctx.cwd]),
          });
        }
        gs.trace?.emit({ event: "guard", guard: "gate", toolFamily: event.toolName, decision: "ask", rule, role });
        return await decideByDialog(gs, ctx, rt, resolved, { ...base, cause: askCause, noRemember: true });
      }
      // an ask-kind floor, a self-modification rule and an ask rule go to the owner before the mode step (never to the classifier, never run under mode allow; only a protected match above runs a check first)
      if (r && "ask" in r) {
        // a write into an install or package root: mode deny refuses it without a dialog; every other mode asks the owner (the gate's step, gate.ts installRootWrite)
        if (r.rule === "install-root-write" && resolved.mode === "deny") return denied(r.rule, "mode", `${MODE_DENY_TEXT}; ${r.reason}`);
        gs.trace?.emit({ event: "guard", guard: "gate", toolFamily: event.toolName, decision: "ask", rule: r.rule, role });
        const cause = r.cause === "selfmod" ? `self-modification ${r.rule}: ${r.reason}` : r.cause === "rule" ? r.rule : `${r.rule}: ${r.reason}`;
        return await decideByDialog(gs, ctx, rt, resolved, { ...base, cause, noRemember: true });
      }
      const danger = out.danger;
      if (!danger) {
        // nothing decided and not dangerous: runs under auto and allow, asks under ask, refused under deny. A call the work folders relax runs under
        // auto instead (never for a session override or a floors-only session: modeSource session)
        const folderMode = (resolved.mode === "deny" || resolved.mode === "ask") && roots && ["default", "user", "profile"].includes(resolved.modeSource)
          && folderRelaxes({ tool: event.toolName, input: event.input, ...(out.segments ? { segments: out.segments } : {}), text: payload }, { roots, platform, cwd: ctx.cwd, facts: sessionFacts ?? { ...gitFacts, protectedBranches: (cwd: string) => [...gitFacts.protectedBranches(cwd), ...configured] } });
        if (folderMode) return allowed("no-rule", "mode", "mode:folder:auto", true);
        if (resolved.mode === "deny") return denied("mode-deny", "mode", MODE_DENY_TEXT);
        if (resolved.mode === "ask") return await decideByDialog(gs, ctx, rt, resolved, { ...base, cause: "no rule matches", noRemember: true });
        return allowed("no-rule", "mode", "mode:no-rule");
      }
      if (resolved.mode === "allow") return allowed(danger.name, "mode", `mode:allow:${danger.name}`);
      if (resolved.mode === "deny") return denied("mode-deny", "mode", MODE_DENY_TEXT);
      const cause = `${danger.name}: ${danger.reason}`;
      let classifierReason: string | undefined;
      if (resolved.mode === "auto") {
        const facts = reviewGitFacts(ctx.cwd);
        const ownerMessage = (gateOwnerMessages.get(gs.id) ?? [])[0];
        // the id of the log row of this question: the read question's row `follows` it
        let firstRow = "";
        const classifierCtx = {
          prose: resolved.prose, registry: ctx.modelRegistry as never, config: gs.config.config as never, provider: ctx.model?.provider, log: rt.log,
          recordUsage: (m: unknown) => appendUsage(gs.usage.file, usageLine({ ...gs.usage.line, role: CLASSIFIER_ROLE, launchId: null, kind: "foreman" }, m as never)),
          trace: (t: { decision: string; entry: string; cached: boolean; latencyMs: number }) => gs.trace?.emit({ event: "review", kind: "gate", ...t }),
          notify: (text: string) => notifyOnce(gs, ctx, "no-classifier-model", text),
          stamp: () => {
            try {
              return String(fs.statSync(rt.store.filePath("user")).mtimeMs);
            } catch {
              return "none";
            }
          },
        };
        const v = await rt.classifier.classify(
          { tool: event.toolName, payload, reason: cause, kind, role, cwd: ctx.cwd, worktree: workspaceOf(ctx.cwd).root, branch: facts.branch, remotes: facts.remotes, ...(ownerMessage ? { ownerMessage } : {}) },
          { ...classifierCtx, log: { file: rt.log.file, record: (rec) => (firstRow = rt.log.record(rec)) } },
        );
        if (v.verdict === "allow") return allowed(`prose:${v.entry}`, v.cached ? "cache" : "classifier", `classifier:${v.entry}`);
        if (v.verdict === "deny") return denied(`prose:${v.entry}`, "classifier", v.text);
        classifierReason = v.reason || v.detail;
        // the read question: only after a well-formed escalate or an empty whitelist; every non-clear takes the route below unchanged
        if ((v.cause === "model" || v.cause === "no_entries") && [true, undefined].includes(get(gs.config.config, "gate.readClear") as boolean | undefined) && cmdText !== null && out.segments && out.dangers) {
          try {
            const entryOk = readClearEntry(
              { tool: event.toolName, text: cmdText, segments: out.segments, dangers: out.dangers, shellBash: () => shellIsBash(shellPathSetting(gs.agentDir, ctx.cwd), deps.getShellConfig) },
              floorEnvOf(gs, ctx.cwd, roots?.sessionDir, roots?.roundReadOnly === true),
            );
            if (entryOk && roots) {
              const rc = await rt.classifier.readClear({ tool: event.toolName, payload, kind, role, cwd: ctx.cwd, inside: insideDirs(roots), notes: readNotes(out.segments), ...(firstRow ? { follows: firstRow } : {}) }, classifierCtx);
              if (rc.cleared) {
                const judge = classifierTarget(gs.config.config, ctx.model?.provider, ctx.modelRegistry as never);
                notifyOnce(gs, ctx, "read-clear", `pi-foreman: a shell line the gate could not read ran without asking: the judge, a small model${judge ? ` (${judge.provider}/${judge.modelId})` : ""} asked with reasoning, took it for only reading, and it can be wrong (trial of 2026-11-13, 72 lines: no line that must not clear was cleared with reasoning, about 1 in 100 without; see docs/permissions.md). Each clear is a row in the decision log (${rt.log.file}); set gate.readClear to false in foreman.json to switch it off.`, "info");
                return allowed("read-clear", rc.cached ? "cache" : "classifier", "classifier:read-clear");
              }
            }
          } catch {
            // the read question is best effort: any failure takes today's route (the dialog, the child's ask or the deny)
          }
        }
      }
      return await decideByDialog(gs, ctx, rt, resolved, { ...base, cause, ...(classifierReason ? { classifierReason } : {}), dangerName: danger.name });
    } catch (e) {
      const reason = `pi-foreman: the permission gate failed (${e instanceof Error ? e.message : String(e)}), so the call is denied. Report this to the user.`;
      note("floor", "deny", "gate-error", reason);
      return { block: true as const, reason };
    }
  });

  const MODE_DENY_TEXT = "pi-foreman: denied: permissions mode is deny (no rule allows this call)";
  /** What the dialog step needs of one gated call (index.ts tool_call). */
  interface DialogCall {
    kind: GateKind;
    role: string;
    tool: string;
    input: unknown;
    payload: string;
    /** The owner dialog's cause line: `danger-<name>: <reason>`, `rule <text>`, `no rule matches`, `self-modification <rule>: <reason>`. */
    cause: string;
    classifierReason?: string;
    /** The `danger-*` name, when the dialog opened for the dangerous class (remember is offered). */
    dangerName?: string;
    /** Ask-rule, selfmod, floor-ask dialogs offer no remember. */
    noRemember?: boolean;
    segments?: import("./shellast.ts").ShellSegment[];
    roots?: GateRoots;
    allowed: (rule: string, layer: GateLayer, label: string, folder?: boolean, reason?: string) => undefined;
    denied: (rule: string, layer: GateLayer, reason: string) => { block: true; reason: string };
  }
  /** The sentence and pattern rules the remember step proposes (rules.ts describeCall, proposeRule). */
  function rememberOf(name: string, tool: string, payload: string, input: unknown, segments: import("./shellast.ts").ShellSegment[] | undefined, cwd: string): { sentence: string; rules: string[] | null; exact: string[] | null } {
    const shell = SHELL_GATE_TOOLS.has(tool) && tool !== "powershell";
    const segs = segments ?? (shell ? parseShell(payload, { cwd }) : undefined);
    const inp = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
    return { sentence: describeCall({ name, tool, ...(segs ? { segments: segs } : {}), ...(inp ? { input: inp } : {}) }), rules: shell && segs ? proposeRule(segs) : null, exact: shell && segs ? exactRules(segs) : null };
  }
  /** The slice of the session the owner dialog needs: the pane, the presence, the remember store (a write reloads the files and clears the classifier cache). */
  function ownerDeps(s: Session, ctx: ExtensionContext, rt: GateRuntime, callSignal?: AbortSignal): OwnerDeps {
    return {
      ui: ctx.ui as unknown as OwnerDeps["ui"],
      signal: callSignal ? AbortSignal.any([shutdownSignal(s), callSignal]) : shutdownSignal(s),
      stateDir: path.join(s.agentDir, "pi-foreman", "state"),
      remember: { store: rt.store, afterWrite: () => { rt.store.reload(); rt.classifier.clearCache(); } },
    };
  }
  /**
   * The dialog step of the gate (r79 items 5, 7). A child asks its parent through ask.md; a headless session denies at once; the owner pane opens
   * askOwner. Returns the block, or undefined when the call may go on.
   */
  async function decideByDialog(gs: Session, ctx: ExtensionContext, rt: GateRuntime, _resolved: Resolved, a: DialogCall): Promise<{ block: true; reason: string } | undefined> {
    const { kind, role, tool, input, payload, cause } = a;
    const rule = a.dangerName ?? (cause.startsWith("rule ") ? cause : cause.split(/[:\s]/, 1)[0] || cause);
    const done = (answer: string, allow: boolean, reason?: string): { block: true; reason: string } | undefined => {
      // the trace's field list is pinned (trace.ts): the answer goes in `decision`, the cause detail in `reason`
      const df = denyFields(cause, tool, input, role, [PKG_ROOT, ctx.cwd]);
      // cause class: danger (dangerous class), selfmod, rule (an ask rule), mode (mode ask), floor (an ask-kind floor)
      const causeClass = a.dangerName ? "danger" : cause.startsWith("self-modification") ? "selfmod" : cause.startsWith("rule ") ? "rule" : cause === "no rule matches" ? "mode" : "floor";
      gs.trace?.emit({ event: "dialog", guard: "gate", cause: causeClass, kind, decision: answer, rule, toolFamily: tool, ...df, ...dialogFields(df.command) });
      askFlag.overlay({ command: df.command, rule, approved: allow, session: gs.id });
      return allow ? (a.allowed(rule, "dialog", `dialog:${answer}`, false, answer), undefined) : a.denied(rule, "dialog", reason ?? "pi-foreman: denied.");
    };
    if (kind === "child") {
      const askDir = launchBinding?.askDir;
      const cfgOff = get(gs.config.config, "gate.childAsk") !== "parent";
      if (!askDir || cfgOff) {
        // child asks off (own config, or the parent launched it with them off) vs nobody at the parent's pane
        const off = launchBinding?.noAsk !== "no-pane" && (cfgOff || launchBinding?.noAsk === "deny");
        return done("no-parent", false, off ? childAskOffText(cause) : `${NO_PANE_TEXT} The call was: ${cause}.`);
      }
      const turn = childAskChain; // one ask.md at a time: parallel tool calls of the child queue here
      let free: () => void = () => {};
      childAskChain = new Promise<void>((r) => (free = r));
      await turn;
      try {
        // the child never creates the ask dir: a missing one means the starting session ended or no longer watches this helper
        if (!fs.existsSync(askDir)) return done("parent-gone", false, CHILD_GONE_TEXT);
        const askCause = a.dangerName ?? (cause === "no rule matches" || cause.startsWith("rule ") ? cause : cause.startsWith("self-modification") ? "selfmod" : cause);
        const n = writeChildAsk(askDir, { tool, payload, cwd: ctx.cwd, session: gs.id, cause: askCause, reason: a.classifierReason ?? cause, role, run: launchBinding?.launchId, inputHash: inputHash(input) });
        const notBefore = fs.statSync(path.join(askDir, "ask.md")).mtimeMs;
        const w = await withBlockedOn(herdrEvents, BLOCK_PARENT, `ask ${n}: gate ${tool}`, () => awaitChildRuling(askDir, n, Infinity, 250, notBefore, undefined, undefined, { signal: ctx.signal, gone: { liveFile: launchBinding?.foremanSession ? path.join(liveDir(gs.agentDir), `${launchBinding.foremanSession}.json`) : undefined, staleMs: LIVE_DEAD_MS } }));
        if (w.answer === "allow") return done("parent-allow", true);
        if (w.answer === "gone") return done("parent-gone", false, CHILD_GONE_TEXT);
        if (w.answer === "aborted") return done("parent-aborted", false, "pi-foreman: the call was aborted while it waited for the parent's ruling; the question stays open in ask.md.");
        return done("parent-deny", false, w.answer === "deny" ? `pi-foreman: denied by the parent${w.reason ? `: ${w.reason}` : "."} Report this line to the foreman and continue with what you can. The ask was ${cause}${tool === "bash" ? (n2 => (n2 ? ` ${n2}` : ""))(childNpmNote(String((input as Record<string, unknown> | undefined)?.command ?? ""), launchBinding?.install === true)) : ""}` : `pi-foreman: denied: the parent's ruling-${n}.md starts with "${(w.first ?? "").slice(0, 40)}", not ALLOW or DENY.`);
      } catch (e) {
        return done("parent-deny", false, `pi-foreman: the ask for the parent could not be written (${e instanceof Error ? e.message : String(e)}); the call is denied. Report this line to the foreman.`);
      } finally {
        free();
      }
    }
    if (kind !== "owner") return done("no-ui", false, NO_PANE_TEXT); // no UI: an immediate deny
    const remember = a.noRemember ? undefined : rememberOf(a.dangerName ?? "unmatched", tool, payload, input, a.segments, ctx.cwd);
    const ans: OwnerAnswer = await withBlockedOn(herdrEvents, BLOCK_APPROVAL, `pi-foreman: ${tool} asks`, () => askOwner({ tool, payload, cwd: ctx.cwd, cause, ...(a.classifierReason ? { classifierReason: a.classifierReason } : {}), ...(remember ? { remember } : {}) }, ownerDeps(gs, ctx, rt, ctx.signal)));
    if (ans.allow === true) return done(ans.how === "remember" ? "allow-remember" : ans.refused ? "allow-remember-refused" : "allow-once", true);
    if (ans.how === "stop") gateStopped.add(gs.id);
    return done(ans.how, false, ans.reason);
  }

  /** `/foreman perms mode [auto|ask|allow|deny]`, `reload`, `list` (r79 item 8): the answer text. */
  function permsCommand(s: Session, rest: string[]): string {
    const usage = "Usage: /foreman perms mode [auto|ask|allow|deny] | reload | list";
    const rt = gateRuntimeOf(s);
    const sub = rest[0];
    if (sub === "mode") {
      if (rest.length === 1) {
        const r = rt.store.resolve();
        return `pi-foreman: permissions mode ${r.mode} (${r.modeSource}${r.profile ? `, profile ${r.profile}` : ""}).`;
      }
      const m = rest[1] as PermMode;
      if (rest.length !== 2 || !PERM_MODES.includes(m)) return usage;
      if (s.isChild) return "pi-foreman: the permissions mode is set in the foreman session; a child takes the mode of its launch.";
      rt.store.setSessionMode(m);
      rt.classifier.clearCache();
      return `pi-foreman: permissions mode is ${m} for this session (until it ends or /foreman perms mode is run again).`;
    }
    if (sub === "reload" && rest.length === 1) {
      rt.store.reload();
      rt.classifier.clearCache();
      const r = rt.store.resolve();
      return [`pi-foreman: permission files reloaded (mode ${r.mode}, ${r.entries.length} pattern rules, ${r.prose.allow.length} + ${r.prose.deny.length} sentences).`, ...rt.store.drainNotices()].join("\n");
    }
    if (sub === "list" && rest.length === 1) {
      const r = rt.store.resolve();
      const lines = [`mode ${r.mode} (${r.modeSource}${r.profile ? `, profile ${r.profile}` : ""})`];
      for (const e of r.entries) lines.push(`${e.kind}: ${e.rule.text} (${e.source})`);
      for (const e of r.prose.allow) lines.push(`${e.id}: ${e.text} (${e.source})`);
      for (const e of r.prose.deny) lines.push(`${e.id}: ${e.text} (${e.source})`);
      if (r.additionalDirectories.length) lines.push(`additionalDirectories: ${r.additionalDirectories.join(", ")}`);
      lines.push(...protectedBlock(r));
      lines.push(...workFoldersBlock(r, (p) => { try { return fs.realpathSync(p); } catch { return p; } }));
      return [...lines, ...rt.store.drainNotices()].join("\n");
    }
    return usage;
  }

  const PROTECT_CONFIRM_MS = 120_000;
  /**
   * `foreman_protect` and `/foreman perms protect`: validate, ask the owner (a timeout, a cancel or no UI is a refusal), then write through
   * PermStore.writeProtected and drop the gate caches. The model never writes the file; the adapter does, after the owner's yes.
   */
  async function protectEntry(s: Session, ctx: ExtensionContext, a: { action: unknown; kind: unknown; glob: unknown; note?: unknown; check?: unknown; file?: unknown }): Promise<{ ok: boolean; text: string }> {
    const no = (text: string) => ({ ok: false, text: `pi-foreman: not changed: ${text}` });
    if (s.isChild) return no("children never change the protected targets; the owner does, with /foreman perms protect.");
    if (a.action !== "add" && a.action !== "remove") return no("action must be add or remove");
    if (a.file !== undefined && a.file !== "project" && a.file !== "user") return no("file must be project or user");
    if (a.check !== undefined && !PROTECTED_CHECK_MODES.includes(a.check as never)) return no("check must be model, read-only or ask");
    if (a.check !== undefined && a.action === "remove") return no("check is for add only; to change an entry, remove it and add it again");
    const clean = cleanProtected({ kind: a.kind, glob: a.glob, note: a.note, check: a.check });
    if (typeof clean === "string") return no(clean);
    if (!ctx.hasUI) return no("there is no pane to ask the owner in; the owner runs /foreman perms protect add|remove <kind> <glob> in the foreman session.");
    const file = a.file === "user" ? "user" : "project";
    const rt = gateRuntimeOf(s);
    const cur = rt.store.resolve();
    const existing = cur.protected.find((e) => e.kind === clean.kind && e.glob === clean.glob);
    const where = file === "user" ? rt.store.filePath("user") : cur.projectFile;
    if (a.action === "remove" && !existing) return no(`${clean.kind} ${clean.glob} is not protected`);
    if (a.action === "add" && existing) return no(`${clean.kind} ${clean.glob} is already protected (${existing.id}); to change its note or check, remove it and add it again`);
    const spec: DialogSpec = a.action === "add"
      ? {
          ask: `Protect ${clean.kind} ${clean.glob}?`,
          ...(clean.note ? { summary: clean.note } : {}),
          detail: [`Check mode: ${clean.check ?? "the global gate.protected.check"} (an entry can only tighten the global mode)`, `File: ${where}`, "For this target an accepted check allow replaces your ask rules, the dangerous-class whitelist and the ask/deny mode; confident reads can be allowed, and in a session with UI that is not a child writes and deploys too, except remote writes the harness itself sees, which always ask; a child or a session without UI asks for writes and deploys. Floors and deny rules still apply."],
          answers: "Yes: the protection is written   No: nothing changes",
        }
      : {
          ask: `Remove protection from ${clean.kind} ${clean.glob}?`,
          summary: `Its calls go back to your ask rules and the dangerous class. Entry: ${existing?.id}.`,
          detail: [`File: ${where}`],
          answers: "Yes: the protection is removed   No: nothing changes",
        };
    let yes = false;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PROTECT_CONFIRM_MS); timer.unref?.(); });
      const asked = withBlockedOn(herdrEvents, BLOCK_CONFIRM, cleanDialogText(spec.ask), () => shapedConfirm(ctx.ui, ctx.mode, spec));
      yes = (await Promise.race([asked, timeout])) === true;
      if (timer) clearTimeout(timer);
    } catch {
      yes = false;
    }
    if (!yes) return no("the owner declined or did not answer");
    const w = rt.store.writeProtected(file, a.action, clean);
    if (w.ok === false) return no(w.reason);
    rt.classifier.clearCache();
    s.trace?.emit({ event: "protected_edit", action: a.action, kind: clean.kind, file });
    return { ok: true, text: `pi-foreman: ${a.action === "add" ? "protected" : "no longer protected"}: ${clean.kind} ${clean.glob} (${w.file}).` };
  }

  /** `/foreman perms suggest|review|adopt <report> <n>...` (the rule workshop): adopt is the owner's command, one select per candidate. */
  async function workshopCommand(s: Session, ctx: ExtensionContext, rest: string[]): Promise<string> {
    if (rest[0] === "review") return rest.length === 1 ? reviewAdopted(s.agentDir) : "Usage: /foreman perms review";
    if (rest[0] === "suggest") {
      const r = runSuggest(s.agentDir, ctx.cwd, rest.slice(1));
      return r.ok === false ? `pi-foreman: ${r.error}` : r.text;
    }
    if (s.isChild || !ctx.hasUI) return "pi-foreman: /foreman perms adopt changes the owner's permissions file; it runs in the owner's own session only.";
    const picks = rest.length >= 3 ? parsePicks(rest.slice(2)) : "Usage: /foreman perms adopt <report> <n>...";
    if (typeof picks === "string") return picks;
    let text: string;
    try {
      text = fs.readFileSync(path.resolve(ctx.cwd, rest[1]), "utf8");
    } catch (e) {
      return `pi-foreman: cannot read the report: ${(e as Error).message}`;
    }
    // one select per candidate: its rule, its sentence, or skip (the report is re-validated by entriesFromReport inside adopt as well)
    const chosen: AdoptPick[] = [];
    for (const p of picks) {
      const asRule = entriesFromReport(text, [{ n: p.n, as: "rule" }]);
      const asSentence = entriesFromReport(text, [{ n: p.n, as: "sentence" }]);
      if (asRule.ok === false) return `pi-foreman: nothing adopted: ${asRule.error}`;
      if (asSentence.ok === false) return `pi-foreman: nothing adopted: ${asSentence.error}`;
      const rule = asRule.entries[0].kind === "rule" ? asRule.entries[0].text : null;
      const how = await ctx.ui.select(`Candidate ${p.n}: add to ${path.join(s.agentDir, "pi-foreman", "permissions.json")}?\n\nrule: ${rule ?? "(none is safe)"}\nsentence: ${asSentence.entries[0].text}`, [...(rule ? ["rule"] : []), "sentence", "skip"]);
      if (how === "rule" || how === "sentence") chosen.push({ n: p.n, as: how });
    }
    if (chosen.length === 0) return "nothing adopted";
    const rt = gateRuntimeOf(s);
    const r = await adoptSuggested(s.agentDir, text, chosen, async () => true);
    rt.store.reload();
    rt.classifier.clearCache();
    return r.lines.join("\n");
  }

  const SHELL_GATE_TOOLS = new Set(["bash", "bg_run", "powershell"]);
  /** The text the log shapes and the classifier reads: the command, the path operands, or the JSON input. */
  const gatePayload = (tool: string, input: unknown): string => {
    const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    if (SHELL_GATE_TOOLS.has(tool)) return String(i.command ?? i.cmd ?? "");
    if (PATH_TOOL_NAMES.has(tool)) return Object.entries(i).filter(([, v]) => typeof v === "string").map(([k, v]) => `${k}=${v}`).join(" ");
    try {
      return JSON.stringify(i);
    } catch {
      return "";
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    const ms = sessionFor(ctx);
    if (ms && !ms.isChild) {
      capsReset(ms, event.toolCallId);
      reworkScan(ms);
      ms.runningCalls.add(event.toolCallId);
      if (MUTATING_TOOLS.has(event.toolName)) ms.mutating.add(event.toolCallId);
      if (event.toolName === "bash" || event.toolName === "powershell") ms.commandCalls.add(event.toolCallId);
      if (event.toolName === ASK_USER_TOOL || event.toolName === "plan_mode_question") {
        ms.questionCalls.add(event.toolCallId);
        holdQuestion(event.toolCallId, event.input);
      }
      // ask_user_question comes from the bundled @juicesharp/rpiv-ask-user-question; the harness only counts the dialog
      if (event.toolName === ASK_USER_TOOL) {
        ms.trace?.emit({ event: "dialog", surface: "ask_user" });
        // owner-readable questions: the project and session label in front of each question (in place, idempotent), a jargon hint on the result
        const prefix = questionPrefix(projectNameOf(ctx.cwd), labelOfHandoff(process.env.PI_FOREMAN_HANDOFF_DIR?.trim()));
        prefixQuestions(event.input, prefix);
        const hint = questionHint(event.input, prefix);
        questionHints.clear(); // a call blocked later gets no tool_result: drop its stale hint
        if (hint) questionHints.set(event.toolCallId, hint);
        ms.trace?.emit({ event: "question_check", jargon: hint ? 1 : 0 });
      }
    }
    let bashTimeout = null as ChildBashTimeout | null;
    let wantHold = null as { gate: LedgerGate; key: string; sid: string } | null;
    const res = await (async () => {
    const stopped = ms?.isChild ? repeatStopped.get(ms.id) : undefined;
    if (stopped) return { block: true, reason: stopped };
    if (ms) manifest.onToolCall(event.toolCallId, event.toolName, event.input as Record<string, unknown>, manifestCtx(ms, ctx.cwd));
    if (event.toolName === "subagent") sessionFor(ctx)?.launchBatch.onToolCall(event.toolCallId);
    if (event.toolName === "bash" || event.toolName === "powershell") {
      const ps = sessionFor(ctx);
      if (ps && !ps.isChild) bashRulingSnaps.set(event.toolCallId, snapshotRulings(childDirsOf(ps)));
    }
    // R30 item 8: a child's bash call with no valid `timeout` gets the default, a larger one is capped (bashtimeout.ts).
    if (ms?.isChild && event.toolName === "bash" && event.input && typeof event.input === "object") {
      const bt = childBashTimeout(event.input as Record<string, unknown>, { seconds: get(ms.config.config, "ceremony.childBashTimeoutSeconds"), max: get(ms.config.config, "ceremony.childBashTimeoutMaxSeconds") });
      if (bt) {
        (event.input as Record<string, unknown>).timeout = bt.timeout;
        bashTimeout = bt;
      }
    }
    if (event.toolName === "bash") {
      const ps = sessionFor(ctx);
      if (ps && !ps.isChild && ps.activeRuns.size > 0) ps.pollBash++;
      if (ps && !ps.isChild && mentionsLedger((event.input as { command?: unknown }).command)) {
        ps.ledgerBash.add(event.toolCallId);
        const lf = boundLedger(ps.markerDir, ps.id);
        // The hold is taken after the handler's last await (below), so a dialog or reviewSync wait cannot expire it or deadlock markByReview.
        if (lf && !ledgerHolds.has(event.toolCallId)) wantHold = { gate: ledgerGate(lf), key: `${ps.id}:${event.toolCallId}`, sid: ps.id };
      }
    }
    // A session never writes a ruling file in a handoff dir where it is the child (ruling.ts): a literal path is refused here.
    {
      const rs = sessionFor(ctx);
      // the path of write and edit as the tool reads it (`@`, `~`, `file://`)
      const rin = event.input as Record<string, unknown>;
      const rpath = (event.toolName === "write" || event.toolName === "edit") && typeof rin?.path === "string" ? toolPath(rin.path, ctx.cwd, os.homedir(), platform) : null;
      const why = rs && selfRulingRefusal(event.toolName, rpath !== null ? { ...rin, path: rpath } : rin, ctx.cwd, childDirsOf(rs), platform);
      if (why) {
        rs.trace?.emit({ event: "guard", guard: "self_ruling", toolFamily: event.toolName, decision: "blocked", ...denyFields(`self_ruling: ${why}`, event.toolName, event.input, rs.isChild ? rs.usage.line.role : "foreman", [PKG_ROOT, ctx.cwd]) });
        return repeatedDeny(rs, ctx, why) ?? { block: true, reason: `pi-foreman: ${why}.` };
      }
    }
    // A newer ruling (ruling-*.md, steer-*.md) in the handoff dir is read before any child launch: the launch waits, the ruling text is the reason.
    if (event.toolName === "subagent") {
      const ps = sessionFor(ctx);
      const agents = ps ? subagentAgents(event.input as Record<string, unknown>) : [];
      const text = ps && agents.length > 0 ? rulingPickup(ps, `launch ${agents.join("+")}`) : "";
      if (text) return { block: true, reason: `pi-foreman: a newer ruling arrived before this launch; it is not started. Act on it, then launch again.\n${text}` };
    }
    // A child never deletes an editor backup with rm (effects.ts) on any shell tool; it reports it instead.
    if (process.env.PI_SUBAGENT_CHILD === "1" && isShellTool(event.toolName) && editorBackupCommand((event.input as { command?: unknown }).command)) {
      sessionFor(ctx)?.trace?.emit({ event: "guard", guard: "editor_backup", toolFamily: "bash", decision: "blocked", reason: "editor_backup" });
      return { block: true, reason: "pi-foreman: [editor_backup] deleting an editor backup (`*~`, `*.bak`, `*.orig`, `*.swp`, `.#*`) with rm is denied; report it in your result instead." };
    }
    const sup = supervisorBlock(sessionFor(ctx), event.toolName, event.input);
    if (sup) return sup;
    const rb = readBudgetCheck(sessionFor(ctx), ctx, event.toolName, event.toolCallId, event.input);
    if (rb) return rb;
    const crb = childReadCheck(sessionFor(ctx), event.toolName, event.toolCallId, event.input);
    if (crb) return crb;
    if (event.toolName === INTERCOM_TOOL) {
      try {
        const s = await ensureSession(ctx);
        const reason = intercomBlock(event.toolName, event.input, { isChild: s.isChild, allowRemote: get(s.config.config, "intercom.allowRemote") === true, allowOpenPane: get(s.config.config, "intercom.allowOpenPane") === true });
        s.trace?.emit({ event: "guard", guard: "intercom", toolFamily: "intercom", decision: reason ? "blocked" : "allowed" });
        if (reason) return { block: true, reason };
      } catch (err) {
        return { block: true, reason: `pi-foreman: adapter error in the intercom guard (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
      }
    }
    if (GATED_TOOLS.has(event.toolName)) {
      // Edit mode first, independent of requireTriage; readonly/scratchpad decide alone, bounded falls through.
      const edit = await editModeGate(ctx, event.toolName, event.input as Record<string, unknown>);
      if (edit) return edit;
      if (edit === null) {
        const triage = await triageBlock(ctx, event.toolName, event.input as Record<string, unknown>, event.toolCallId);
        if (triage) return triage;
      }
    }
    if (event.toolName === "bash" || event.toolName === "powershell" || event.toolName === ADDON_BG_TOOL) {
      // the add-on's bg_run is checked as a bash call: the same script, the same verdicts.
      const shellWrite = await shellWriteBlock(ctx, event.toolName === "powershell" ? "powershell" : "bash", event.input as Record<string, unknown>);
      if (shellWrite) return shellWrite;
    }
    if (OUTWARD_TOOLS.has(event.toolName)) {
      const triage = await triageBlock(ctx, event.toolName, event.input as Record<string, unknown>, event.toolCallId);
      if (triage) return triage;
    }
    if (isPrToolName(event.toolName) && !isPackPrCreate(event.toolName) && mapTool(event.toolName).pre.length === 0) {
      // A package tool that creates a pull request: the PR gate's review test against workspace HEAD.
      try {
        const s = await ensureSession(ctx);
        if (!s.isChild) await s.reviewSync;
        const refusal = await prGateRefusal({ tool: event.toolName, isChild: s.isChild, gateOn: get(s.config.config, "ceremony.reviewBeforePr") !== false, reviewed: passHeads(s.reviews), headless: headlessPass(s.reviews), cwd: ctx.cwd, input: event.input as Record<string, unknown>, highStakes: hsGate(s) });
        if (refusal) {
          s.trace?.emit({ event: "pr_refused", reason: refusal.reason, toolFamily: event.toolName });
          return { block: true, reason: refusal.message };
        }
      } catch (err) {
        return { block: true, reason: `pi-foreman: adapter error in the PR gate (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
      }
    }
    const mapping = mapTool(event.toolName);
    // Shell tools have no core script now but still pass the checks below (pre-bash hooks, empty-command refusal, git drift).
    if (mapping.pre.length === 0 && !isShellTool(event.toolName)) return undefined;
    try {
      const s = await ensureSession(ctx);
      const input = event.input as Record<string, unknown>;
      // The spawn gate measures the caller's task, read before this call's harness prepends (re-review line, shadow task, ledger block).
      const callerTask = event.toolName === "subagent" ? subagentTaskText(input) : "";
      const blocked = childLaunchBlock(s, event.toolName);
      if (blocked) return { block: true, reason: blocked };
      let notices: string[] = [];
      let launchMcp: string[] | undefined;
      let launchFlags: { reads?: number; install?: boolean } = {};
      let takenOccasions = new Map<Record<string, unknown>, LaunchOccasion>();
      let takenItems = new Map<Record<string, unknown>, unknown>();
      const verdictItems = new Map<Record<string, unknown>, ItemId[]>();
      const mcpNotes: string[] = [];
      let budgetNotes: string[] = [];
      // Warned only once the launch passed every check (set at the end of the guard path).
      let pendingWarn: Record<string, unknown> | null = null;
      let rounds: LaunchRounds | undefined;
      let kind: LaunchKind | undefined;
      /** Set for a builder launch that is a revision (counted or same-prompt repeat); traced after the ladder chose the rung. */
      let revisionTrace: { reason: string; keyword: boolean; noStrong: boolean } | null = null;
      let climbs: Climb[] = [];
      let rawLaunch: Record<string, unknown> = {};
      let ladderRoles: Record<string, Json> | undefined;
      let reviewerClimbs: ReviewerClimb[] = [];
      let reviewerTraces: Record<string, unknown>[] = [];
      // reviewer entries whose final model differs from their climb's (a ceremony.reviewModel pair or the same-model walk moved them): their rung_up trace and `climbed` mark are dropped
      const climbReplaced = new Set<Json>();
      let sized: ReturnType<typeof takeSizing> | null = null;
      let sizedPlans: EntryPlan[] = [];
      let sizingRecords: Record<string, unknown>[] = [];
      let pendingBottom: Map<string, string> | null = null;
      let heavyDefault: Json[] = []; // builder entries the heavy tier put on the strong rung (launchModel's tier default; no Climb record)
      let sizingClimbs: ReadonlySet<Json> = new Set();
      let sizingTop: string | null = null;
      let override: ReturnType<typeof takePressureOverride> = { nested: false };
      let occasions = new Map<Record<string, unknown>, Occasion>();
      let panel: ReturnType<typeof primaryPanel> = null;
      let shadow: ShadowDecision = { kind: "none" };
      /** The `[high-stakes]` entries of this launch (highstakes.ts) and the checkout they review. */
      const hsEntries = new Set<Json>();
      let hsLaunch: { root: string; gateKey: string; base: string | null } | null = null;
      // The items of a review entry, computed once (verdict.ts): the re-review line, the items line of the task and the review_verdict tool read this set.
      const launchItemsCache = new Map<Record<string, unknown>, { given: ReturnType<typeof parseItemsField> | undefined; r: ReturnType<typeof launchItemsOf> | null }>();
      const launchItemsFor = (e: Record<string, unknown>): { given: ReturnType<typeof parseItemsField> | undefined; r: ReturnType<typeof launchItemsOf> | null } => {
        const known = launchItemsCache.get(e);
        if (known) return known;
        const given = takenItems.has(e) ? parseItemsField(takenItems.get(e)) : undefined;
        let r: ReturnType<typeof launchItemsOf> | null = null;
        if (!(given && "error" in given)) {
          const lf = boundLedger(s.markerDir, s.id);
          const read = (f: string | null): string | null => { try { return f ? fs.readFileSync(f, "utf8") : null; } catch { return null; } };
          const named = typeof e.task === "string" ? taskLedger(e.task, ctx.cwd, lf, [s.cwd, ctx.cwd]).path : lf;
          r = launchItemsOf((named === lf ? null : read(named)) ?? read(lf), given && "items" in given ? given.items : undefined, { reReview: occasions.get(e) === "item", failed: s.failItems });
        }
        const c = { given, r };
        launchItemsCache.set(e, c);
        return c;
      };
      if (event.toolName === "subagent") {
        // D8: only the adapter writes the pi-foreman usage binding (single launches, below).
        stripBinding(input);
        // The owner-approval request of a deferred launch leaves every call here, before the copy: pi-subagents and a relaunch never carry it.
        override = takePressureOverride(input);
        if (override.text !== undefined && s.isChild) s.trace?.emit({ event: "pressure_override", decision: "not_needed", reason: "child" });
        rawLaunch = JSON.parse(JSON.stringify(input)) as Record<string, unknown>; // the arguments as the model gave them, for a deferred or queued launch
        // R39 launch sizing (sizing.ts): `size` and `risk` leave every launch here (after the copy, so a relaunch is sized again); malformed ones refuse only the foreman's own launches.
        const lifted = liftSizing(input);
        if (lifted.from.length > 0 || lifted.left) misplacedSizing.add(event.toolCallId);
        for (const from of lifted.from) s.trace?.emit({ event: "sizing_lifted", from });
        sized = takeSizing(input);
        if (sized.error && !s.isChild && actionOf(input) === null && sizingConfig(s.config.config).enabled) {
          s.trace?.emit({ event: "launch_refused", reason: "sizing_invalid", tier: s.ceremony.tier, ...launchDeny(input) });
          return { block: true, reason: sized.error };
        }
        // R46: `reads` and `install` leave every launch here; a single launch carries them in its binding (recordLaunchUsage).
        const flags = takeLaunchFlags(input);
        if (flags.error && !s.isChild && actionOf(input) === null) {
          s.trace?.emit({ event: "launch_refused", reason: "launch_flag_invalid", tier: s.ceremony.tier, ...launchDeny(input) });
          return { block: true, reason: flags.error };
        }
        if (flags.occasionError && !s.isChild && actionOf(input) === null) {
          s.trace?.emit({ event: "review_occasion_unknown" });
          return { block: true, reason: flags.occasionError };
        }
        takenOccasions = flags.occasions;
        takenItems = flags.items;
        mcpNotes.push(...flags.notes);
        launchFlags = flags.entries.get(input) ?? {};
        const flagRole = singleLaunchRole(input);
        if (flagRole) {
          const a = launchReadAllowance(s.config.config, flagRole, { reads: launchFlags.reads, files: sized.entries.get(input)?.size?.files.length });
          if (a.clamped) mcpNotes.push(`pi-foreman: reads ${launchFlags.reads} is above the maximum; the read allowance is ${a.allowance}.`);
          launchFlags = { ...launchFlags, reads: a.allowance };
          const rl = childReadLimits(s.config.config, flagRole, a.allowance);
          if (rl) mcpNotes.push(`pi-foreman: reads: ${rl.deny} (warn at ${rl.warn})`);
        }
        const resolution = await currentRoles(s, ctx);
        const allowWorkflow = get(s.config.config, "safety.subagents.allowWorkflow") === true;
        const act = subagentActionCheck(input, { allowWorkflow, runs: s.runs, allowed: childRoleIds(get(s.config.config, "roles")), resolution, maxThinking: get(s.config.config, "maxThinking") });
        if (act.block) return { block: true, reason: act.block };
        // r68 (A22): a workflow script that names a binding could forge one for any child.
        const branch = (ctx.sessionManager.getBranch?.() ?? []) as { type?: string; message?: unknown }[];
        const forged = workflowBindingBlock(input, { cwd: s.cwd, roles: get(s.config.config, "roles"), replyText: lastAssistantText(branch.filter((e) => e.type === "message").map((e) => e.message)) });
        if (forged) {
          s.trace?.emit({ event: "launch_refused", reason: "workflow_binding", tier: s.ceremony.tier, ...launchDeny(input) });
          return { block: true, reason: forged };
        }
        // r68: the launch `mcp` field is validated against the role's ceiling and leaves the call here (rawLaunch above keeps it for a relaunch).
        const mcpPlan = planMcpLaunch(input, get(s.config.config, "roles"), { perEntryBindings: PER_ENTRY_BINDINGS, maxTools: get(s.config.config, "mcp.directMaxTools") });
        if (mcpPlan.refusal) {
          s.trace?.emit({ event: "launch_refused", reason: mcpPlan.refusal.reason, tier: s.ceremony.tier, ...launchDeny(input) });
          return { block: true, reason: mcpPlan.refusal.text };
        }
        // T5: pi-subagents forwards a binding only on its single path, so a review child of a group launch could never record its verdict
        if (!PER_ENTRY_BINDINGS && actionOf(input) === null && !singleLaunchRole(input) && launchEntries(input).some((e) => typeof e.agent === "string" && REVIEW_ROLES.includes(e.agent))) {
          s.trace?.emit({ event: "launch_refused", reason: "review_single_launch", tier: s.ceremony.tier, ...launchDeny(input) });
          return { block: true, reason: "pi-foreman: launch refused [review_single_launch]: a reviewer records its verdict through a launch binding, which pi-subagents forwards only for a single launch. Launch each reviewer as its own subagent({agent, task}) call." };
        }
        launchMcp = mcpPlan.mcp;
        if (!mcpPlan.group && mcpPlan.entries[0]) {
          const mcpRole = mcpPlan.entries[0].role;
          if (launchMcp && launchMcp.length > 0) {
            // The parent cannot know how many tools a server has (Pi's config lists server names only, the child's tools register in the child), so `searchable` is not traced.
            const allowed = allowedMcpNamed(get(s.config.config, "roles"), mcpRole, launchMcp);
            s.trace?.emit({ event: "mcp_launch", role: mcpRole, upfront: namedEntries(allowed).length, servers: allowed.servers.join(",") });
            const whole = wholeOnlyServers(get(s.config.config, "roles"), mcpRole, launchMcp);
            if (whole.length > 0 && directProviders(get(s.config.config, "mcp.directProviders")).length > 0) {
              const cap = directMaxTools(get(s.config.config, "mcp.directMaxTools"));
              s.trace?.emit({ event: "mcp_launch_whole", role: mcpRole, servers: whole.join(","), cap });
              mcpNotes.push(wholeServerLine(mcpRole, whole, cap));
            }
          }
          const known = await configuredServers(s.cwd, safeTrusted(ctx), process.env, deps.mcpChild?.resolveRoot);
          const unknown = known ? unknownServers(get(s.config.config, "roles"), mcpPlan.entries[0].role, launchMcp, known) : [];
          if (unknown.length > 0) {
            s.trace?.emit({ event: "mcp_launch_unknown_server", role: mcpPlan.entries[0].role, reason: unknown.join(",") });
            mcpNotes.push(unknownServerLine(mcpPlan.entries[0].role, unknown));
          }
          // No `mcp` means no MCP for the child: a task that names a ceiling server gets a hint, never a refusal.
          const named = launchMcp === undefined ? namedCeilingServers(get(s.config.config, "roles"), mcpPlan.entries[0].role, callerTask) : [];
          if (named.length > 0) {
            s.trace?.emit({ event: "mcp_launch_hint", role: mcpPlan.entries[0].role, reason: named.join(",") });
            mcpNotes.push(mcpHintLine(mcpPlan.entries[0].role, named));
          }
        }
        const outPath = outputPathBlock(input);
        if (outPath) {
          s.trace?.emit({ event: "launch_refused", reason: "output_path", tier: s.ceremony.tier, ...launchDeny(input) });
          return { block: true, reason: outPath };
        }
        const heavyUnchecked = uncheckedHeavyBlock(act.unchecked, s.ceremony.tier);
        if (heavyUnchecked) {
          s.trace?.emit({ event: "launch_refused", reason: "unchecked_heavy", tier: s.ceremony.tier, ...launchDeny(input) });
          return { block: true, reason: heavyUnchecked };
        }
        if (act.unchecked) notifyOnce(s, ctx, `workflow:${act.unchecked}`, `pi-foreman: safety.subagents.allowWorkflow is on; '${act.unchecked}' launches are not checked against the role allowlist or the role map.`);
      }
      if (event.toolName === "subagent" && forceUserScope(input)) notifyOnce(s, ctx, "agentScope", "pi-foreman: child launches use agentScope \"user\" (project agents cannot redefine a role); the requested scope was overridden");
      if (event.toolName === "subagent" && forceDetached(input)) {
        notifyOnce(s, ctx, "detach", "pi-foreman: child launches are always detached; async:false was overridden");
        s.trace?.emit({ event: "detach_override" });
      }
      if (event.toolName === "subagent") {
        const refused = roleLaunchBlock(input, childRoleIds(get(s.config.config, "roles")));
        if (refused) return { block: true, reason: refused };
        const resolution = await currentRoles(s, ctx);
        const noModel = roleModelBlock(input, resolution);
        if (noModel) return { block: true, reason: noModel };
        const noPlan = s.isChild ? undefined : builderPlanBlock(s, ctx, input);
        if (noPlan) return { block: true, reason: noPlan };
        // Host pressure (pressure.ts): critical defers the launch (nothing below runs or counts), high narrows the fan-out to one and suppresses climbs.
        if (!s.isChild && isLaunchArgs(input) && !explorerOnly(rawLaunch)) {
          const p = pressureOf(s);
          const ovTrace = { agent: typeof rawLaunch.agent === "string" ? rawLaunch.agent : "", hash: taskHash(rawLaunch.task), reasons: p.reasons.join(","), level: p.level };
          let approved = false;
          if (p.level === "critical") {
            const args = rawLaunch;
            let refusal = criticalReason(p.reasons);
            let deferWait = true;
            const availability = overrideAvailability({ reasons: p.reasons, call: rawLaunch, nested: override.nested, ui: !!ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc"), declinedRecently: s.overrideDeclined });
            if (override.text === undefined) {
              refusal = `${refusal}. ${overrideHint(availability === "declined_recently" ? "ok" : availability, overrideShape(rawLaunch))}`;
            } else if (availability !== "ok") {
              s.trace?.emit({ event: "pressure_override", decision: "unavailable", ...ovTrace, reason: availability });
              refusal = overrideUnavailableReason(p.reasons, availability);
              deferWait = !waits.hasPressure(ctx, args);
            } else {
              s.trace?.emit({ event: "dialog", surface: "pressure_override" });
              const spec = overrideSpec({ agent: ovTrace.agent, task: typeof rawLaunch.task === "string" ? rawLaunch.task : "", reason: override.text, host: p.host, maxLoadPerCore: get(s.config.config, "resources.maxLoadPerCore") });
              let answer: string | undefined;
              try {
                answer = await withBlockedOn(herdrEvents, BLOCK_CHECKPOINT, cleanDialogText(spec.ask), () => shapedSelect(ctx.ui, ctx.mode, spec, ["Yes", "No"], { signal: ctx.signal }));
              } catch {
                answer = undefined;
              }
              if (answer === "Yes") {
                approved = true;
                s.overridden.set(event.toolCallId, args);
                s.trace?.emit({ event: "pressure_override", decision: "approved", ...ovTrace });
              } else {
                s.overrideDeclined = true;
                s.trace?.emit({ event: "pressure_override", decision: answer === "No" ? "declined" : "dismissed", ...ovTrace });
                refusal = overrideDeclinedReason(p.reasons);
                deferWait = !ctx.signal?.aborted && !waits.hasPressure(ctx, args);
              }
            }
            if (!approved) {
              let failed = "";
              if (deferWait) {
                const w = await waits.startPressure(ctx, { kind: "pressure", mode: "critical", args: [args], pollMs: sampleSecondsOf(s.config.config) * 1000, boundSeconds: CRITICAL_WAIT_SECONDS, note: "launch deferred" });
                if ("error" in w) failed = ` (no wait could be started: ${w.error}; relaunch with: ${JSON.stringify(args)})`;
              }
              s.trace?.emit({ event: "launch_deferred", level: p.level, reasons: p.reasons.join(",") });
              return { block: true, reason: `${refusal}${failed}` };
            }
          } else if (override.text !== undefined) {
            s.trace?.emit({ event: "pressure_override", decision: "not_needed", ...ovTrace, reason: "level" });
          }
          if (p.level === "high" && !approved) {
            const queued = await narrowLaunch(s, ctx, event.toolCallId, input, rawLaunch, p);
            if (queued) return { block: true, reason: queued };
          }
        } else if (override.text !== undefined && !s.isChild) {
          s.trace?.emit({ event: "pressure_override", decision: "not_needed", reason: isLaunchArgs(input) ? "explorer" : "action" });
        }
        // D6: pi-subagents' isolation worktree is a plain `git worktree add` of the innermost repo; inside a nested submodule checkout it would not carry the tree
        if (!s.isChild && isLaunchArgs(input) && launchNeedsNestedRefusal(rawLaunch, ctx.cwd)) {
          return { block: true, reason: "pi-foreman: worktree: true is refused inside a nested submodule checkout (the isolation worktree would hold only that submodule); launch without worktree: true — the round's own tree is the workspace." };
        }
        // Review occasions (occasion.ts launchOccasion): the launch field or the head marker of each reviewer task, before any rewrite or facts block.
        if (!s.isChild && actionOf(input) === null) {
          for (const e of launchEntries(input)) {
            if (typeof e.agent !== "string") continue;
            const r = launchOccasion(e, takenOccasions.get(e), input.reason);
            if ("refused" in r) {
              s.trace?.emit({ event: r.refused });
              return { block: true, reason: r.text };
            }
            occasions.set(e, r.occasion);
            // a field-only launch: the marker heads the caller's own text, so the reviewer and the later steps see the kind
            if (r.prepend && r.occasion !== "item" && typeof e.task === "string") e.task = withOccasionMarker(e.task, r.occasion);
          }
        } else if (s.isChild && actionOf(input) === null) {
          for (const e of launchEntries(input)) {
            const kind = takenOccasions.get(e);
            if (kind && typeof e.agent === "string" && REVIEW_ROLES.includes(e.agent) && typeof e.task === "string") e.task = withOccasionMarker(e.task, kind);
          }
        }
        // Review panel (panel.ts): a `[panel-shadow:<model>]` launch binds to a pending panel and gets the primary's task, or is refused.
        const foremanAt = foremanBaseModel(ctx);
        // The entries the foreman passed the `strong` keyword to, read before sizing, the ladder and applyLaunchModels write their models: a refused strong rung names the next step.
        // (the keyword, or the role's strong model itself)
        // D36: an explicit builder model equal to the strong rung's is the keyword `strong` (its `:level` kept; the default reason keeps `[strong_no_reason]` out of a launch that works today)
        const strongModelAsKeyword = (): void => {
          for (const e of launchEntries(input)) {
            if (e.agent !== "builder") continue;
            const m = e.model ?? input.model;
            const rung = (resolution.roles.builder?.strong as Json | undefined)?.model;
            if (typeof m !== "string" || typeof rung !== "string") continue;
            const split = splitLevel(m.trim());
            if (split.base === "" || split.base !== splitLevel(rung).base) continue;
            e.model = split.level ? `strong:${split.level}` : "strong";
            const has = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
            if (!has(e.reason) && !has(input.reason)) e.reason = "explicit strong model named";
          }
        };
        // D36: any other explicit builder model the rank rules do not allow is refused, read from the raw input before sizing and the ladder (the rank cap could drop it unseen)
        if (!s.isChild && actionOf(input) === null) {
          strongModelAsKeyword();
          const foremanRaw = foremanBaseModel(ctx);
          const mappedBase = typeof resolution.roles.builder?.model === "string" ? splitLevel(resolution.roles.builder.model).base : "";
          for (const e of launchEntries(input)) {
            const m = e.model ?? input.model;
            if (e.agent !== "builder" || typeof m !== "string") continue;
            const base = splitLevel(m.trim()).base;
            if (base === "" || (STRENGTHS as readonly string[]).includes(base) || base === mappedBase) continue;
            const why = explicitModelReason(s.config.config, foremanRaw, base, "builder");
            if (why === null) continue;
            const known = Object.values(resolution.roles).flatMap((r) => [r.model, (r.strong as Json | undefined)?.model]).filter((x): x is string => typeof x === "string");
            const allowed = ranksOf(s.config.config).size > 0 ? allowedExplicitModels(s.config.config, foremanRaw, "builder", known) : [];
            s.trace?.emit({ event: "launch_refused", reason: "model_not_allowed", tier: s.ceremony.tier, ...launchDeny(input) });
            return { block: true, reason: `pi-foreman: launch refused [model_not_allowed] ${base}: ${why}${why.endsWith(".") ? "" : "."}${allowed.length > 0 ? ` Allowed models for builder: ${allowed.join(", ")}. Drop \`model\` or pick one of them.` : " Drop `model` to launch on the builder's own model."}` };
          }
        }
        const strongKeyed = new Set(launchEntries(input).filter((e) => {
          const m = e.model ?? input.model;
          const rung = (resolution.roles[String(e.agent)]?.strong as Json | undefined)?.model;
          const base = typeof m === "string" ? splitLevel(m.trim()).base : "";
          return base === "strong" || (base !== "" && typeof rung === "string" && base === splitLevel(rung).base);
        }));
        shadow = shadowLaunch(input, s.panels.views(), { config: s.config.config, isChild: s.isChild, maxThinking: get(s.config.config, "maxThinking"), childMaxThinking: get(s.config.config, "childMaxThinking"), refused: (m) => rankRefusalFor(s.config.config, foremanAt, m, ["reviewer"])?.message ?? null }, occasions);
        if (shadow.kind === "refused") {
          s.trace?.emit(shadow.trace);
          return { block: true, reason: shadow.message };
        }
        if (shadow.kind === "launch") input.task = shadow.task;
        // High stakes (highstakes.ts): the `[high-stakes]` launch's refusals, a reviewer resume while a high-stakes FAIL is uncleared (a fresh normal reviewer gets the findings).
        if (!s.isChild && shadow.kind !== "launch") {
          const hs = await hsLaunchGuard(s, ctx, input, occasions, hsEntries);
          if (typeof hs === "string") return { block: true, reason: hs };
          hsLaunch = hs;
        }
        // ceremony.reviewPerRevision (D5): a second review of unchanged, already passed work is refused (a pre-pr, high-stakes or plan review is no repeat).
        const ownOccasion = [...occasions.values()].some((o) => o === "pre-pr" || o === "plan-review" || o === "high-stakes");
        const dupOn = !s.isChild && !ownOccasion && shadow.kind !== "launch" && get(s.config.config, "ceremony.reviewPerRevision") !== false;
        // an uncleared high-stakes FAIL whose findings this launch gets is a change in itself: no "nothing changed" refusal (a resume gets no findings)
        // the FAIL's record lands in reviewSync (hsRunEnd): a slow host (Windows git) must not read the state before it
        if (dupOn && actionOf(input) === null && hsModel(s) !== null) await s.reviewSync;
        const gotFindings = actionOf(input) === null && hsModel(s) !== null && s.hs.findingsFor() !== null;
        // the checkouts the reviewers run in (a resumed one: those of its target run; none recorded or one unresolved: null, which reads every entry)
        let dupRoots: (string | null)[] = [];
        if (dupOn && actionOf(input) === "resume") dupRoots = (s.reviewRoots.get(resumeTarget(input) ?? "") ?? [null]).slice();
        else if (dupOn && actionOf(input) === null) dupRoots = await Promise.all(reviewDirs(ctx, input).map((d) => rootOf(d)));
        const dup = dupOn && !gotFindings ? dupReview(standsFor(s.reviewGates, dupRoots) ? { last: "pass", revised: false } : initialReviewGate(), launchRoles(s, input), input, occasions) : null;
        if (dup) {
          const agent = [...new Set(launchRoles(s, input).filter((r) => REVIEW_ROLES.includes(r)))].join(",");
          if (dup === "second-opinion") s.trace?.emit({ event: "review_second_opinion", agent });
          else {
            // The mark is taken asynchronously at the PASS; wait for it, then compare builder runs, HEAD, worktree (incl. untracked) and ledger.
            await s.reviewSync;
            const marks = dupRoots.map((r) => markKeyOf(s, r)).map((k) => (k === undefined ? undefined : { key: k, mark: s.passMarks[k] }));
            const signals = new Set<string>();
            for (const m of marks) {
              if (!m) continue;
              for (const x of repeatSignals(m.mark, { head: await headOf(m.mark.cwd), tree: m.mark.tree && (await treeChangedSince(m.mark.cwd, m.mark.tree)) ? "changed" : m.mark.tree, ledger: ledgerSignal(s), builderRuns: builderRunsOf(s, m.key) })) signals.add(x); // a change in any checkout of the launch lifts the refusal
            }
            if (signals.size > 0) s.trace?.emit({ event: "review_dup_allowed", agent, signals: [...signals].join(",") });
            else {
              s.trace?.emit({ event: "review_dup_refused", agent });
              return { block: true, reason: dupRefusalText(marks.find((m) => m)?.mark.at) };
            }
          }
        }
        // Plan form by code (ownertext.ts planFormIssues): a `[plan-review]` reviewer is not started on a plan with form faults; an unreadable plan is left to the reviewer.
        if (!s.isChild && actionOf(input) === null) {
          const faults: string[] = [];
          const stale: string[] = [];
          for (const [e, occ] of occasions) {
            if (occ !== "plan-review" || typeof e.agent !== "string" || !REVIEW_ROLES.includes(e.agent)) continue;
            for (const rp of readPlansOnce(planPathsOf(planReviewFiles(String(e.task ?? ""), null), editModeOfSession(s).scratchDir), planOpts(s, ctx))) {
              const issues = planFormIssues(rp.plan.markdown, {});
              if (issues.length > 0) faults.push(`${rp.raw}: ${issues.join("; ")}`);
              const why = copyStale(rp.plan);
              if (why) stale.push(`${rp.raw}: ${why}`);
            }
          }
          if (stale.length > 0) {
            s.trace?.emit({ event: "launch_refused", reason: "plan_copy_stale", tier: s.ceremony.tier, ...launchDeny(input) });
            return { block: true, reason: `pi-foreman: reviewer launch refused [plan_copy_stale]: the markdown copy of the plan page is out of date (${stale.join(" | ")}), so the reviewer would read another version than the page. Fix the cause (delete a hand-written or locked plan-<topic>.md, or free the scratch dir) and launch again; no reviewer was started.` };
          }
          if (faults.length > 0) {
            s.trace?.emit({ event: "launch_refused", reason: "plan_form", tier: s.ceremony.tier, ...launchDeny(input) });
            return { block: true, reason: `pi-foreman: reviewer launch refused [plan_form]: the plan form is wrong (${faults.join(" | ")}). Fix the plan and launch again: the first ## section must be a non-empty ## Summary (## For the owner is still accepted); no reviewer was started.` };
          }
        }
        // Lane 3c: budget guard on the summed estimate (foreman + all runs); 3e: review cap and item-only re-review.
        if (!s.isChild && actionOf(input) === null && shadow.kind !== "launch") {
          const cost = summedCost(s);
          const bd = budgetCheck(cost.foreman, cost.runs, budgetCap(get(s.config.config, "ceremony.budgetUsd")), s.budgetWarned);
          if (bd?.kind === "refuse") {
            s.trace?.emit({ event: "launch_refused", reason: bd.reason, tier: s.ceremony.tier, cost: Math.round(cost.total * 10000) / 10000, limit: budgetCap(get(s.config.config, "ceremony.budgetUsd")), ...launchDeny(input) });
            return { block: true, reason: bd.text };
          }
          if (bd?.kind === "warn") {
            budgetNotes = [bd.text];
            pendingWarn = { event: "budget_warn", cost: Math.round(cost.total * 10000) / 10000, limit: budgetCap(get(s.config.config, "ceremony.budgetUsd")) };
          }
          // Loop guard (reviewloop.ts): a stop refuses a builder or a non-second-opinion reviewer launch until the owner clears it.
          await s.reviewSync; // a review round still being recorded lands (and may set the stop) before the gate reads it
          if (s.loopStop && (subagentAgents(input).includes("builder") || [...occasions].some(([e, o]) => typeof e.agent === "string" && REVIEW_ROLES.includes(e.agent) && o !== "second-opinion"))) {
            s.trace?.emit({ event: "launch_refused", reason: "review_loop", tier: s.ceremony.tier, rule: s.loopStop.rule, kind: s.loopStop.kind, ...launchDeny(input) });
            return { block: true, reason: (process.env.PI_FOREMAN_HANDOFF_DIR?.trim() && process.env.PI_FOREMAN_PARENT_INTERCOM?.trim() ? (st: LoopStop) => loopRefusalParented(st, process.env[REMOTE_PARENT_ENV] === "1") : loopRefusal)(s.loopStop) };
          }
          if (s.failItems.length > 0) for (const [e, occ] of occasions) if (occ === "item" && typeof e.agent === "string" && REVIEW_ROLES.includes(e.agent) && typeof e.task === "string") {
            // the line names only the failed items inside the launch's set (verdict.ts launchItemsOf: the given items, else the failed items still open); with an `items` field it also asks for a result on each
            const { given, r } = launchItemsFor(e);
            const take = r && "items" in r ? allowedItems(r.items, hsLaunch !== null) : [];
            e.task = given && "items" in given ? prependReReviewScoped(e.task, s.failItems, take) : prependReReview(e.task, s.failItems.filter((f) => take.map(String).includes(f)));
          }
          // R39: builders launched with a strong risk tag (sizing.ts): the next item or pre-pr reviewer is asked for bypass probes.
          if (s.ladder.probeRisks.size > 0) for (const [e, occ] of occasions) if ((occ === "item" || occ === "pre-pr") && typeof e.agent === "string" && REVIEW_ROLES.includes(e.agent) && typeof e.task === "string") e.task = prependProbe(e.task, s.ladder.probeRisks);
        }
        // D3/D4: builder runs after a review of built work are revision rounds: every step of a
        // tasks/chain call, and a resume of a builder run (its model stays, so never a strong
        // relaunch). Checked here, on the guarded path; a refused launch counts and records nothing.
        const resumed = actionOf(input) === "resume";
        const steps = s.isChild ? [] : roundSteps(input, s.runs);
        let preferStrong = false;
        let revClimb: "revision" | "review_fail" | null = null;
        const bottomWhy = new Map<string, string>();
        const noStrong = "no strong rung mapped";
        if (steps.length > 0) {
          const answeredBefore = s.round.revisionAnswered === true;
          // the review gate of the builder's checkouts: the revision climbs when one of them last failed (an unknown checkout reads every entry)
          const builderRoots = resumed ? null : await rootsOf(builderDirs(ctx, input));
          const failedHere = builderRoots === null ? combined(s.reviewGates).last === "fail" : builderRoots.some((r) => gateOf(s.reviewGates, r).last === "fail");
          rounds = walkLaunch(s.round, steps);
          // A further fresh builder in the same prompt, after a revision already answered the open FAIL, is a revision too (no extra round).
          const again = !resumed && rounds.revisions === 0 && answeredBefore && failedHere && steps.some((g) => g.includes("builder"));
          const revision = rounds.revisions > 0 || again;
          const keyword = typeof input.model === "string" && (STRENGTHS as readonly string[]).includes(splitLevel(input.model.trim()).base);
          // ladder.ts revisionClimb: review_fail while the review gate of the builder's checkouts last failed (`failedHere`, not the run's own
          // verdict), else only with providers.<p>.strongOnRevision true. LadderState.plan targets max(current, strong) by rank.
          revClimb = revision && !resumed ? revisionClimb(s.config.config, resolution.provider, failedHere) : null;
          const noStrongAsked = revClimb !== null && !hasStrongRung(resolution.roles, "builder");
          if (revClimb !== null && !hasStrongRung(resolution.roles, "builder")) {
            s.trace?.emit({ event: "revision_no_strong", role: "builder" });
            bottomWhy.set("builder", noStrong);
          }
          if (revClimb === "review_fail" && !hasStrongRung(resolution.roles, "builder")) revClimb = null; // no strong rung: no-op
          preferStrong = revClimb !== null && !keyword;
          kind = revision ? (preferStrong ? "strong-relaunch" : "revision") : undefined;
          if (revision) revisionTrace = { reason: revClimb ?? "none", keyword, noStrong: noStrongAsked };
        }
        // Ladder (ladder.ts): a strong launch needs a reason or a trigger; rank policy (ranks.ts) after the models are written.
        // A panel shadow skips it: no climb, no live rung.
        if (!s.isChild && actionOf(input) === null && shadow.kind !== "launch") {
          // Launch sizing (sizing.ts): the rung of each builder entry from its measured size and risk; a climbing entry gets model "strong" and the ladder reason `sizing`.
          if (sized && sizingConfig(s.config.config).enabled) {
            const maxT = get(s.config.config, "maxThinking");
            const childT = get(s.config.config, "childMaxThinking");
            const wanted = sizingTopModel(s.config.config, resolution.roles, maxT, childT);
            sizingTop = wanted && rankRefusalFor(s.config.config, foremanAt, wanted, ["builder"]) === null ? wanted : null;
            const sp = planSizing(input, sized.entries, sized.carried, { config: s.config.config, roles: resolution.roles, ranks: ranksOf(s.config.config), cwd: ctx.cwd, tier: s.ceremony.tier, revisionClimb: revClimb !== null, top: sizingTop });
            if (sp.block) {
              s.trace?.emit({ event: "launch_refused", reason: sp.block.includes("[sizing_below]") ? "sizing_below" : "sizing_invalid", tier: s.ceremony.tier, ...launchDeny(input) });
              return { block: true, reason: sp.block };
            }
            sizedPlans = sp.plans;
            sizingClimbs = sp.climbs;
          }
          // The rank loop's decision for the strong rung (below: the equalOnStrongRisk tie of a strong-risk sized entry), so an automatic climb never ends in a refusal.
          const strongAllowed = (e: Json, strongModel: string): boolean => {
            if (rankRefusalFor(s.config.config, foremanAt, strongModel, ["builder"]) === null) return true;
            const plan = sizedPlans.find((p) => p.entry === e);
            return foremanAt !== null && splitLevel(strongModel).base === foremanAt && rankTie(s.config.config, foremanAt, strongModel, "builder") && equalOnStrongRisk(s.config.config) && plan?.role === "builder" && plan.target === "strong" && plan.probe.length > 0;
          };
          const lp = s.ladder.plan(input, resolution.roles, { tier: s.ceremony.tier, preferStrong: revClimb !== null, revisionReason: revClimb ?? undefined, ranks: ranksOf(s.config.config), sizing: sizingClimbs, strongAllowed, sizingSource: (e) => { const p = sizedPlans.find((x) => x.entry === e); return p ? `sizing:${p.rule}` : undefined; }, explicitAllowed: (m) => explicitModelAllowed(s.config.config, foremanAt, m, "builder") });
          if (lp.block) {
            s.trace?.emit({ event: "launch_refused", reason: "strong_no_reason", tier: s.ceremony.tier, ...launchDeny(input) });
            return { block: true, reason: lp.block };
          }
          climbs = lp.climbs;
          ladderRoles = resolution.roles;
          // ladder.reviewerClimb (reviewerclimb.ts): the reviewer's diff is taken here, before its model is picked; the facts reuse it.
          await s.reviewRuns.sync; // earlier run ends' findings are recorded (and traced) first
          const rc = await planReviewerClimbs(input, resolution.roles, { config: s.config.config, live: s.ladder.live, fails: s.reviewerFails, skip: hsEntries, diffOf: async (e) => { const d = await reviewFacts.diffOf(e, input, ctx.cwd); return d.diff || d.untracked ? (d.diff ?? "") + d.untracked : null; } });
          reviewerClimbs = rc.climbs;
          reviewerTraces = rc.traces;
        }
        const foremanAt0 = foremanBaseModel(ctx);
        const unmodelled = new Set(launchEntries(input).filter((e) => typeof (e.model ?? input.model) !== "string" || String(e.model ?? input.model).trim() === ""));
        const explicitReviewers = new Set<string>(); // base ids the launch call set explicitly and explicitModelAllowed honoured (a pair never replaces them)
        const launched = applyLaunchModels(input, resolution.roles, get(s.config.config, "maxThinking"), { tier: s.ceremony.tier, provider: resolution.provider, preferStrong, capped: new Set(climbs.filter((c) => c.skipped).map((c) => c.entry)), childMaxThinking: get(s.config.config, "childMaxThinking"), explicit: (role, m) => { const ok = explicitModelAllowed(s.config.config, foremanAt0, m, role); if (ok && role === "reviewer") explicitReviewers.add(m); return ok; } });
        // A capped climb (RANK_CAPPED_REASON: skipped, or only carrying the pending handoff) names the model the launch runs on: the entry as applyLaunchModels wrote it (an explicit model the policy rejects was replaced by the mapped rung). A real rung_up or an above-strong climb that carries a handoff keeps its own from/to.
        for (const c of climbs) if (c.reason === RANK_CAPPED_REASON && typeof c.entry.model === "string") c.from = c.to = splitLevel(c.entry.model).base;
        for (const n of launched.notices) bottomWhy.set(n.role, noStrong);
        const strongB = (resolution.roles.builder as { strong?: { model?: unknown } } | undefined)?.strong?.model;
        if (s.ceremony.tier === "heavy" && typeof strongB === "string") heavyDefault = launchEntries(input).filter((e) => e.agent === "builder" && unmodelled.has(e) && typeof e.model === "string" && splitLevel(e.model).base === splitLevel(strongB).base && !climbs.some((c) => c.entry === e));
        if (bottomWhy.size > 0) pendingBottom = bottomWhy;
        if (sizedPlans.length > 0) {
          // The top rung is written after the mapped models, like the research floor; its rung_up names it.
          for (const p of sizedPlans) {
            if (!p.combo.climb || p.target !== "top" || !sizingTop || climbs.some((c) => c.entry === p.entry && c.skipped)) continue;
            p.entry.model = sizingTop;
            for (const c of climbs) if (c.entry === p.entry) c.to = splitLevel(sizingTop).base;
          }
          const rungs: RungContext = { roles: resolution.roles, ranks: ranksOf(s.config.config), top: sizingTop };
          // a skipped climb (rank policy) keeps the rung that was rated (`rated`) next to the rung launched (`rung`)
          sizingRecords = sizedPlans.map((p) => {
            const rec = sizingTrace(p, p.role === "builder" && typeof p.entry.model === "string" ? (rungOfModel(p.entry.model, rungs) ?? "default") : "default");
            return climbs.some((c) => c.entry === p.entry && c.skipped && c.source?.startsWith("sizing")) ? { ...rec, rated: p.target, note: [...p.combo.note, "rank_capped"].join(",") } : rec;
          });
        }
        const equalLines: string[] = []; // the launch lines of the builders that ladder.equalOnStrongRisk let run on the foreman's own model
        // A panel shadow runs on its own model (rank-checked in shadowLaunch): no occasion override, rank loop or different-model rule.
        if (shadow.kind === "launch") input.model = shadow.model;
        else if (!s.isChild && actionOf(input) === null) {
          // ceremony.reviewByOccasion (reviewerclimb.ts): over the mapped models, before the rank check and the different-model rule.
          const reviewerEntries = launchEntries(input).filter((e) => e.agent === "reviewer" && typeof e.model === "string");
          const pinned = new Map<Json, ReviewPin>(reviewerEntries.filter((e) => explicitReviewers.has(splitLevel(e.model as string).base)).map((e) => [e, "explicit"]));
          // `[high-stakes]` (highstakes.ts): ceremony.highStakes.model exactly as set, whatever the launch named; no pair, different-model move, rank refusal or climb.
          const hsForced = hsModel(s);
          if (hsForced) for (const e of hsEntries) {
            const requested = typeof e.model === "string" ? e.model : null;
            e.model = cappedRung(hsForced, get(s.config.config, "maxThinking"), get(s.config.config, "childMaxThinking"));
            if (requested !== e.model) s.trace?.emit({ event: "model_override", role: "reviewer", model: e.model, ...(requested ? { requested } : {}) });
            pinned.set(e, "high_stakes");
          }
          const occ = applyOccasionOverrides(input, occasions, reviewerClimbs, { config: s.config.config, maxThinking: get(s.config.config, "maxThinking"), childMaxThinking: get(s.config.config, "childMaxThinking") });
          reviewerTraces.push(...occ.traces);
          for (const e of occ.overrode) pinned.set(e, "occasion");
          // The `[high-stakes]` entry is used as set, like an occasion model: its record names the policy override.
          for (const e of hsEntries) {
            const rec: Record<string, unknown> = { event: "review_occasion", role: "reviewer", occasion: "high-stakes", thinking: null, model_overridden: true };
            reviewerTraces.push(rec);
            occ.traceOf.set(e, rec);
            occ.overrode.add(e);
          }
          // [research] / [fact-critical] markers (research.ts): the floor is written before the rank check.
          const marked = markedEntries(input, hsEntries);
          const raised = applyResearchFloor(marked, resolution.roles, s.config.config, get(s.config.config, "maxThinking"), get(s.config.config, "childMaxThinking"));
          const foremanModel = foremanBaseModel(ctx);
          // An occasion model is used as set (like a pair): its entry skips the rank check, traced policy_override when the policy would refuse it; other entries sharing the model are still checked.
          for (const [e, rec] of occ.traceOf) if (occ.overrode.has(e) && typeof e.model === "string" && rankRefusalFor(s.config.config, foremanModel, e.model, ["reviewer"]) !== null) rec.policy_override = true;
          const checked = (m: string): string[] => (occ.overrode.size === 0 ? rolesOfModel(input, m) : launchEntries(input).filter((e) => !occ.overrode.has(e) && typeof e.agent === "string" && e.model === m).map((e) => e.agent as string));
          for (const m of launchedModels(input)) {
            const roles = checked(m);
            if (occ.overrode.size > 0 && roles.length === 0) continue;
            const no = rankRefusalFor(s.config.config, foremanModel, m, roles);
            if (!no) continue;
            // ladder.equalOnStrongRisk (ranks.ts): a tie of the foreman's own model with the builder's strong model, for builder entries only whose risk tag sent them to the strong rung.
            const strongModel = get(resolution.roles, "builder.strong.model");
            const carrying = launchEntries(input).filter((e) => typeof e.agent === "string" && e.model === m && !occ.overrode.has(e));
            const plans = carrying.map((e) => sizedPlans.find((p) => p.entry === e));
            const tie = carrying.length > 0 && foremanModel !== null && splitLevel(m).base === foremanModel && typeof strongModel === "string" && splitLevel(strongModel).base === foremanModel
              && rankTie(s.config.config, foremanModel, m, "builder") && carrying.every((e, i) => e.agent === "builder" && plans[i]?.role === "builder" && plans[i]?.target === "strong" && (plans[i]?.probe.length ?? 0) > 0);
            if (tie && equalOnStrongRisk(s.config.config)) {
              const risk = [...new Set(plans.flatMap((p) => p?.probe ?? []))].join(",");
              s.trace?.emit({ event: "rank_equal_model", role: "builder", model: foremanModel, foreman: foremanModel, policy: no.policy, risk });
              equalLines.push(`pi-foreman: builder runs on the foreman's own model ${foremanModel} (ladder.equalOnStrongRisk, risk: ${risk}).`);
              continue;
            }
            const marker = floorMarker(raised, m);
            s.trace?.emit({ event: "launch_refused", reason: "rank_policy", ...launchDeny(input), policy: no.policy, foreman: no.foreman, requested: no.requested, ...(marker ? { marker } : {}) });
            const strongAsked = carrying.some((e) => strongKeyed.has(e));
            const cause = normalModelSentence(s.config.config, foremanModel, m, roles, resolution.roles);
            const refusal = cause ? `${no.message} ${cause}` : no.message;
            return { block: true, reason: (marker ? `${refusal} The [${marker}] marker raised this entry to its role's strong rung, which the rank policy refuses; drop the marker or map a strong rung the policy allows.` : refusal) + (strongAsked ? ` Relaunch with model "default" and a reason to run on the default rung.` : "") + (tie ? ` ${equalKeySentence()}` : "") };
          }
          // The security rung is explicit config: written after the rank check (docs/ladder.md); traced when it overrides the policy.
          markPolicyOverrides(reviewerClimbs, (m) => rankRefusalFor(s.config.config, foremanModel, m, ["reviewer"]) !== null);
          applySecurityRungs(reviewerClimbs, get(s.config.config, "maxThinking"), get(s.config.config, "childMaxThinking"));
          applyFactCriticalRungs(marked, resolution.roles, s.config.config, get(s.config.config, "maxThinking"), get(s.config.config, "childMaxThinking"));
          for (const r of researchTraces(marked)) s.trace?.emit(r);
          for (const r of entryTraces(input, marked)) s.trace?.emit(r);
          // Different-model rule (every reviewer launch): after the security rung, so it sees the final model; traced with policy_override.
          const refusedBy = (m: string): boolean => rankRefusalFor(s.config.config, foremanModel, m, ["reviewer"]) !== null;
          for (const c of reviewerClimbs) if (c.reason === "security") pinned.set(c.entry, "security_rung");
          // the rank checks keep the base model; the review rule judges the live one
          reviewerTraces.push(...applyReviewModelRule(input, resolution.roles, { config: s.config.config, foreman: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, pinned, maxThinking: get(s.config.config, "maxThinking"), childMaxThinking: get(s.config.config, "childMaxThinking"), refused: refusedBy, thinking: occ.thinking }));
          for (const c of reviewerClimbs) if (c.reason === "review_fail_repeat" && typeof (c.entry as Json).model === "string" && splitLevel((c.entry as Json).model as string).base !== splitLevel(c.model).base) climbReplaced.add(c.entry);
          // Review panel (panel.ts): a gate-occasion reviewer is the primary; its shadows come after its run end.
          panel = primaryPanel(input, occasions, s.config.config, foremanModel);
        }
        for (const o of launched.overrides) s.trace?.emit({ event: "model_override", role: o.role, model: o.model, requested: o.requested });
        for (const n of launched.notices) s.trace?.emit({ event: "strong_unmapped", role: n.role, model: n.model, tier: s.ceremony.tier });
        const cappedLines = climbs.filter((c) => c.skipped).map((c) => {
          const no = rankRefusalFor(s.config.config, foremanAt0, c.skipped!, [c.role]);
          return `pi-foreman: the climb of ${c.role} to its strong rung ${c.skipped} was skipped: the rank policy (${no?.policy ?? "below"}) does not allow that model for the ${c.role} under the foreman ${foremanAt0 ?? "unknown"}; it launches on ${c.to}.`;
        });
        const handoffLines = climbs.filter((c) => c.handoffFor).map((c) => `pi-foreman: the earlier report of the ${c.role} run ${c.handoff!.runId} (${c.handoff!.cause}) was prepended to this launch because the strong rung ${c.handoffFor} is not allowed by the rank policy.`);
        const switchedLines = launched.overrides.map((o) => `model switched: ${o.requested} -> ${o.model} (${explicitModelReason(s.config.config, foremanAt0, o.requested, o.role) ?? "not honoured"})`);
        notices = [...launched.notices.map((n) => n.text), ...switchedLines, ...equalLines, ...cappedLines, ...handoffLines];
        const clamp = applyLaunchTimeouts(input, get(s.config.config, "roles"), get(s.config.config, "ceremony.childTimeoutSeconds"), get(s.config.config, "ceremony.launchTimeoutCapMinutes"));
        if (clamp) s.trace?.emit({ event: "launch_timeout", ...clamp, reason: "cap" });
      }
      const pc = payloadCtx(s, ctx);
      // safety.preBash.hooks (prebash.ts): user-configured hooks before a bash call; a hook error is traced and ignored unless safety.preBash.strict
      if (event.toolName === "bash" && typeof input.command === "string") {
        const pre = preBashConfigOf(get(s.config.config, "safety.preBash"));
        if (pre.hooks.length) {
          const hr = await runPreBashHooks(pre, { command: input.command, cwd: ctx.cwd, tool: event.toolName, session: s.id, role: s.isChild ? s.usage.line.role ?? "child" : "foreman" }, { spawner, agentDir: s.agentDir });
          for (const e of hr.errors) s.trace?.emit({ event: "prebash_hook_error", kind: pre.strict ? "strict" : "ignored", reason: `${e.hook}: ${e.error}` });
          if (hr.blocked) return { block: true, reason: hr.blocked };
        }
      }
      if (isShellTool(event.toolName)) {
        const bad = guardPayloadBlock(event.toolName, input);
        if (bad) return { block: true, reason: bad };
      }
      for (const guard of mapping.pre) {
        let agents: string[] = [];
        if (guard === "ledger_guard_spawn") {
          agents = subagentAgents(input);
          // Plan phase: explorers research before any ledger exists; the core gate would ask for one, so it is not called for them.
          if (s.planPhase && !s.isChild && agents.length > 0 && agents.every((a) => a === "explorer") && !boundLedger(s.markerDir, s.id)) {
            s.trace?.emit({ event: "plan_phase_explorer", role: "explorer" });
            continue;
          }
          setCeremony(s, beforeSpawn(s.ceremony, agents, trivialBuilderPath(get(s.config.config, "ceremony.required"))));
        }
        const payload = preToolPayload(event.toolName, input, pc);
        if (guard === "ledger_guard_spawn") {
          (payload.tool_input as Record<string, unknown>).prompt = callerTask;
          payload.permission_mode = spawnPermissionMode(planModeOn(ctx.sessionManager.getBranch?.() ?? []), agents);
        }
        const outcome = await run(s, ctx, guard, payload, mapping.coreName);
        const target = guard === "ledger_guard_write" ? resolveToolPath(input.path, ctx.cwd, os.homedir()) : null;
        const t = await translateToolCall({
          guard,
          outcome,
          piTool: event.toolName,
          input,
          ask: { isChild: s.isChild, mode: ctx.mode, hasUI: ctx.hasUI, confirm: blockedConfirmOn(herdrEvents, BLOCK_CONFIRM, (title, msg) => ctx.ui.confirm(title, msg)) },
          ledgerTarget: target ? isLedgerTarget(target) : false,
        });
        if (t.openFailure) notifyOnce(s, ctx, `open:${guard}`, t.openFailure);
        if (outcome.kind === "decision" && outcome.d.decision === "ask") s.trace?.emit({ event: "ask", guard, toolFamily: mapping.coreName, decision: askOutcome(s.isChild, t.result?.reason) });
        if (t.result) return t.result;
        if (guard === "ledger_guard_spawn" && agents.length > 0) {
          setCeremony(s, afterSpawn(s.ceremony));
          const modelOf = roleModelsOf(input);
          for (const role of agents) s.trace?.emit({ event: "role_launch", role, ...(modelOf.has(role) ? { model: modelOf.get(role) } : {}), ...(REVIEW_ROLES.includes(role) ? { occasion: [...occasions].find(([e]) => e.agent === role)?.[1] ?? "item" } : {}) });
        }
      }
      // A main-session shell line that names git or a forge tool: hooks and git config changed since the snapshot stop it (after the pre-bash checks, as before).
      if (isShellTool(event.toolName) && !s.isChild && mainNeedsGitGuard(input.command)) {
        const drift = await s.gitDrift.gate(ctx.cwd, os.homedir(), "this git command", driftAsk(ctx, s.trace), (r) => s.trace?.emit(r), event.toolCallId);
        if (drift) return drift;
      }
      if (event.toolName === "subagent" && !s.isChild) {
        // Changes since the last launch are checked first, so a new launch cannot absorb them.
        const drift = await s.gitDrift.gate(ctx.cwd, os.homedir(), "this child launch", driftAsk(ctx, s.trace), (r) => s.trace?.emit(r));
        if (drift) return drift;
        s.gitDrift.snapshot(ctx.cwd, os.homedir());
        // Frugal-roles D5: base for the review diff at a builder launch, diff facts into a reviewer's task.
        await reviewFacts.noteBuilders(input, ctx.cwd);
        if (occasions.size > 0) {
          // Review bookkeeping to the run end (occasion.ts): occasion, shadow, model per entry; the files the findings are located in.
          const first = launchEntries(input).find((e) => typeof e.agent === "string" && REVIEW_ROLES.includes(e.agent));
          const occ = first ? occasions.get(first) : undefined;
          const diffText = !first || occ === "plan-review" ? null : await reviewFacts.diffOf(first, input, ctx.cwd).then((d) => `${d.diff ?? ""}\n${d.untracked}`, () => null);
          const files = !first ? [] : occ === "plan-review" ? planReviewFiles(String(first.task ?? ""), boundLedger(s.markerDir, s.id)) : filesOfDiff(diffText);
          const sh = shadow.kind === "launch" ? shadow : null;
          const rl = reviewLaunchOf(input, occasions, new Map(sh ? [[input, sh.base]] : []), { started: Date.now(), files, panel: sh ? { gate: sh.pending.gate, primary: sh.pending.primary, shadows: [sh.base] } : panel?.panel ?? null, climbed: new Set(reviewerClimbs.filter((c) => !climbReplaced.has(c.entry)).map((c) => c.entry)) });
          if (rl && panel) rl.task = panel.task;
          if (rl && sh) rl.bind = sh.pending.id;
          if (rl && diffText !== null) rl.lines = diffLinesOf(diffText);
          if (rl) capSet(s.reviewRuns.byCall, event.toolCallId, rl);
        }
        const planLedger = boundLedger(s.markerDir, s.id);
        const factCount = await reviewFacts.augment(input, ctx.cwd, (task, step) => {
          if ((occasions.get(step) ?? occasionOf(task)) !== "plan-review") return null;
          const lg = (() => { try { return planLedger ? fs.readFileSync(planLedger, "utf8") : null; } catch { return null; } })();
          const planPaths = planPathsOf(planReviewFiles(task, null), editModeOfSession(s).scratchDir);
          const rereview: string[] = [];
          const hiddenFacts: string[] = [];
          const readable = readPlansOnce(planPaths, planOpts(s, ctx));
          for (const rp of readable) {
            // The key is the real path and the text is what the reviewer reads now (the markdown copy of a page); the last reviewed text is in memory only.
            const p = rp.raw;
            const text = rp.plan.markdown;
            if (rp.plan.kind === "html") {
              hiddenFacts.push(`Plan page ${rp.plan.rel}: read the markdown copy ${rp.plan.copyPath} (generated from the page, which is the plan the owner approves; rulings are in rulings-${rp.plan.topic}.md).`);
              const hidden = hiddenFactsLine(rp.plan.hidden ?? []);
              if (hidden) hiddenFacts.push(`Hidden-style facts of ${rp.plan.rel} (CSS or attributes that hide or add words the copy does not show; judge whether the page misleads): ${hidden}`);
            }
            const before = s.planReviews.reviewedText(rp.plan.path);
            if (s.planReviews.lineage(rp.plan.path)) {
              rereview.push(`Re-review of ${p}: verify that the findings of the earlier review are fixed, and review the changed text in full against the first-review list.`);
              rereview.push(...(before === null ? ["no diff (the last reviewed version is not in memory)"] : planDiffLines(p, before, text)));
            }
            s.planReviews.noteLaunch(rp.plan.path, rp.plan.hash, text, s.launchBatch.generation);
          }
          // one entry per plan (a page and its copy named together are one); a plan that cannot be read stays listed
          const raws = new Set(readable.map((rp) => rp.raw));
          const once = planPaths.filter((p) => raws.has(p) || !("plan" in readPlan(p, planOpts(s, ctx))));
          const copyOf = new Map(readable.filter((rp) => rp.plan.kind === "html").map((rp) => [rp.raw, rp.plan.copyPath ?? rp.plan.path]));
          return [planFactsBlock(once.map((p) => copyOf.get(p) ?? p), planLedger, lg), ...hiddenFacts, ...ownerFactsLines(once, ctx.cwd, planOpts(s, ctx)), ...rereview].join("\n");
        });
        if (factCount > 0) s.trace?.emit({ event: "review_facts", count: factCount });
        // PR gate (B-M4): HEAD at a reviewer's launch; the verdict keeps a head only if it is unchanged at run end.
        const action = actionOf(input);
        if (action === "resume" || (action === null && subagentAgents(input).some((r) => REVIEW_ROLES.includes(r)))) {
          const cwds = launchCwds(input, ctx.cwd);
          const [heads, trees] = await Promise.all([headsAt(cwds), treesAt(cwds, launchSnapshot)]);
          capSet(s.launchHeadsByCall, event.toolCallId, heads);
          capSet(s.launchTreesByCall, event.toolCallId, trees);
          // the checkouts the verdict applies to (reviewgates.ts): each reviewer entry's own dir; a resume keeps its target's; one unresolved: unknown
          if (!s.isChild) capSet(s.reviewRootsByCall, event.toolCallId, action === "resume" ? (s.reviewRoots.get(resumeTarget(input) ?? "") ?? null) : await rootsOf(reviewDirs(ctx, input, (e) => { const o = occasions.get(e); return o !== undefined && countsForItems(o); })));
        }
        await noteReadonlyStart(s, event.toolCallId, input, ctx.cwd);
      }
      // Kept for the tool result only once the launch passed every check.
      if (pendingBottom) capSet(bottomNotes, event.toolCallId, pendingBottom);
      const reviewOccasions = [...occasions].filter(([e]) => typeof e.agent === "string" && REVIEW_ROLES.includes(e.agent)).map(([, o]) => o);
      if (reviewOccasions.length > 0) capSet(launchOccasions, event.toolCallId, reviewOccasions);
      if (climbs.length > 0 || heavyDefault.length > 0) {
        const cn = climbNotesOf(climbs, sizedPlans, sizingConfig(s.config.config), heavyDefault);
        if (cn.size > 0) capSet(climbNotes, event.toolCallId, cn);
      }
      for (const r of sizingRecords) s.trace?.emit(r);
      // Plan publication (show.ts): a `[plan-review]` launch is a ruling point for the plan its task names.
      for (const [e, o] of occasions) if (o === "plan-review" && typeof e.agent === "string" && REVIEW_ROLES.includes(e.agent)) s.show?.planReviewLaunched(String(e.task ?? ""));
      if (pendingWarn) {
        s.budgetWarned = true;
        s.trace?.emit(pendingWarn);
      }
      if (notices.length + budgetNotes.length + mcpNotes.length > 0) s.launchNotices.set(event.toolCallId, [...notices, ...budgetNotes, ...mcpNotes]);
      if (event.toolName === "subagent" && !s.isChild && subagentAgents(input).includes("builder")) {
        const applied = s.critique.onBuilder();
        if (applied) s.trace?.emit(applied);
      }
      if (rounds) {
        s.round = rounds.next;
        for (let i = 0; i < rounds.revisions; i++) s.trace?.emit({ event: "revision", role: "builder", tier: s.ceremony.tier, decision: kind });
      }
      if (rounds) persistRounds(s);
      // the ledger each launch entry resolved to, by entry: the roots block and the ladder handoff read it, not the task text (which holds the injected block by then)
      const entryLedger = new Map<object, string | null>();
      if (event.toolName === "subagent" && !s.isChild) {
        const lf = boundLedger(s.markerDir, s.id);
        const lg = (() => { try { return lf ? fs.readFileSync(lf, "utf8") : null; } catch { return null; } })();
        // D31: the ledger a task names by path drives its block, roots block, marks and hints
        const pickLedger = (task: string) => {
          const t = taskLedger(task, ctx.cwd, lf, [s.cwd, ctx.cwd]);
          const text = t.path === lf ? lg : (() => { try { return t.path ? fs.readFileSync(t.path, "utf8") : null; } catch { return null; } })();
          return { text, path: t.path, ...(t.notice ? { notice: t.notice } : {}), named: t.named };
        };
        // one named path per agent entry (a parallel group is flattened, its own object is no entry); null = the bound ledger
        const agentEntries = launchEntries(input).filter((e) => typeof e.agent === "string");
        const perEntry = agentEntries.map((e) => { const p = typeof e.task === "string" ? pickLedger(e.task) : null; return p?.named && p.path ? p.path : null; });
        agentEntries.forEach((e, i) => entryLedger.set(e, perEntry[i] ?? lf));
        if (actionOf(input) !== "resume") capSet(s.ledgerByCall, event.toolCallId, { paths: perEntry, cited: agentEntries.map((e) => citedItems(typeof e.task === "string" ? e.task : "")) });
        // The items of each review launch (verdict.ts): the `items` field, else every open item; after a FAIL the item occasion's default is the failed items still open.
        const givenItems = new Map<Json, ItemId[]>();
        if (actionOf(input) === null) for (const e of agentEntries) {
          if (!REVIEW_ROLES.includes(e.agent as string)) continue;
          const { given, r } = launchItemsFor(e);
          if (given && "error" in given) return { block: true, reason: `pi-foreman: ${given.error}.` };
          if (given && "items" in given) givenItems.set(e, given.items);
          if (!r) continue;
          if ("unknown" in r) {
            s.trace?.emit({ event: "launch_refused", reason: "items_unknown", tier: s.ceremony.tier, ...launchDeny(input) });
            return { block: true, reason: `pi-foreman: items ${r.unknown.join(", ")} ${r.unknown.length === 1 ? "is" : "are"} not open on the ledger. Open items: ${r.open}.` };
          }
          verdictItems.set(e, r.items);
        }
        // T13: a reviewer whose record folder cannot be made could never give a verdict; made after the last refusal above, so a refused launch leaves no folder
        const reviewRole = singleLaunchRole(input);
        if (!s.isChild && actionOf(input) === null && reviewRole && REVIEW_ROLES.includes(reviewRole)) {
          try {
            makeRecordDir(recordSessionDir(s.agentDir, s.id));
          } catch (err) {
            s.trace?.emit({ event: "launch_refused", reason: "review_record_dir", tier: s.ceremony.tier, ...launchDeny(input) });
            return { block: true, reason: `pi-foreman: launch refused [review_record_dir]: the reviewer's record folder cannot be made (${(err as Error).message}). Fix the folder or its permissions under the agent dir (pi-foreman/state/review-records), then launch again.` };
          }
        }
        // every review task of a single launch ends with the ids review_verdict takes (the set the tool and the binding use), after the facts the plan review added
        if (actionOf(input) === null && launchEntries(input).length === 1) for (const e of agentEntries) if (REVIEW_ROLES.includes(e.agent as string) && typeof e.task === "string") e.task = `${e.task.replace(/\s+$/, "")}\n\n${launchItemsLine(allowedItems(verdictItems.get(e), hsLaunch !== null))}\n`;
        // R26 item 3: a reviewer launched after an open FAIL names the head that FAIL reviewed (its record's head lands in reviewSync)
        if (s.reviewFailOpen) await s.reviewSync;
        const reReview = s.reviewFailOpen ? { sha: [...s.reviews].reverse().find((r) => r.verdict === "fail" && r.head)?.head ?? null } : null;
        for (const r of applyLedgerItems(input, lg, new Set(climbs.filter((c) => c.handoff).map((c) => c.entry)), lf, criticOf(get(s.config.config, "review.critic")), reReview, pickLedger, occasions)) s.trace?.emit(r);
        // The re-review line tells a reviewer to check the revision diff; numbered items of its `items` beyond the failed set get one sentence: check them against the whole change.
        if (reReview) {
          const line = reReviewLine(reReview.sha);
          for (const [e, ids] of givenItems) {
            const extra = wholeChangeSentence(s.failItems, ids);
            if (extra && typeof e.task === "string" && e.task.startsWith(line)) e.task = line + extra + e.task.slice(line.length);
          }
        }
      }
      if (event.toolName === "subagent" && !s.isChild) for (const r of s.brief.apply(input)) s.trace?.emit(r);
      // R41 Ruling: the roots of Pi and npm (and a builder's absolute plan and ledger paths) in every fresh child brief
      if (event.toolName === "subagent" && !s.isChild) for (const r of applyRootsBlock(input, await piRootsOf(s), { plan: s.plan && s.plan.status === "approved" ? s.plan.path : null, ledger: boundLedger(s.markerDir, s.id), ledgerFor: (task, e) => (entryLedger.has(e) ? entryLedger.get(e) ?? null : taskLedger(task, ctx.cwd, boundLedger(s.markerDir, s.id), [s.cwd, ctx.cwd]).path) })) s.trace?.emit(r);
      if (event.toolName === "subagent" && climbs.length > 0) {
        const ledgerFile = boundLedger(s.markerDir, s.id);
        const readLedger = (f: string | null) => { try { return f ? fs.readFileSync(f, "utf8") : null; } catch { return null; } };
        if (climbs.some((c) => c.handoff && !c.handoffFor) && !kind) kind = "strong-relaunch";
        if (kind === "strong-relaunch" && climbs.every((c) => c.skipped)) kind = "revision"; // every climb was capped by the rank policy: no strong launch
        for (const r of s.ladder.apply(climbs, (task, e) => ledgerLines(readLedger(entryLedger.has(e) ? entryLedger.get(e) ?? null : taskLedger(task, ctx.cwd, ledgerFile, [s.cwd, ctx.cwd]).path), task))) s.trace?.emit(r);
        const was = s.ceremony.tier;
        setCeremony(s, onStrongLaunch(s.ceremony, climbs.map((c) => c.reason)));
        if (s.ceremony.tier !== was) s.trace?.emit({ event: "triage_escalated", from: was, to: s.ceremony.tier, reason: "strong" });
      }
      if (event.toolName === "subagent" && revisionTrace) {
        const rose = climbs.some((c) => c.role === "builder" && !c.top && c.from !== c.to);
        const decision = revisionTrace.noStrong ? "no_strong" : revisionTrace.keyword ? "keyword" : rose ? "climb" : "unchanged";
        s.trace?.emit({ event: "revision", role: "builder", tier: s.ceremony.tier, decision, reason: revisionTrace.reason });
      }
      if (event.toolName === "subagent") for (const r of [...reviewerTraces, ...reviewerClimbs.filter((c) => !climbReplaced.has(c.entry)).map((c) => c.trace)]) s.trace?.emit(r);
      if (shadow.kind === "launch") {
        s.panels.launched(shadow.pending.id, shadow.base);
        s.trace?.emit(shadow.trace);
      }
      // The live rung of every launched role (ladder.ts LadderState.live): single, tasks, chain and parallel.
      if (event.toolName === "subagent" && ladderRoles) {
        const liveReviewer = s.ladder.live.get("reviewer");
        s.ladder.noteLaunched(input);
        if (hsEntries.size > 0) liveReviewer === undefined ? s.ladder.live.delete("reviewer") : s.ladder.live.set("reviewer", liveReviewer); // the high-stakes model is no live rung of the reviewer
        for (const p of sizedPlans) for (const t of p.probe) s.ladder.probeRisks.add(t);
      }
      let limits: LadderLimits | undefined;
      const single = event.toolName === "subagent" && !s.isChild ? singleLaunchRole(input) : null;
      if (single && ladderRoles) {
        const bottom = onBottomRung(ladderRoles, single, input.model);
        const p = s.configProvider ?? ctx.model?.provider;
        s.ladder.onLaunch(event.toolCallId, single, bottom);
        const cap = contextCap(s.config.config, single);
        limits = { bottom, maxTurns: childMaxTurns(s.config.config, p, single), ...(cap > 0 ? { contextCap: cap } : {}), ...(bottom ? { strongAbove: strongAbove(s.config.config, p, single) } : {}) };
      }
      if (event.toolName === "subagent" && !s.isChild && hsModel(s)) {
        // High stakes: a builder's repository is seen (its first HEAD is the base fallback); a risk tag of the builder entries (read with the ladder or sizing off too) and a heavy task fire the review;
        // the findings of an uncleared FAIL go once into the next normal review task of that checkout,
        // as the last change to the task text, so no parser of the launch path reads them; the cited items are taken before.
        if (launchRoles(s, input).includes("builder")) {
          for (const d of builderDirs(ctx, input)) await hsSee(s, d);
          const tags = [...(sized?.entries ?? [])].filter(([e]) => e.agent === "builder").flatMap(([, d]) => d.risk ?? []).filter((t) => HS_RISKS.includes(t));
          hsFire(s, [...tags, ...(s.ceremony.tier === "heavy" ? ["heavy"] : [])]);
        }
        if (actionOf(input) === null) for (const [e, o] of occasions) {
          if ((o !== "item" && o !== "pre-pr") || typeof e.agent !== "string" || !REVIEW_ROLES.includes(e.agent) || typeof e.task !== "string") continue;
          const found = s.hs.findingsFor();
          if (!found) continue;
          if (!hsCited.has(event.toolCallId)) capSet(hsCited, event.toolCallId, citedItems(subagentTaskText(input)));
          e.task = findingsBlock(found) + e.task;
          s.hs.markHanded(event.toolCallId);
          persistCeremonyState(s);
        }
      }
      if (event.toolName === "subagent" && !s.isChild && hsLaunch) {
        // the launch passed every check: it counts as running; the foreman's own request is a reason too (foreman)
        s.hs.beginKeyed(event.toolCallId, hsLaunch.root, hsLaunch.gateKey);
        hsFire(s, ["foreman"]);
        persistCeremonyState(s);
      }
      if (event.toolName === "subagent") {
        const b = recordLaunchUsage(s, ctx, input, event.toolCallId, kind, limits, launchMcp, { ...launchFlags, ...(hsLaunch ? { highStakes: true } : {}), verdictItems: verdictItems.get(input) ?? (launchEntries(input).length === 1 ? verdictItems.get(launchEntries(input)[0]) : undefined) });
        if (b?.out && !s.isChild) s.launchNotices.set(event.toolCallId, [...(s.launchNotices.get(event.toolCallId) ?? []), `pi-foreman: the child's kept output folder is ${b.out} ($FOREMAN_OUT in its shell; it survives the run, swept after 7 days); read its logs there.`]);
        if (!s.isChild) s.childRuns.onLaunchCall(event.toolCallId, { launchId: b?.launchId ?? null, role: single ?? "", rung: single ? rungOf(ladderRoles, single, limits?.bottom === true) : null, model: rowModelOf(input, b?.model ?? null, actionOf(input) === "resume" ? s.launches.get(parkFor(s).launchFor(resumeTarget(input)) ?? "")?.model ?? null : null) });
      }
      if (event.toolName === "subagent" && !s.isChild && !isManagementCall(input)) {
        s.pendingLaunches.add(event.toolCallId);
        if (launchRoles(s, input).includes("builder")) s.work.builders++;
      }
      return undefined;
    } catch (err) {
      return { block: true, reason: `pi-foreman: adapter error before ${event.toolName} (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
    }
    })();
    // a blocked call gets no tool_result, so it is not in flight
    if (res && ms) {
      ms.mutating.delete(event.toolCallId);
      ms.commandCalls.delete(event.toolCallId);
      ms.questionCalls.delete(event.toolCallId);
      ms.runningCalls.delete(event.toolCallId);
      releaseQuestion(event.toolCallId);
    }
    // Only a call that will really run holds the ledger (no await after this point); released at tool_execution_end or session shutdown.
    if (!res && wantHold) {
      ledgerHolds.set(event.toolCallId, wantHold);
      wantHold.gate.hold(wantHold.key);
    }
    // R30 item 8: traced only once the guards let the child's bash call through
    if (!res && bashTimeout && ms) ms.trace?.emit({ event: "bash_timeout", action: bashTimeout.action, requested: bashTimeout.requested });
    // The launching session reads the open command to tell a test run from an unknown command (opencommand.ts).
    if (!res && ms?.isChild && event.toolName === "bash" && process.env[SCRATCH_ENV]) {
      const command = (event.input as { command?: unknown }).command;
      if (typeof command === "string") writeOpenCommand(process.env[SCRATCH_ENV]!, { toolCallId: event.toolCallId, command, startedAt: Date.now() });
    }
    return res;
  });

  pi.on("message_end", async (event, ctx) => {
    const m = event.message as { role?: string; customType?: string; provider?: string; model?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
    if (m.role === "custom") {
      const s = sessionFor(ctx);
      // pi-subagents 0.89: the wake is a custom run with no `input`, so a notice appended with triggerTurn:false (held after an Esc, reserved, compaction) is caught up here: it is still the trailing entry before this message is saved
      if (s && !s.isChild) for (const unseen of s.customSeen.unseenTrailing(ctx.sessionManager.getBranch?.() ?? [])) onCustomMessage(s, unseen);
      if (s) onCustomMessage(s, event.message, true);
      if (s && !s.isChild) s.customSeen.mark(event.message);
      // R12 item 9: a needs-attention notice for a run that ended is no longer displayed
      const hidden = s && !s.isChild ? hideStaleNotice(s.attention, event.message) : null;
      if (hidden) return { message: hidden };
      // D18: the open-tool signal shows once per run and tool call; a repeat is hidden (the context filter drops it too)
      const ev = s && !s.isChild ? noticeEvent(event.message) : null;
      if (s && ev && isRepeatOpenNotice(s.attention, ev)) {
        s.trace?.emit({ event: "notify_deduped", reason: "tool_open_repeat", runId: ev.runId });
        return { message: { ...(event.message as object), display: false } as typeof event.message };
      }
      // Open-command notices: a known long command (test runner) is hidden; a child without a command controller loses the `command.*` lines.
      if (s && ev && ev.reason === "tool_open_threshold" && typeof ev.runId === "string") {
        const runId = ev.runId;
        const roles = s.launchedRoles.get(runId) ?? [];
        const hasCommandController = roles.length > 0 && roles.every((r) => roleToolsFrom(s.config.roles, get(s.config.config, "roles"), r)?.includes("subagent_command") === true);
        const dir = s.scratch.dirOfRun(runId);
        const open = ev.currentTool === "bash" && typeof ev.toolCallId === "string" && dir ? readOpenCommand(dir) : null;
        const cfg = get(s.config.config, "ceremony.longCommands");
        const patterns = Array.isArray(cfg) ? cfg.filter((x): x is string => typeof x === "string") : DEFAULT_LONG_COMMANDS;
        const pattern = open && open.toolCallId === ev.toolCallId ? isLongCommand(open.command, patterns) : null;
        const trimmed = trimNoticeMessage(event.message, { hasCommandController });
        if (pattern && open) {
          s.attention.suppress(runId, String(ev.toolCallId));
          s.trace?.emit({ event: "attention_suppressed", reason: "long_command", rule: pattern, ms: Date.now() - open.startedAt, runId });
          return { message: { ...((trimmed ?? event.message) as object), display: false } as typeof event.message };
        }
        if (trimmed) return { message: trimmed };
      }
    }
    if (m.role !== "assistant") return undefined;
    const s = sessionFor(ctx);
    if (s && !s.isChild) s.customSeen.settle();
    const content = (event.message as { content?: unknown }).content;
    // Knob 4: the message used the codemode tool (one script, possibly many nested calls).
    const codemode = Array.isArray(content) && content.some((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "toolCall" && (c as { name?: unknown }).name === "codemode");
    s?.trace?.emit({ event: "llm", model: m.provider && m.model ? `${m.provider}/${m.model}` : null, tokensIn: m.usage?.input, tokensOut: m.usage?.output, cacheRead: m.usage?.cacheRead, cacheWrite: m.usage?.cacheWrite, cost: m.usage?.cost?.total, codemode: codemode || undefined });
    if (!s) return undefined;
    if (!s.isChild) s.lastAssistantAt = Date.now();
    const stopReason = (event.message as { stopReason?: unknown }).stopReason;
    // an errored or aborted request keeps the last touch, budget and capture: a still-warm cache keeps warming
    if (stopReason === "error" || stopReason === "aborted") s.selfWarm.requestFailed();
    else s.selfWarm.noteRequest((Number(m.usage?.input) || 0) + (Number(m.usage?.cacheRead) || 0) + (Number(m.usage?.cacheWrite) || 0));
    if (!s.isChild) {
      s.launchBatch.onAssistant(content, isLaunchArgs, (a) => !explorerOnly(a));
      if (Array.isArray(content)) {
        for (const c of content as { type?: unknown; name?: unknown; id?: unknown; arguments?: { command?: unknown } }[]) {
          if (c && c.type === "toolCall" && c.name === "bash" && typeof c.id === "string" && mentionsLedger(c.arguments?.command)) s.ledgerBash.add(c.id);
        }
      }
      if (codemode) s.turn.codemode = true;
    }
    const steer = s.isChild ? s.childLadder.onUsage(m.usage) : null;
    if (steer) {
      if (steer.trigger === "turns") {
        s.trace?.emit({ event: "child_turn_cap", role: s.usage.line.role, turns: steer.count, rung: steer.rung });
        s.trace?.emit({ event: "child_turn_limit", role: s.usage.line.role, turns: steer.count, limit: steer.limit ?? null });
      }
      else s.trace?.emit({ event: "rung_up_steer", role: s.usage.line.role, count: steer.count, baseline: steer.baseline ?? null, rung: steer.rung, reason: steer.cap !== undefined ? "context_cap" : "context" });
      pi.sendUserMessage(steer.text, { deliverAs: "steer" });
    }
    const usageRecord = usageLine(s.usage.line, event.message);
    if (!appendUsage(s.usage.file, pricedLine(usageRecord, loadPrices(PKG_ROOT), lookupRate(ctx.modelRegistry as never, usageRecord.provider, usageRecord.model)))) notifyOnce(s, ctx, "usage", `pi-foreman: could not append to the usage log ${s.usage.file}; /foreman cost will be incomplete.`);
    if (!s.isChild) {
      s.turn.cacheRead += Number(m.usage?.cacheRead) || 0;
      s.turn.cacheWrite += Number(m.usage?.cacheWrite) || 0;
    }
    radarTouch(s, ctx);
    usageFooter.update(s.id, ctx, event.message, { enabled: get(s.config.config, "footer.usage"), isChild: s.isChild, runsCost: s.isChild ? undefined : summedCost(s).runs, perms: gateRuntimes.get(s.id)?.store.resolve().mode ?? null });
    // R12 item 4: after repeatRefusalStop every assistant message of the run carries the stop as its error; pi-subagents reports the last
    // assistant error as the run's error (the path a usage-policy block takes), so the parent's runEndOf sees REPEAT_REFUSAL_ERROR.
    const stoppedMsg = s.isChild ? repeatStopped.get(s.id) : undefined;
    if (stoppedMsg) return { message: { ...event.message, errorMessage: stoppedMsg } as typeof event.message };
    return undefined;
  });

  /** A run of this session still going: not ended, and launched here (activeRuns) or a launch still in flight (pendingLaunches). */
  function isLiveRun(s: Session | undefined, runId: string): boolean {
    return !!s && !s.attention.endedRuns.has(runId) && (s.activeRuns.has(runId) || s.pendingLaunches.size > 0);
  }

  /** An inbound intercom message: a question of one of this session's open child sessions (its first line starts with `Question`) is recorded, never its text. */
  function noteQuestion(s: Session, details: unknown): void {
    s.carry.seen(details);
    const from = senderOf(details);
    if (!from || !isQuestion(details) || (details as { message?: { crossMachine?: unknown } }).message?.crossMachine) return;
    const e = openChildren(s.agentDir, openerIntercomId(process.env, s.agentDir, s.id)).find((x) => x.child === from.id);
    if (e) s.carry.note(e.child, cleanLabel(e.label), Date.now());
  }

  /** A delivered intercom `send`: to this session's parent it lets the turn end without the finish checks (cleared by the next inbound message, wake or typed input); to an open child it answers that child's recorded question. */
  function onSendDelivered(s: Session, to: string): void {
    if (parentIdsOf(childDirsOf(s)).some((id) => addresses(to, id, s.carry.namesOf(id)))) {
      s.waitingForParent = true;
      s.trace?.emit({ event: "waiting_for_parent", decision: "set", toolFamily: "intercom" });
    }
    s.carry.answered(to);
  }

  /** A custom message the foreman received: at message_end, or appended while idle and found at the next input (idlecustom.ts). */
  function onCustomMessage(s: Session, message: unknown, fresh = false): void {
    const m = message as { customType?: string; details?: unknown; content?: unknown };
    const live = (runId: string): boolean => isLiveRun(s, runId);
    const stale = s.supervisor.staleRequest(message, live);
    if (stale) s.trace?.emit({ event: "supervisor_request", role: stale.role, decision: "stale" });
    const again = s.supervisor.wasReplied(message);
    const opened = s.supervisor.onMessage(message, live);
    if (opened) s.trace?.emit({ event: "supervisor_request", role: opened.role, decision: "open" });
    if (opened && again) s.trace?.emit({ event: "supervisor_reply", role: opened.role, outcome: "reopened" });
    if (s.isChild) return;
    const cause = causeOfCustom(m.customType);
    // the starting intercom message of a close turn arrives after close claimed the run: the cause stays "close"
    if (cause && !(cause === "intercom" && s.turn.cause === "close")) s.turn.cause = cause;
    if (cause === "wake") s.turn.wakeKinds = [...new Set((m.details as { kinds?: unknown[] } | undefined)?.kinds ?? [])].map(String).join(",");
    // An inbound intercom message or a foreman_wait wake is the parent answering: the finish gate is active again.
    if (m.customType === INTERCOM_MESSAGE_TYPE || m.customType === WAKE_MESSAGE_TYPE) (s.waitingForParent = false), s.handoffWaits.clear();
    if (m.customType === INTERCOM_MESSAGE_TYPE || m.customType === WAKE_MESSAGE_TYPE) evalOwnAsk(s);
    if (m.customType === INTERCOM_MESSAGE_TYPE) s.turn.intercomFrom = intercomSender(m.details);
    // D27: a message of the parent recorded at spawn is a prompt like the owner's: it opens a new pause window. Only the first handling (message_end) counts, never a catch-up of a message handled before; no text is read.
    if (fresh && m.customType === INTERCOM_MESSAGE_TYPE) {
      const parent = parentIntercomId(process.env);
      const sender = senderOf(m.details)?.id;
      const cross = (m.details as { message?: { crossMachine?: unknown } } | undefined)?.message?.crossMachine;
      if (parent && sender === parent && !cross) (s.workAtPrompt = { ...s.work }), savePause(s);
    }
    if (m.customType === INTERCOM_MESSAGE_TYPE) noteQuestion(s, m.details);
    if (m.customType === NOTIFY_TYPE) onCompletionNotice(s, m.content);
  }

  // Turn cause (D9, measurement only): the last trigger before or during a foreman run.
  pi.on("input", async (event, ctx) => {
    const s = sessionFor(ctx);
    // pi-subagents 0.76.1+: notices and supervisor requests appended while idle carry no message_end (ledger 11).
    let idleCause: TurnCause | null = null;
    if (s && !s.isChild) {
      const unseen = s.customSeen.unseenTrailing(ctx.sessionManager.getBranch?.() ?? []);
      for (const msg of unseen) {
        onCustomMessage(s, msg);
        idleCause = causeOfCustom(msg.customType) ?? idleCause;
      }
      // R26 item 2: a wake that carries only needs-attention notices for runs already ended starts no turn
      // a repeat of an open-tool signal (same run and tool call, delivered again or on a second channel) is stale too
      const repeated = new Set<string>();
      const stale = isSubagentWake(event.source, event.text) ? staleNoticeRunIds(unseen, s.attention.endedRuns, s.attention.suppressed, (ev) => (isRepeatOpenNotice(s.attention, ev) ? (repeated.add(String(ev.runId)), true) : false)) : null;
      if (stale) {
        for (const runId of stale) s.trace?.emit({ event: "notify_deduped", reason: repeated.has(runId) ? "tool_open_repeat" : "run_ended", runId });
        return { action: "handled" as const };
      }
    }
    if (s && !s.isChild) s.turn.cause = isSubagentWake(event.source, event.text) ? idleCause ?? "child" : causeOfInput(event.source, event.text);
    // Legacy Pi < 1.2.0: the wake line; the message is the newest intercom entry of the branch.
    const wake = s && !s.isChild ? intercomInbound({ hook: "input", source: event.source, text: event.text, branch: ctx.sessionManager.getBranch?.() ?? [] }) : null;
    if (s && wake) s.turn.intercomFrom = intercomSender(wake.details);
    // D3: the owner is back in the loop: the round state and the loop stop start again.
    if (s && !s.isChild && isOwnerPrompt(event.source, event.text)) {
      s.round = initialRounds();
      s.loopStop = null;
      s.reviewFailOpen = false;
      s.trace?.emit({ event: "chain_clear", kind: event.source });
    }
    // The refusal count belongs to the unchanged state, not to the prompt (D28); the prompt only opens a new pause window (D27).
    if (s && !s.isChild && (event.source === "interactive" || event.source === "rpc")) (s.workAtPrompt = { ...s.work }), savePause(s);
    if (s && !s.isChild && (event.source === "interactive" || event.source === "rpc")) (s.waitingForParent = false), s.handoffWaits.clear();
    if (s && !s.isChild && (event.source === "interactive" || event.source === "rpc")) ownAskFor(s).typed();
    if (s && !s.isChild && (event.source === "interactive" || event.source === "rpc")) persistRounds(s);
    if (s && !s.isChild && (event.source === "interactive" || event.source === "rpc")) s.overrideDeclined = false; // a declined override may be asked again after an owner prompt
    if (s && !s.isChild && (event.source === "interactive" || event.source === "rpc")) reviewFacts.reset(); // a new piece of work: the next builder launch records a new diff base (diffscan.ts ReviewFacts)
    if (s && !s.isChild && (event.source === "interactive" || event.source === "rpc")) {
      const was = s.budget.phase;
      const n = s.budget.resetAll();
      // traced only when it discards a count that had reached warn
      if (n >= readLimits(get(s.config.config, "ceremony.foremanReads"))[was].warn) s.trace?.emit({ event: "read_budget", phase: "before", count: n, action: "reset_user" });
    }
    return { action: "continue" as const };
  });

  // Intercom turns get a notice only; every gate applies unchanged (ledger item 4).
  pi.on("agent_start", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (s) (s.inRun = true), (s.reminderQueued = false); // a queued review reminder rides with this turn
    if (!s || s.isChild || s.turn.cause !== "intercom" || !s.turn.intercomFrom) return;
    if (ctx.mode === "tui" || ctx.mode === "rpc") ctx.ui.notify(`pi-foreman: this turn was started by an intercom message from ${s.turn.intercomFrom}`, "info");
  });

  pi.on("agent_end", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild) return;
    s.inRun = false;
    s.trace?.emit({ event: "turn", cause: s.turn.cause, cacheRead: s.turn.cacheRead, cacheWrite: s.turn.cacheWrite, wakeKinds: s.turn.cause === "wake" ? s.turn.wakeKinds : undefined, pollBash: s.pollBash || undefined, codemode: s.turn.codemode || undefined, chars: (gateOwnerMessages.get(s.id)?.[0] ?? "").length }); // chars: latest owner message length (a wake run must not reset it)
    s.pollBash = 0;
    s.turnSeq += 1;
    s.turn = { cause: "other", cacheRead: 0, cacheWrite: 0 };
  });

  /** D3: a detached child's completion notice; a finished review of built work may open a round. */
  function onCompletionNotice(s: Session, content: unknown): void {
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n") : "";
    recordChild(s, noticeLocations(text, knownRun(s)));
    const reviews = completedAgents(text).filter((a) => REVIEW_ROLES.includes(a));
    if (reviews.length === 0) return;
    // panel shadows only (panel.ts): no marks, rounds or review_done
    // only review runs this session launched (launch bookkeeping, or the route entry after a reload) are read; the notice comes after the run end (pi-subagents order), which has already cached no record or set the route's `failed` flag for a run that did not complete (T7), so such a run is never read here
    const ids = (noticeRuns(text)?.ids ?? []).filter((id) => (s.launchedRoles.get(id) ?? []).some((r) => REVIEW_ROLES.includes(r)) || s.ledgerByRun.get(id)?.review);
    if (ids.length > 0 && ids.every((id) => shadowRun(s.reviewRuns.byRun.get(id)))) return;
    // a high-stakes run (its id is kept in the state, or its launch said so) marks no item and opens no round
    if (ids.length > 0 && ids.every((id) => s.hs.ownerOf(id) !== null || s.reviewRuns.byRun.get(id)?.entries.some((e) => e.occasion === "high-stakes"))) return;
    // the record of each run (read once, or the renamed file after a reload) and its occasion from the route entry, else the launch bookkeeping
    const verdicts: (Verdict | null)[] = [];
    for (const id of ids) {
      const record = s.ledgerByRun.get(id)?.review?.failed ? null : verdictRecordOf(s, id);
      if (!record) continue;
      verdicts.push(record && record.verdict !== "incomplete" ? record.verdict : null);
      const launch = s.reviewRuns.byRun.get(id);
      const route = s.ledgerByRun.get(id)?.review;
      const occasion = route?.occasion ?? launch?.entries.find((e) => REVIEW_ROLES.includes(e.role))?.occasion ?? "item";
      const shadow = route ? route.shadow : shadowRun(launch);
      // a second opinion, plan review or panel never marks items (occasion.ts); only a PASS of a counting occasion marks, once per run
      if (record?.verdict === "pass" && !shadow && !launch?.panel && countsForItems(occasion)) markByReview(s, id, [{ items: record.items }], 0);
    }
    if (verdicts.length === 0) return; // no review run of this notice has a record: the state of the run end stands
    const verdict: Verdict | null = verdicts.includes("fail") ? "fail" : verdicts.every((v) => v === "pass") ? "pass" : null;
    s.round = onReviewDone(s.round, verdict);
    persistRounds(s);
  }

  /** Retro-harvest 1/6 at a run end: a reviewer PASS marks its items; a verdict sets or clears the PASS snapshot; a touch-up builder is checked. */
  function onRunEndReview(s: Session, runId: string, results: readonly ReviewResult[], verdict: boolean, roots: readonly string[] | null, data: unknown): void {
    const kids = data && typeof data === "object" ? runEndChildren(data as Record<string, unknown>) : [];
    const pass = results.filter((r) => r.counts && r.role === "reviewer" && r.verdict === "pass").map((r) => {
      const task = (kids[r.index] as { task?: unknown } | undefined)?.task;
      return { index: r.index, items: r.items, ...(typeof task === "string" ? { task } : {}) };
    });
    if (pass.length > 0) markByReview(s, runId, pass, kids.length);
    if (verdict) {
      // the run's checkouts (unknown: the session-wide entry); a verdict that left no PASS drops the marks of the entries it hit (an unknown FAIL hit all)
      const keys = roots ?? [SESSION_WIDE];
      const passedKeys = keys.filter((k) => s.reviewGates[k]?.last === "pass");
      for (const k of roots === null && passedKeys.length === 0 ? Object.keys(s.passMarks) : keys) {
        delete s.passSnaps[k];
        delete s.passMarks[k];
      }
      const at = Date.now();
      const ledger = ledgerSignal(s);
      for (const k of passedKeys) {
        const cwd = k === SESSION_WIDE ? (results.find((r) => r.counts)?.cwd ?? s.cwd) : k;
        if (k !== SESSION_WIDE) s.builderRunsByRoot[k] ??= 0;
        const builderRuns = builderRunsOf(s, k);
        const snapNow = Promise.all([worktreeTree(cwd), headOf(cwd)]); // taken at the run end, in step with the ledger marks queued above, not after them
        s.reviewSync = s.reviewSync.then(async () => {
          const [tree, head] = await snapNow;
          if (s.reviewGates[k]?.last !== "pass") return;
          if (tree) s.passSnaps[k] = { cwd, tree };
          else delete s.passSnaps[k];
          s.passMarks[k] = { cwd, at, head, tree, ledger, builderRuns };
          persistCeremonyState(s);
        });
      }
    }
    const touchUp = s.touchUps.get(runId);
    s.touchUps.delete(runId);
    if (touchUp !== undefined) s.reviewSync = s.reviewSync.then(async () => {
      const g = s.reviewGates[touchUp];
      if (g?.last === "pass" && g.revised && (await commentOnlyNow(s, touchUp))) {
        s.reviewGates = { ...s.reviewGates, [touchUp]: { ...g, revised: false } };
        persistCeremonyState(s);
      }
    });
  }

  /** The ledgers a run's hints go to, each with the items of the entries that named it (the bound ledger for an entry that names none; `whole` when no entry named one) (D31). */
  function hintTargets(s: Session, runId: string, whole: string[]): Map<string, string[]> {
    const bound = boundLedger(s.markerDir, s.id);
    const route = s.ledgerByRun.get(runId);
    const out = new Map<string, string[]>();
    if (!route || route.paths.every((p) => p === null)) {
      if (bound) out.set(bound, whole);
      return out;
    }
    route.paths.forEach((p, i) => {
      const f = p ?? bound;
      if (f) out.set(f, [...new Set([...(out.get(f) ?? []), ...(route.cited[i] ?? [])])]);
    });
    return out;
  }

  /**
   * Mark the `N. PASS` items of a reviewer PASS in the ledger the reviewer's task named, else the bound ledger, once per review run (reviewmarks.ts).
   * `total` is the result count of the event (0 for a notice, which has no result index). A mark never lands in a ledger the entry did not name:
   * when the result cannot be tied to its entry (misaligned counts, or a task that names a ledger that cannot be re-derived), nothing is marked.
   * A run with no record at all (an older session) uses the result's own task, else the bound ledger.
   */
  function markByReview(s: Session, runId: string, parts: { index?: number; items: readonly VerdictItem[]; task?: string }[], total: number): void {
    if (s.reviewMarked.has(runId) || s.hs.ownerOf(runId) !== null) return; // a high-stakes run marks nothing
    s.reviewMarked.add(runId);
    const route = s.ledgerByRun.get(runId);
    const bound = boundLedger(s.markerDir, s.id);
    const launch = s.reviewRuns.byRun.get(runId);
    const fileOf = (p: { index?: number; task?: string }): string | null => {
      if (route) {
        const per = route.paths;
        if (per.every((x) => x === null)) return bound;
        if (p.index !== undefined) return p.index >= 0 && per.length === total ? per[p.index] ?? bound : null;
        // a notice has no result index: the one ledger all review entries resolve to
        const reviewers = launch && launch.entries.length === per.length ? per.filter((_, i) => REVIEW_ROLES.includes(launch.entries[i].role)) : per;
        const files = new Set(reviewers.map((x) => x ?? bound));
        return files.size === 1 ? [...files][0] : null;
      }
      // no launch record (a reload or resume): a task that names no ledger (or no task text) uses the bound one;
      // a task that names one re-derives it, and marks nothing when that fails
      if (!p.task) return bound;
      const t = taskLedger(p.task, s.cwd, bound, [s.cwd]);
      return t.notice ? null : t.path;
    };
    const byFile = new Map<string, VerdictItem[]>();
    for (const p of parts) {
      const file = fileOf(p);
      if (file) byFile.set(file, [...(byFile.get(file) ?? []), ...p.items]);
      else s.trace?.emit({ event: "ledger_mark_skipped", run: runId.slice(0, 8), reason: "ledger of the reviewed entry unknown" });
    }
    // the ledgers are marked side by side (each file has its own gate): a slow host (Windows process starts) must not add up one mark per ledger
    // and in their own chain, not behind the PASS snapshots (git) of the earlier runs; reviewSync still waits for them
    if (byFile.size > 0) {
      s.markSync = s.markSync.then(() => Promise.all([...byFile].map(async ([file, items]) => {
        const r = await markPassItems(items, file, async (n) => (await runLedger(s, n === "V" ? ["mark", n, MARK_NOTE, "--verifier"] : ["mark", n, MARK_NOTE], file)).ok, async (n, t) => (await runLedger(s, ["note", n, `reviewer: ${t}`], file)).ok);
        if (r) s.trace?.emit({ event: "ledger_mark_by_review", items: r.items.join(","), skipped: r.skipped.join(","), noted: r.noted.join(",") });
      }))).then(() => undefined);
      const marked = s.markSync;
      s.reviewSync = s.reviewSync.then(() => marked);
    }
  }

  /** The working tree differs from the PASS snapshot only in comments or docs (commentonly.ts); traced revision_comment_only. */
  async function commentOnlyNow(s: Session, root: string): Promise<boolean> {
    const snap = s.passSnaps[root];
    const files = snap ? await commentOnlySince(snap) : null;
    if (files) s.trace?.emit({ event: "revision_comment_only", files: files.length });
    return files !== null;
  }

  function editModeOfSession(s: Session): { mode: EditMode; scratchDir: string } {
    // The plan phase is readonly in every edit mode: only .workflow/ is writable.
    return { mode: s.planPhase && !s.isChild ? "readonly" : editModeOf(get(s.config.config, "ceremony.foremanEdits")), scratchDir: scratchDirOf(get(s.config.config, "ceremony.scratchDir")) };
  }

  function planOpts(s: Session, ctx: ExtensionContext) {
    return { cwd: ctx.cwd, home: os.homedir(), platform, scratchDir: editModeOfSession(s).scratchDir };
  }

  /**
   * A plan-only session may close V on plan reviews: no builder launched (counted at launch, and the saved step count), no project edit counted, at least one
   * plan lineage, and every lineage's latest verdict a PASS on its plan's version as it is on disk now.
   */
  function planOnlyPass(s: Session, ctx: ExtensionContext): boolean {
    if (s.work.builders !== 0 || s.steps.builder !== 0 || s.work.edits !== 0) return false;
    const lineages = s.planReviews.all();
    if (lineages.length === 0) return false;
    return lineages.every((l) => {
      if (l.latest.verdict !== "pass") return false;
      const r = readPlan(l.path, planOpts(s, ctx));
      return "plan" in r && r.plan.hash === l.latest.hash;
    });
  }

  /** Roles a `subagent` call runs: top-level, tasks, chain (and parallel steps), or the role of a resumed run. */
  function launchRoles(s: Session, input: Record<string, unknown>): string[] {
    return [...subagentAgents(input), ...roundSteps(input, s.runs).flat()];
  }

  /** A plan phase a parent's launch started, at a tier below heavy: the session's own plan-review PASS ends it, and foreman_checkpoint is refused. */
  function parentPhaseByReview(s: Session): boolean {
    return s.planPhase && s.planPhaseOrigin === "parent" && s.ceremony.tier !== "heavy";
  }

  /** Heavy tier: a builder launch needs the owner's approval of the current plan (checkpoint.ts). A refusal records nothing. */
  function builderPlanBlock(s: Session, ctx: ExtensionContext, input: Record<string, unknown>): string | undefined {
    const tier = s.ceremony.tier;
    if (s.planPhase) {
      const roles = launchRoles(s, input);
      if (roles.includes("builder")) {
        s.trace?.emit({ event: "launch_refused", reason: "plan_phase", tier, ...launchDeny(input) });
        return launchRefusalText("plan_phase", s.plan, planOpts(s, ctx).scratchDir, parentPhaseByReview(s));
      }
    }
    if (tier !== "heavy" || !launchRoles(s, input).includes("builder")) return undefined;
    const o = planOpts(s, ctx);
    const now = s.plan ? currentPlanHash(s.plan, o) : null;
    const reason = builderLaunchRefusal(s.plan, tier, now);
    if (!reason) return undefined;
    s.trace?.emit({ event: "launch_refused", reason, tier, ...launchDeny(input) });
    // an approved plan that cannot be read now (a refused rulings write, a lost marker): the readPlan error says why, not only "changed"
    const unread = reason === "plan_changed" && s.plan && now === null ? readPlan(s.plan.path, o) : null;
    return launchRefusalText(reason, s.plan, o.scratchDir) + (unread && "error" in unread ? ` The plan cannot be read: ${unread.error}` : "");
  }

  /**
   * ceremony.foremanEdits: a block, undefined (allowed; the triage gate and the bound do not apply),
   * or null (bounded mode or a child: the triage gate decides as before).
   */
  async function editModeGate(ctx: ExtensionContext, toolName: string, input: Record<string, unknown>): Promise<{ block: true; reason: string } | undefined | null> {
    try {
      const s = await ensureSession(ctx);
      if (s.isChild) return null; // children: the triage gate as before
      const { mode, scratchDir } = editModeOfSession(s);
      const reason = editModeBlock(toolName, input, mode, scratchDir, { cwd: ctx.cwd, home: os.homedir(), platform });
      if (reason === null) return null;
      if (reason === "") return undefined;
      return { block: true, reason: reason + onEditRefused(s, mode, toolName) };
    } catch (err) {
      return { block: true, reason: `pi-foreman: adapter error in the edit-mode gate (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
    }
  }

  /**
   * Item 13: a change the edit mode refused needs a builder. Trace it; outside bounded mode a refused edit tool call marks the
   * ceremony and raises a trivial tier to standard at once (an untriaged session's later trivial
   * triage is recorded as standard). A refused shell write (kind `shell`) only adds the plan-phase text: it keeps the tier.
   * The text added to the refusal.
   */
  function onEditRefused(s: Session, mode: EditMode, kind: string): string {
    s.trace?.emit({ event: "foreman_edit_refused", mode, kind });
    if (mode === "bounded") return "";
    if (parentPhaseByReview(s)) return " The plan phase is on: write the plan under .workflow/ and use explorers; code changes wait until your plan review passes (a [plan-review] PASS on the current version ends the phase) or /foreman plan off.";
    if (s.planPhase) return " The plan phase is on: write the plan under .workflow/ and use explorers; code changes wait for a checkpoint approval or /foreman plan off.";
    if (kind === "shell") return "";
    s.ceremony = { ...s.ceremony, needsChange: true };
    if (s.ceremony.tier !== "trivial") return isTriaged(s.ceremony) ? "" : ` Record the tier with ${TRIAGE_TOOL}: this task needs a builder, so trivial counts as standard.`;
    setCeremony(s, escalate(s.ceremony, "standard", "auto", "edit mode refused a change"));
    s.trace?.emit({ event: "triage_escalated", from: "trivial", to: s.ceremony.tier, reason: "edit_mode" });
    return " The tier is now standard: write the ledger .workflow/LEDGER-<topic>.md and launch a builder, then a reviewer.";
  }

  /** D10: the foreman's own file changes inside the workspace need a trivial triage. */
  async function triageBlock(ctx: ExtensionContext, toolName: string, input: Record<string, unknown>, toolCallId: string): Promise<{ block: true; reason: string } | undefined> {
    try {
      const s = await ensureSession(ctx);
      if (s.isChild || get(s.config.config, "ceremony.requireTriage") === false) return undefined;
      const reason = triageGateBlock(toolName, input, s.ceremony, { cwd: ctx.cwd, home: os.homedir(), platform });
      if (!reason) return trivialBoundBlock(s, ctx, toolName, input, toolCallId);
      s.trace?.emit({ event: "triage_gate", toolFamily: toolName, tier: s.ceremony.tier, decision: "blocked" });
      return { block: true, reason };
    } catch (err) {
      return { block: true, reason: `pi-foreman: adapter error in the triage gate (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
    }
  }

  /** D1: at tier trivial, a call that would bring the foreman's own changes over ceremony.trivialBound is refused and the tier escalates. */
  function trivialBoundBlock(s: Session, ctx: ExtensionContext, toolName: string, input: Record<string, unknown>, toolCallId: string): { block: true; reason: string } | undefined {
    if (s.ceremony.tier !== "trivial") return undefined;
    const targets = workspaceTargets(toolName, input, ctx.cwd, os.homedir(), platform);
    if (targets.length === 0) return undefined;
    const change = pendingChange(toolName, input, new Set(targets.map((t) => t.abs)), (raw) => resolveToolPath(raw, ctx.cwd, os.homedir()));
    // Calls of the same turn that passed but have no result yet count too.
    const next = addChange([...s.pendingChanges.values()].reduce(addChange, s.tally), change);
    const bound = readBound(get(s.config.config, "ceremony.trivialBound"));
    if (!overBound(next, bound)) {
      s.pendingChanges.set(toolCallId, change);
      return undefined;
    }
    setCeremony(s, escalate(s.ceremony, "standard", "auto", "trivial bound crossed"));
    s.trace?.emit({ event: "triage_escalated", from: "trivial", to: s.ceremony.tier, files: next.files.length, lines: next.lines, newFiles: next.newFiles });
    return { block: true, reason: boundRefusal(toolName, targets[0].raw, next, bound) };
  }

  /** The roots a foreman session owns, for the permission reviewer's prompt (roundsurface.ts sessionOwnedSplit: read-write and read only); none for a child session. */
  const sessionOwnedRoots = (s: Session): { write: string[]; read: string[] } => {
    if (s.isChild) return { write: [], read: [] };
    const rounds = roundWorktrees(path.join(s.agentDir, "pi-foreman", "state"), s.usage.line.foremanSession, platform);
    const sid = (s.usage.line.foremanSession || "").split("").filter((c) => /[A-Za-z0-9_-]/.test(c)).join("");
    return sessionOwnedSplit({ scratch: s.scratch.live(null), rounds, handoffs: ownHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)), npmRoot: s.owned.npmRoot, stateScratch: sid ? path.join(s.agentDir, "pi-foreman", "state", "scratch", sid) : null, asyncRuns: [...s.childFiles, ...asyncRunDirs(s.childFiles, platform), ...bashOutputLogs(s.bashLogs, platform)], hubFlow: hubWorkflowDirs(get(s.config.config, "paths.hubWorkflow"), platform) }, platform);
  };

  /** The owned handoffs root (`<agentDir>/pi-foreman/handoffs`). */
  const handoffsRoot = (s: Session): string | undefined => s.owned.readWrite.find((r) => path.basename(r) === "handoffs");

  /** The own `ask.md` of a session (ownask.ts): open by the one rule sets the parent blocked source, not open releases it. */
  const ownAsks = new Map<string, OwnAsk>();
  function ownAskFor(s: Session): OwnAsk {
    let c = ownAsks.get(s.id);
    if (!c) {
      c = new OwnAsk({ dirs: () => childHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)), block: (label) => blockedShim.ownOn(label, BLOCK_PARENT) });
      ownAsks.set(s.id, c);
    }
    return c;
  }

  /** Evaluate the rule; a version found open for the first time lets the turn end without the finish checks (until the next message, wake or typed input). */
  function evalOwnAsk(s: Session): void {
    if (s.isChild) return;
    if (ownAskFor(s).evaluate().fresh) {
      s.waitingForParent = true;
      s.trace?.emit({ event: "waiting_for_parent", decision: "set", toolFamily: "ask" });
    }
  }

  /** `file` is directly inside one of this session's own handoff dirs. */
  function inOwnHandoff(s: Session, file: string): boolean {
    const real = (p: string): string => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return path.resolve(p);
      }
    };
    const dir = real(path.dirname(file));
    return childHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)).some((d) => real(d) === dir);
  }

  /** steer.md of the own handoff dirs (steer.ts): appended to every wake delivered to this session. */
  const steers = new Map<string, SteerReader>();
  function steerFor(s: Session): SteerReader {
    let r = steers.get(s.id);
    if (!r) steers.set(s.id, (r = new SteerReader(() => childHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)))));
    return r;
  }

  /** Rulings this session wrote itself (ruling.ts SelfRulings): never a parent verdict. */
  const selfRulings = new Map<string, SelfRulings>();
  const selfRulingsFor = (s: Session): SelfRulings => {
    let r = selfRulings.get(s.id);
    if (!r) selfRulings.set(s.id, (r = new SelfRulings()));
    return r;
  };
  /** The handoff dirs where this session is the child: the only ones the ask state and the parent-ruling gate read. */
  const childDirsOf = (s: Session): string[] => childHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id));
  const bashRulingSnaps = new Map<string, Map<string, number>>();
  /** ask_user_question calls whose text read like jargon: the hint is appended to the result (ownertext.ts). */
  const questionHints = new Map<string, string>();
  const MUTATING_TOOLS = new Set(["write", "edit", "bash", "powershell"]);

  /**
   * A parent-written `brief-<x>.md` in this session's handoff dir lifts the loop stop and the read
   * budget (rounds.ts rulingReset, strict: regular file, ctime and mtime newer than the watermark, not self-written; no text parser).
   * Skipped while another write/edit/shell call is in flight. Runs at the top of tool_call, before the budget and cap checks.
   */
  function capsReset(s: Session, callId: string): void {
    if ([...s.mutating].some((id) => id !== callId)) return;
    let dirs = childDirsOf(s);
    const rd = roundStateDir(process.env);
    if (rd && dirs.length > 0) {
      const real = (p: string): string => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
      dirs = dirs.filter((d) => real(d) === real(rd));
    }
    if (dirs.length === 0) return;
    const after = Math.max(s.capsResetAt, sessionStartMs);
    const used = new Set<string>();
    const hits: string[] = [];
    let at = 0;
    const scan = () => rulingReset(dirs, after, used, selfRulingsFor(s), { names: isCapsResetName, strict: true });
    for (let r = scan(); r; r = scan()) {
      used.add(r.id);
      hits.push(path.basename(r.file));
      at = Math.max(at, r.at);
    }
    if (hits.length === 0) return;
    s.loopStop = null;
    s.budget.resetAll();
    s.capsResetAt = Math.ceil(at);
    persistRounds(s);
    s.trace?.emit({ event: "cap_reset", by: "brief", count: hits.length });
  }

  /**
   * The send-back marker (rework.ts): a `rework-<k>` above the handled watermark in the handoff dir where this session is the child sets `sentBack`, counts as a
   * revision, drafts the owned open PRs at once and refreshes the live file. Runs at the top of a tool call and at each PR watch tick (not capsReset, not its watermark).
   * A handled marker left on disk never sets it again; only a `[pre-pr]` PASS clears it. No brief text is read.
   */
  function reworkScan(s: Session): void {
    if (s.isChild) return;
    const dir = ownChildHandoff(s);
    const k = dir ? highestRework(dir) : 0;
    if (k <= s.reworkSeen) return;
    s.reworkSeen = k;
    s.sentBack = true;
    s.sentBackHeads = sentBackMark(s.sentBackHeads, s.reviews);
    reviseGates(s, null, false); // the parent's rework names no checkout: every entry goes stale
    void hsRevised(s, s.cwd);
    persistCeremonyState(s);
    void s.prWatches.reconcileOwned().finally(() => s.live?.flush());
  }

  /** One of this session's own handoff dirs (owned.ts ownHandoffDirs) holds a plan.md or result.md written in the last day (a round is waiting on its parent). */
  function handoffContext(s: Session): boolean {
    for (const dir of ownHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id))) {
      for (const f of ["plan.md", "result.md"]) {
        try {
          if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs <= 86_400_000) return true;
        } catch {
          // absent
        }
      }
    }
    return false;
  }

  /**
   * waiting_for_parent (finish gate): set by a file wait on a path under the handoffs root, or a timer wait while
   * one of this session's own handoff dirs holds plan.md or result.md. A plain timer wait does not set it.
   */
  function markHandoffWait(s: Session, spec: { kind: string; path?: string }, id: string): void {
    if (s.isChild) return;
    const root = handoffsRoot(s);
    const hit = spec.kind === "file" && !!root && typeof spec.path === "string" && underOwned(root, spec.path, platform);
    if (hit || (spec.kind === "timer" && handoffContext(s))) {
      s.waitingForParent = true;
      s.handoffWaits.add(id);
      s.trace?.emit({ event: "waiting_for_parent", decision: "set", toolFamily: spec.kind });
    }
  }

  /** A cancelled wait leaves waiting_for_parent when no other handoff wait and no pending checkpoint remains. */
  function cancelHandoffWait(s: Session, id: string): void {
    if (s.isChild || !s.handoffWaits.delete(id)) return;
    if (s.handoffWaits.size === 0 && s.plan?.status !== "pending" && s.waitingForParent) {
      s.waitingForParent = false;
      s.trace?.emit({ event: "waiting_for_parent", decision: "cleared", toolFamily: "cancel" });
    }
  }

  /** The handoff dir where this session is the child side (its `PI_FOREMAN_HANDOFF_DIR`, else the dir whose `child` file names it), absolute, or undefined. For a session-level child (not a subagent) its child-written names are writable by the shell guard and by the gate (`ownHandoff`). */
  function ownChildHandoff(s: Session): string | undefined {
    const env = (process.env.PI_FOREMAN_HANDOFF_DIR ?? "").trim();
    const dir = env || childHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id))[0];
    return dir && (path.isAbsolute(dir) || path.win32.isAbsolute(dir)) ? dir : undefined;
  }

  /** Plan D3: the foreman's bash/powershell may not write project files, at any tier (subagent children are not checked here; their writes meet the gate's child floor; a session-level child runs it with its handoff dir). */
  async function shellWriteBlock(ctx: ExtensionContext, toolName: "bash" | "powershell", input: Record<string, unknown>): Promise<{ block: true; reason: string } | undefined> {
    try {
      const s = await ensureSession(ctx);
      if (s.isChild) return undefined;
      const env = buildGuardEnv({ base: process.env, coreDir: CORE_DIR, sessionId: s.id, guard: "shell_write_guard", markerDir: s.markerDir });
      const { mode, scratchDir } = editModeOfSession(s);
      const ownHandoff = ownChildHandoff(s);
      const payload = shellWriteGuardPayload(input, payloadCtx(s, ctx), workspaceOf(ctx.cwd).root, toolName, allowedShellDirs(mode, scratchDir, ctx.cwd, platform), s.isChild ? [] : literalOwnedDirs(s.owned.readWrite, s.owned.childScratchRoot), { ...(ownHandoff ? { handoffDir: ownHandoff } : {}) });
      const v = shellWriteVerdict(await runShellWriteGuard({ python: pyPath(s), pkgRoot: PKG_ROOT, payload, env, cwd: ctx.cwd, spawner }), pyPath(s));
      if (v.decision === "allow") return undefined;
      if (v.decision !== "refuse") return { block: true, reason: v.reason };
      // r29: the foreman's branch-only git on a clean tree (a refusal names the precondition that failed)
      const command = typeof input.command === "string" ? input.command : "";
      const move = await branchMove(command, ctx.cwd, !s.isChild);
      if (move?.allow) {
        s.trace?.emit({ event: "shell_write_allow", reason: move.reason ?? "branch_move", cmd: command });
        return undefined;
      }
      const precondition = move && "precondition" in move ? move.precondition : undefined;
      const hint = move ? null : chainHint(command, !s.isChild);
      const reason = precondition ? `${v.reason} branch move refused: ${precondition}.` : hint ? `${v.reason} ${hint}.` : v.reason;
      s.trace?.emit({ event: "shell_write_refused", role: "foreman", kind: v.kind, mode, ...(precondition ? { precondition } : {}) });
      // a refusal caused only by a parent-owned name in the own handoff dir, or only by a target the guard cannot resolve, is not traced and adds no plan-phase text (a shell refusal never changes the tier)
      const more = v.handoffOnly || v.unresolvedOnly ? "" : onEditRefused(s, mode, "shell");
      return { block: true, reason: mode === "bounded" ? reason : `${reason} pi-foreman: ${editModeAdvice(mode, scratchDir)}.${more}` };
    } catch (err) {
      return { block: true, reason: `pi-foreman: adapter error in the shell write guard (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
    }
  }

  /** D8: give a single-child launch its usage binding (role, launch id, kind) through extensionBindings. */
  /** The launch a run of this session belongs to: the live mapping, else the route entry of a review launch (it survives a reload or a session restart). */
  const launchOfRun = (s: Session, runId: string): string | undefined => parkFor(s).launchFor(runId) ?? s.ledgerByRun.get(runId)?.review?.launch;

  /**
   * D3: a resume of a run this session launched keeps the first launch's binding (same ask dir) but gets a new run id. The tool result maps the new run to
   * the launch for every parent (headless and `childAsk: deny` too: the verdict record is found through it). With a pane and `gate.childAsk: parent` the
   * ask dir is made again before the child starts, if the run's end removed it, and watched (`add` skips an ask that has a ruling).
   */
  function resumeAskDir(s: Session, ctx: ExtensionContext, input: Record<string, unknown>, callId: string): void {
    const target = s.isChild ? null : resumeTarget(input);
    const launch = target ? launchOfRun(s, target) : undefined;
    if (!launch) return;
    parkFor(s).resumeCall(callId, launch);
    parkFor(s).noteCall(callId, launch);
    if (get(s.config.config, "gate.childAsk") !== "parent" || !ctx.hasUI) return;
    const askDir = childAskDir(s.agentDir, s.id, launch);
    try {
      fs.mkdirSync(askDir, { recursive: true, mode: 0o700 });
    } catch {
      return;
    }
    parkFor(s).clearEnded(askDir);
    childAskWatchFor(s, ctx).add(askDir);
  }

  /** A resume keeps the first launch's record folder (same binding); it is made again if missing (also after a session restart: the launch comes from the route), and a record the earlier run consumed stays consumed. */
  function resumeVerdictDir(s: Session, input: Record<string, unknown>): void {
    const target = resumeTarget(input);
    const launch = target ? launchOfRun(s, target) : undefined;
    if (!launch || !(s.launches.get(launch)?.verdictDir || s.ledgerByRun.get(target ?? "")?.review)) return;
    try {
      makeRecordDir(recordDir(s.agentDir, s.id, launch));
    } catch {
      // the child's tool refuses without a folder
    }
  }

  function recordLaunchUsage(s: Session, ctx: ExtensionContext, input: Record<string, unknown>, toolCallId: string, kind?: LaunchKind, ladder?: LadderLimits, mcp?: string[], flags?: { reads?: number; install?: boolean; highStakes?: boolean; verdictItems?: ItemId[] }): LaunchBinding | null {
    if (actionOf(input) === "resume") resumeAskDir(s, ctx, input, toolCallId);
    if (actionOf(input) === "resume" && !s.isChild) resumeVerdictDir(s, input);
    const role = singleLaunchRole(input);
    if (!role) return null;
    const model = typeof input.model === "string" && input.model ? input.model : null;
    const b = recordUsageLaunch(s.launches, { foremanSession: s.usage.line.foremanSession, workspace: s.usage.line.workspace, role, model, kind, activeProvider: ctx.model?.provider, ladder });
    if (!s.isChild && actionOf(input) !== "resume") parkFor(s).noteCall(toolCallId, b.launchId);
    launchScratch(s, input, b);
    const ownHandoff = ownChildHandoff(s);
    if (!s.isChild && ownHandoff) b.handoffDir = ownHandoff;
    if (!s.isChild) {
      if (get(s.config.config, "gate.childAsk") !== "parent") b.noAsk = "deny";
      else if (!ctx.hasUI) b.noAsk = "no-pane";
    }
    if (!s.isChild && get(s.config.config, "gate.childAsk") === "parent" && ctx.hasUI) {
      // a parent with its own pane gives the child an ask dir; a headless parent gives none, so its children deny
      const askDir = childAskDir(s.agentDir, s.id, b.launchId);
      try {
        fs.mkdirSync(askDir, { recursive: true, mode: 0o700 });
        b.askDir = askDir;
        childAskWatchFor(s, ctx).add(askDir);
      } catch {
        delete b.askDir;
      }
    }
    if (!s.isChild) {
      const pr = gateRuntimeOf(s).store.resolve();
      b.perms = { mode: pr.mode, ...(pr.modeSource === "session" ? { override: pr.mode } : {}), ...(pr.profile ? { profile: pr.profile } : {}), childDeny: true };
    }
    if (retroEnabled(get(s.config.config, "retro.enabled"), ctx.mode)) b.retro = true; // the child traces for the retro
    if (mcp) b.mcp = mcp;
    if (flags?.reads !== undefined) b.reads = flags.reads;
    if (flags?.install) b.install = true;
    if (flags?.highStakes) b.highStakes = true; // the child's ledger tool marks nothing, item V included
    if (!s.isChild && REVIEW_ROLES.includes(role)) {
      // the record folder of the verdict tool, whatever gate.childAsk or the pane say (verdict.ts)
      const dir = recordDir(s.agentDir, s.id, b.launchId);
      try {
        makeRecordDir(dir);
        b.verdictDir = dir;
        if (!flags?.highStakes) b.items = flags?.verdictItems ?? [];
        else b.items = [];
      } catch {
        s.trace?.emit({ event: "review_record_dir_failed" });
      }
    }
    if (input.worktree === true) b.worktree = true; // ceremony-fixes-2: the child's cwd is an isolation worktree
    bindLaunch(input, b);
    return b;
  }

  // ledger_call for the foreman's shell `ledger` calls. A call blocked by a permission rule never
  // reaches tool_result, so the outcome is read here: allowed false = a permission refusal.
  pi.on("tool_execution_end", async (event, ctx) => {
    const s = sessionFor(ctx);
    releaseLedgerHold(event.toolCallId);
    s?.mutating.delete(event.toolCallId);
    s?.commandCalls.delete(event.toolCallId);
    s?.questionCalls.delete(event.toolCallId);
    s?.runningCalls.delete(event.toolCallId);
    releaseQuestion(event.toolCallId);
    // An owner-approved launch (pressure override) is spent here, whether it started or a later check refused it.
    const spent = s?.overridden.get(event.toolCallId);
    if (s && spent) {
      s.overridden.delete(event.toolCallId);
      s.trace?.emit({ event: "pressure_override", decision: event.isError ? "not_launched" : "launched", agent: typeof spent.agent === "string" ? spent.agent : "", hash: taskHash(spent.task) });
      if (!event.isError) {
        try {
          await waits.dropPressure(ctx, spent);
        } catch { /* best effort: the rest of this handler still runs */ }
      }
    }
    // an answered ask_user_question (at least one answer) is the owner's reply to a [review_loop] stop: it lifts it, like a new owner prompt
    if (s && !s.isChild && s.loopStop && event.toolName === ASK_USER_TOOL && askAnsweredSome((event.result as { details?: unknown } | undefined)?.details, event.isError)) {
      s.loopStop = null;
      persistRounds(s);
      s.trace?.emit({ event: "cap_reset", by: "ask", count: 1 });
    }
    if (s && !s.isChild && !event.isError && ownerAnswered(event.toolName, (event.result as { details?: unknown } | undefined)?.details, event.isError)) {
      idleBind = { s, ctx };
      await idleModel.onAnswer(); // the owner is back: the answer's next request runs on the base model
    }
    if (!s || s.isChild || !s.ledgerBash.delete(event.toolCallId)) return;
    const res = event.result as { content?: { type?: string; text?: string }[] } | undefined;
    const text = (res?.content ?? []).map((c) => (c && c.type === "text" ? c.text ?? "" : "")).join("\n");
    s.trace?.emit({ event: "ledger_call", kind: "bash", allowed: !isPermissionDeny(event.isError, text) });
  });

  pi.on("tool_result", async (event, ctx) => {
    sessionFor(ctx)?.gitDrift.after(ctx.cwd, os.homedir(), event.toolCallId);
    const owner = sessionFor(ctx);
    if (event.isError) owner?.trace?.emit(toolErrorRecord(event.toolName, event.content)); // R6 lane 7f
    const created = manifest.onToolResult(event.toolCallId, event.isError);
    if (owner && created.length) {
      const o = manifestOwner({ id: owner.id, isChild: owner.isChild, foremanSession: owner.usage.line.foremanSession, launchId: owner.usage.line.launchId }, process.env);
      await recordEntries(created, { ...o, stateDir: manifestCtx(owner, ctx.cwd).stateDir }, (args) => runScript(owner, "foreman_close.py", args, 15_000), (e, why) => owner.trace?.emit({ event: "manifest_record_failed", kind: e.kind, error: why }));
    }
    if (owner && !owner.isChild && !event.isError && (event.toolName === "write" || event.toolName === "edit")) {
      const given = (event.input as Record<string, unknown>).path;
      if (typeof given === "string") {
        if (inOwnHandoff(owner, path.resolve(ctx.cwd, given))) evalOwnAsk(owner);
        const real = toolWriteRuling(path.resolve(ctx.cwd, given));
        if (real !== null) {
          selfRulingsFor(owner).mark(real);
        }
      }
    }
    const bashSnap = bashRulingSnaps.get(event.toolCallId);
    if (owner && bashSnap) {
      bashRulingSnaps.delete(event.toolCallId);
      selfRulingsFor(owner).markChanged(bashSnap, childDirsOf(owner));
    }
    // Pushed branches for the close-time notice (pushnotice.ts); display data only, never blocks the result.
    if (owner && !owner.isChild && owner.prPack && event.toolName === "bash") {
      const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      const code = (event.details as { exitCode?: unknown } | undefined)?.exitCode;
      const command = (event.input as Record<string, unknown>).command;
      if (typeof command === "string") void owner.pushNotice.onBash(command, text, typeof code === "number" ? code === 0 : !event.isError, ctx.cwd).catch(() => undefined);
    }
    owner?.mutating.delete(event.toolCallId);
    owner?.commandCalls.delete(event.toolCallId);
    owner?.questionCalls.delete(event.toolCallId);
    owner?.runningCalls.delete(event.toolCallId);
    releaseQuestion(event.toolCallId);
    if (owner?.isChild && event.toolName === "bash" && process.env[SCRATCH_ENV]) clearOpenCommand(process.env[SCRATCH_ENV]!, event.toolCallId);
    // A shell command may have copied in an ask.md or a brief: the rule is evaluated again.
    if (owner && !owner.isChild && event.toolName === "bash") evalOwnAsk(owner);
    const pending = owner?.pendingChanges.get(event.toolCallId);
    let planFormNote = "";
    const wroteFile = !!owner && !owner.isChild && !event.isError && (event.toolName === "write" || event.toolName === "edit");
    const wrotePath = (event.input as Record<string, unknown>).path;
    if (owner && wroteFile && typeof wrotePath === "string") {
      const bound = boundLedger(owner.markerDir, owner.id);
      if (bound && isBoundLedgerPath(resolveToolPath(wrotePath, ctx.cwd, os.homedir()), bound)) bumpLedgerRev(owner); // a direct write of the ledger counts, whatever it changed
    }
    if (owner && wroteFile && isPlanPath(wrotePath, planOpts(owner, ctx))) {
      owner.trace?.emit({ event: "plan_written", tier: owner.ceremony.tier, by: "foreman" });
      const written = readPlan(wrotePath, planOpts(owner, ctx));
      if ("error" in written) planFormNote = written.error; // e.g. a Write over the generated copy that lost its marker
      else {
        // a write in the tool batch of a still-open [plan-review] launch (also one nested in a codemode call): the reviewer reads these bytes
        owner.planReviews.refreshLaunch(written.plan.path, written.plan.hash, written.plan.markdown, owner.launchBatch.generation);
        const issues = planFormIssues(written.plan.markdown, {});
        if (issues.length > 0) planFormNote = `pi-foreman: the plan form is wrong (${issues.join("; ")}). Fix it now; a [plan-review] launch is refused until it is fixed. The first ## section must be a non-empty ## Summary (## For the owner is still accepted).`;
        if (written.plan.kind === "html" && typeof wrotePath === "string" && wrotePath.endsWith(".md")) planFormNote = `pi-foreman: plan-${written.plan.topic}.md is generated from plan-${written.plan.topic}.html; edit the page, not the copy. The copy was written again from the page.${planFormNote ? `\n${planFormNote}` : ""}`;
        // jargon in the Summary is advice on its own line, never a form fault and never a refusal
        const jargon = ownerSectionIssues(written.plan.markdown).find((i) => i.startsWith("jargon: "));
        if (jargon) planFormNote += `${planFormNote ? "\n" : ""}pi-foreman: advice: the Summary section reads like jargon (${jargon.slice("jargon: ".length)}); the owner reads it cold, write it in plain words. This never blocks a review.`;
        // a Summary that misses a part of its form is advice on its own line too, never a refusal
        const hints = ownerFormHints(written.plan.markdown);
        if (hints.length) planFormNote += `${planFormNote ? "\n" : ""}pi-foreman: advice: the Summary section misses parts of its form (${hints.join("; ")}): a **Goal:** paragraph, numbered steps, boxes at the end. This never blocks a review.`;
      }
    } else if (owner && wroteFile) {
      // `rulings-<topic>.md` is the rulings sidecar of an HTML plan: the copy is derived again, with or without a plan page open
      const topic = rulingsTopic(wrotePath, planOpts(owner, ctx));
      const abs = topic ? resolveToolPath(wrotePath, ctx.cwd, os.homedir()) : null;
      const page = abs ? path.join(path.dirname(abs), `plan-${topic}.html`) : null;
      if (page && fs.existsSync(page)) {
        const r = readPlan(page, planOpts(owner, ctx));
        if ("error" in r) planFormNote = r.error;
        else owner.show?.rulingsWritten(r.plan.path);
      }
    }
    // Plan publication (show.ts): the scratch plan of a foreman and `<handoff dir>/plan.md` of a child session; a refresh, no ruling point.
    if (owner && !owner.isChild && !event.isError && (event.toolName === "write" || event.toolName === "edit")) {
      owner.show?.planWritten((event.input as Record<string, unknown>).path);
      owner.show?.resultWritten((event.input as Record<string, unknown>).path); // a session opened by another session: its result.md becomes a page
    }
    // A child's `Plan from` / `foreman:plan` notice is a ruling point: the snapshots roll.
    if (owner && !owner.isChild && !event.isError && event.toolName === INTERCOM_TOOL) {
      const i = event.input as Record<string, unknown>;
      if (i.action === "send") owner.show?.planSent(i.message);
    }
    if (owner && !owner.isChild) {
      const to = deliveredSendTo(event);
      if (to) onSendDelivered(owner, to);
    }
    // A PR tool the review gate covers: while a high-stakes review is due, its answer carries the same reminder as the receipts (never a refusal).
    const prNote = owner && !owner.isChild && !event.isError && isPrToolName(event.toolName) && get(owner.config.config, "ceremony.reviewBeforePr") !== false && hsRequired(owner) ? `pi-foreman: ${dueReminder(hsDue(owner))}.` : "";
    const readNote = owner?.readNotices.get(event.toolCallId);
    owner?.readNotices.delete(event.toolCallId);
    const qHint = questionHints.get(event.toolCallId);
    questionHints.delete(event.toolCallId);
    // D27: a project-file edit through the foreman's own tools is work, at every tier.
    const projectChanged = !!owner && !owner.isChild && !event.isError && projectChange(event.toolName, event.input as Record<string, unknown>, editModeOfSession(owner).scratchDir, { cwd: ctx.cwd, home: os.homedir(), platform });
    if (owner && projectChanged) owner.work.edits++;
    const withNote = () => (readNote || qHint || planFormNote || prNote ? { content: [...(readNote ? [{ type: "text" as const, text: readNote }] : []), ...event.content, ...(qHint ? [{ type: "text" as const, text: qHint }] : []), ...(planFormNote ? [{ type: "text" as const, text: planFormNote }] : []), ...(prNote ? [{ type: "text" as const, text: prNote }] : [])] } : undefined);
    // A project-file change is a revision of its checkout for an uncleared high-stakes FAIL (highstakes.ts).
    if (owner && projectChanged && owner.hs.hasRuns()) {
      const edited = resolveToolPath(changedFileOf(event.toolName, event.input as Record<string, unknown>), ctx.cwd, os.homedir());
      await hsRevised(owner, edited ? path.dirname(edited) : ctx.cwd);
    }
    // Only a project-file change invalidates a PASS; ledger, notes and scratch writes do not.
    // It is also a revision that re-opens the reviewer step (ceremony.reviewGate).
    // The checkout of the edited file (a move: source and destination) revises its own gate entry; unresolved: every entry (reviewgates.ts).
    if (owner && projectChanged) {
      const input = event.input as Record<string, unknown>;
      const files = event.toolName === "foreman_move" ? [input.src, input.dst] : [changedFileOf(event.toolName, input)];
      const dirs = files.map((f) => resolveToolPath(f, ctx.cwd, os.homedir())).filter((f): f is string => !!f).map((f) => path.dirname(f));
      const roots = dirs.length === files.length ? await rootsOf(dirs) : null;
      const only = roots !== null && roots.length === 1 ? roots[0] : null;
      const g = only !== null ? owner.reviewGates[only] : undefined;
      const touchUp = only !== null && g !== undefined && stands(g) && (await owner.reviewSync, await commentOnlyNow(owner, only));
      if (!touchUp) {
        const before = JSON.stringify(owner.reviewGates);
        reviseGates(owner, roots, false);
        persistCeremonyState(owner);
        if (JSON.stringify(owner.reviewGates) !== before) {
          owner.live?.flush();
          void owner.prWatches.reconcileOwned().finally(() => owner.live?.flush());
        }
      }
    }
    if (owner && event.toolName === "bash") recordBashLog(owner, event.details);
    if (owner && !owner.isChild && !event.isError && event.toolName === "bg_wait") recordChild(owner, bgWaitLocations(event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"), knownRun(owner)));
    if (owner && pending) {
      owner.pendingChanges.delete(event.toolCallId);
      if (!event.isError) owner.tally = addChange(owner.tally, pending);
    }
    if (event.toolName === SUPERVISOR_TOOL) {
      const s = sessionFor(ctx);
      const outcome = s?.supervisor.replyOutcome(event.details, event.isError, (runId) => isLiveRun(s, runId));
      const closed = s?.supervisor.onSupervisorResult(event.details, event.isError, (runId) => isLiveRun(s, runId));
      if (s && outcome) s.trace?.emit({ event: "supervisor_reply", replyTo: typeof (event.details as { replyTo?: unknown } | undefined)?.replyTo === "string", isError: event.isError === true, outcome });
      if (closed) s?.trace?.emit({ event: "supervisor_request", role: closed.role, decision: event.isError ? "closed_dead_run" : "replied" });
    }
    if (event.toolName === "subagent") {
      const s = sessionFor(ctx);
      let askLine: string | null = null;
      if (s) {
        s.pendingLaunches.delete(event.toolCallId);
        parkFor(s).dropCall(event.toolCallId);
        recordLaunch(s.runs, event.input, event.details, event.isError);
        recordLaunchRoles(s.launchedRoles, event.input, event.details, event.isError);
        const heads = s.launchHeadsByCall.get(event.toolCallId);
        s.launchHeadsByCall.delete(event.toolCallId);
        const trees = s.launchTreesByCall.get(event.toolCallId);
        s.launchTreesByCall.delete(event.toolCallId);
        const runId = launchId(event.input, event.details, event.isError);
        if (runId && s.reviewRootsByCall.has(event.toolCallId)) capSet(s.reviewRoots, runId, s.reviewRootsByCall.get(event.toolCallId) ?? null);
        s.reviewRootsByCall.delete(event.toolCallId);
        const boundId = boundLaunchId(event.input);
        if (boundId && runId && !s.isChild) parkFor(s).noteRun(runId, boundId); // a later resume of this run finds its launch
        const launched = s.scratch.onLaunched(boundId, runId);
        finishScratch(s, launched);
        const resumedLaunch = s.isChild ? null : parkFor(s).resumeLaunched(event.toolCallId, runId);
        askLine = closeChildAsk(s, launched ?? resumedLaunch);
        s.ladder.onLaunched(event.toolCallId, runId);
        // a `[high-stakes]` launch: the run id is kept in the state (persisted); a failed launch drops the running mark
        if (!s.isChild) s.hs.settleHanded(event.toolCallId, runId, event.isError);
        if (!s.isChild && s.hs.settle(event.toolCallId, runId, event.isError) !== null && runId) persistCeremonyState(s);
        if (runId && !s.isChild) {
          const rowRoles = s.launchedRoles.get(runId) ?? [];
          if (actionOf(event.input as Record<string, unknown>) === "resume") s.childRuns.onResumed(event.toolCallId, runId, resumeTarget(event.input as Record<string, unknown>), rowRoles);
          else s.childRuns.onLaunched(event.toolCallId, runId, rowRoles);
          radarTouch(s, ctx);
        }
        if (heads && runId) capSet(s.launchHeads, runId, heads);
        if (trees && runId) capSet(s.launchTrees, runId, trees);
        const roStart = s.readonlyStartByCall.get(event.toolCallId);
        s.readonlyStartByCall.delete(event.toolCallId);
        if (roStart && runId) {
          capSet(s.readonlyStart, runId, roStart);
          if (roStart.kind === "picture") capSet(s.readonlyRoots, runId, roStart.roots);
        }
        const rl = s.reviewRuns.byCall.get(event.toolCallId);
        s.reviewRuns.byCall.delete(event.toolCallId);
        const namedLedger = s.ledgerByCall.get(event.toolCallId);
        s.ledgerByCall.delete(event.toolCallId);
        // a resume names no ledger: the resumed run's route carries over (same or new run id), persisted like the others
        const resumedRoute = !namedLedger && runId && actionOf(event.input as Record<string, unknown>) === "resume" ? s.ledgerByRun.get(resumeTarget(event.input as Record<string, unknown>) ?? "") : undefined;
        // the resumed run is a new run: the earlier run's `failed` does not carry over
        const resumed = resumedRoute?.review?.failed ? { ...resumedRoute, review: { ...resumedRoute.review, failed: undefined } } : resumedRoute;
        if (resumed && runId) {
          capSet(s.ledgerByRun, runId, resumed);
          if (resumedRoute?.review?.failed) s.reviewRecords.delete(runId);
          if ((resumed.review || resumed.paths.some((p) => p !== null)) && resumeTarget(event.input as Record<string, unknown>) !== runId) persistRoute(runId, resumed);
        }
        // a review launch's route carries its launch id, the ids its verdict tool accepts and its occasion (the notice after a reload reads them)
        const reviewEntry = rl?.entries.find((e) => REVIEW_ROLES.includes(e.role));
        const routeReview: LedgerRoute["review"] = reviewEntry && boundId && !event.isError ? { launch: boundId, items: s.launches.get(boundId)?.items ?? [], occasion: reviewEntry.occasion, shadow: reviewEntry.shadow !== null } : undefined;
        if (namedLedger && runId) {
          const route = routeReview ? { ...namedLedger, review: routeReview } : namedLedger;
          capSet(s.ledgerByRun, runId, route);
          if (route.review || namedLedger.paths.some((p) => p !== null)) persistRoute(runId, route);
        }
        if (rl && runId) capSet(s.reviewRuns.byRun, runId, rl);
        // a resumed review run is a new run id: it takes the occasion and shadow of the run it resumes (every run-end consumer reads `byRun`); a gate primary does not reopen its panel
        else if (runId && !s.isChild && actionOf(event.input as Record<string, unknown>) === "resume") {
          const earlier = s.reviewRuns.byRun.get(resumeTarget(event.input as Record<string, unknown>) ?? "");
          if (earlier && !s.reviewRuns.byRun.has(runId)) capSet(s.reviewRuns.byRun, runId, earlier.bind ? earlier : { ...earlier, panel: null });
        }
        trackActive(s.activeRuns, event.input, event.details, event.isError);
        if (!s.isChild) {
          // Budgets restart only for a launch that started (a run id came back), not a refused one.
          if (runId) {
            recordChild(s, launchLocations(event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"), event.details, path.join(os.tmpdir(), `pi-subagents-uid-${process.getuid?.() ?? ""}`)));
            const roles = s.launchedRoles.get(runId) ?? subagentAgents(event.input as Record<string, unknown>);
            const cited = hsCited.get(event.toolCallId) ?? citedItems(subagentTaskText(event.input as Record<string, unknown>));
            hsCited.delete(event.toolCallId);
            s.retro.launchItems.set(runId, cited);
            for (const [f, items] of hintTargets(s, runId, cited)) writeHint(f, items, `${roles.join("+") || "child"} launched (run ${runId.slice(0, 8)})`, s.retro.hints, hintOpts(s));
            s.budget.onLaunch();
            if (roles.includes("builder")) {
              const input = event.input as Record<string, unknown>;
              for (const d of builderDirs(ctx, input)) await hsRevised(s, d); // a builder run is a revision of its checkout
              // the checkouts it worked in: a resume revises its target's (none recorded: unknown), a fresh run each entry's own dir
              const roots = actionOf(input) === "resume" ? (s.builderRoots.get(resumeTarget(input) ?? "") ?? null) : await rootsOf(builderDirs(ctx, input));
              capSet(s.builderRoots, runId, roots);
              // a touch-up candidate: one known checkout whose own PASS stands and no reviewer in the launch
              if (roots?.length === 1 && stands(s.reviewGates[roots[0]] ?? { last: null, revised: false }) && !roles.some((r) => REVIEW_ROLES.includes(r))) s.touchUps.set(runId, roots[0]);
              reviseGates(s, roots, true);
              persistCeremonyState(s);
              s.live?.flush();
              void s.prWatches.reconcileOwned().finally(() => s.live?.flush());
            }
            const after = reopened(combined(s.reviewGates));
            if (after) for (const role of roles.filter((r) => REVIEW_ROLES.includes(r))) s.trace?.emit({ event: "rereview", role, after });
          }
        }
      }
      const launchedOn = roleModelsOf(event.input);
      for (const role of subagentAgents(event.input as Record<string, unknown>)) s?.trace?.emit({ event: "role_launched", role, exit: event.isError ? 1 : 0, pollBash: s.pollBash || undefined, ...(launchedOn.has(role) ? { model: launchedOn.get(role) } : {}) });
      if (s) s.pollBash = 0;
      const modelLine = s && !s.isChild && !event.isError && launchedOn.size > 0 ? `pi-foreman: launched ${[...launchedOn].map(([role, model]) => `${role} on ${model}${rungNote(bottomNotes.get(event.toolCallId)?.get(role), climbNotes.get(event.toolCallId)?.get(role))}`).join(", ")}.` : null;
      bottomNotes.delete(event.toolCallId);
      climbNotes.delete(event.toolCallId);
      const recordedOccasions = launchOccasions.get(event.toolCallId) ?? [];
      launchOccasions.delete(event.toolCallId);
      // R27 item 4: a non-item review occasion is named in the launch result, so a misclassified review is visible before it runs.
      const occasionLines = s && !s.isChild && !event.isError ? occasionLinesOf(recordedOccasions, (recordedOccasions.includes("pre-pr") || recordedOccasions.includes("item")) && hsRequired(s), dueReminder(hsDue(s))) : [];
      const notices = modelLine || occasionLines.length > 0 ? [...(s?.launchNotices.get(event.toolCallId) ?? []), ...(modelLine ? [modelLine] : []), ...occasionLines] : s?.launchNotices.get(event.toolCallId);
      if (s && notices) s.launchNotices.delete(event.toolCallId);
      const held = s ? await holdLaunch(s, ctx, event.toolCallId, event.input, event.details, event.isError) : null;
      // A detached launch (the default) returns its receipt and one line: the completion notice starts the next turn.
      const detached = s && !held ? detachedLine(s, event.input, event.details, event.isError) : null;
      // A held launch's result carries the panel block of its run end (else it comes as its own message).
      const pb = s && held ? s.reviewRuns.blocks.get(launchId(event.input, event.details, event.isError) ?? "") : undefined;
      if (pb) pb.claimed = true;
      const panelText = pb ? await pb.text : "";
      if (held && panelText) held.text = `${held.text}\n\n${panelText}`;
      if (s && held?.path) recordChild(s, [held.path]);
      // subagent has no post guards (toolmap.ts), so the amended result can be returned here.
      // The held text stays the last block: deliveredRuns accepts the "done" marker only there.
      const trim = (held && !held.plain) || detached !== null ? dropAsyncGuidance(event.content) : null;
      if (s && trim && trim.trimmed > 0) s.trimmedLines.set(launchId(event.input, event.details, event.isError) ?? "", trim.trimmed);
      const tail = held ? held.text : detached;
      // Sizing belt: a pi-subagents refusal caused by a size/risk that the call carried outside its top level gets the fix text.
      const misplacedHere = misplacedSizing.delete(event.toolCallId);
      const sizingHint = misplacedHere && event.isError ? misplacedHint(event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")) : null;
      if (sizingHint) s?.trace?.emit({ event: "sizing_hint" });
      if (notices || tail !== null || sizingHint || askLine) return { content: [...(notices ?? []).map((text) => ({ type: "text" as const, text })), ...(trim ? trim.content : event.content), ...(tail !== null ? [{ type: "text" as const, text: tail }] : []), ...(sizingHint ? [{ type: "text" as const, text: sizingHint }] : []), ...(askLine ? [{ type: "text" as const, text: askLine }] : [])] };
    }
    const mapping = mapTool(event.toolName);
    const changed = event.isError ? undefined : changedFileOf(event.toolName, event.input as Record<string, unknown>);
    if ((mapping.post.length === 0 && changed === undefined) || event.isError) return withNote();
    try {
      const s = await ensureSession(ctx);
      const input = event.input as Record<string, unknown>;
      const file = resolveToolPath(changed, ctx.cwd, os.homedir());
      // Item 4: a path outside the session's workspace (a child's handoff dir, another checkout) binds no ledger and changes no tier.
      const outside = !!file && !ownWorkPath(s, file);
      for (const guard of mapping.post) {
        if (guard === "ledger_bind" && outside) {
          s.trace?.emit({ event: "guard", guard, toolFamily: event.toolName, decision: "skip", reason: "outside_workspace" });
          continue;
        }
        // R28: the core's ledger_bind rebinds on every Write/Edit; here only a Write rebinds a live binding (an Edit of the backlog keeps the round ledger).
        if (guard === "ledger_bind" && event.toolName === "edit" && boundLedger(s.markerDir, s.id)) {
          s.trace?.emit({ event: "guard", guard, toolFamily: event.toolName, decision: "skip", reason: "live_binding" });
          continue;
        }
        const outcome = await run(s, ctx, guard, postToolPayload(event.toolName, input, payloadCtx(s, ctx), event.isError), mapping.coreName);
        if (outcome.kind === "failure") notifyOnce(s, ctx, `open:${guard}`, outcome.message);
      }
      // R27 item 5: a ledger written is the round boundary; the next builder launch records a new diff base (diffscan.ts ReviewFacts).
      if (file && !outside && !s.isChild && event.toolName === "write" && isLedgerTarget(file)) reviewFacts.reset();
      if (file && !outside && !s.isChild) {
        const heavy = Number(get(s.config.config, "ceremony.heavyFileCount"));
        setCeremony(s, onFileChanged(s.ceremony, file, Number.isFinite(heavy) ? heavy : 0));
      }
      refreshLedgerTier(s);
    } catch {
      // side effects only
    }
    return withNote();
  });

  /**
   * Knob 3 (launchwait.ts): hold a foreman's single-child launch result until the run ends, the
   * child asks the supervisor, the turn is aborted or wait.maxSeconds passes; the text to append,
   * or null when the launch is not held (detach mode, child session, error, multi-run launch, or
   * a later launch of the same message has not started yet).
   */
  async function holdLaunch(s: Session, ctx: ExtensionContext, callId: string, input: unknown, details: unknown, isError: boolean): Promise<{ text: string; path: string | null; plain?: boolean } | null> {
    if (s.isChild || launchWaitMode(get(s.config.config, "ceremony.launchWait")) !== "block") return null;
    const runId = launchId(input, details, isError);
    const run = runId ? s.runs.get(runId) : undefined;
    if (!runId || !run || !s.launchBatch.mayHold(callId)) return null;
    // a panel shadow is optional and never blocks: its launch returns at once
    if (shadowRun(s.reviewRuns.byRun.get(runId))) return null;
    const open = openRequestLine(s.supervisor.open.size, runId);
    if (open) return { text: open, path: null, plain: true };
    const cap = holdCap(waitLimits((k) => get(s.config.config, `wait.${k}`)).maxSeconds, roleTimeoutMs(get(s.config.config, "roles"), run.role));
    const started = Date.now();
    // a chair/parent steer file in the handoff dir ends the wait early (steerwatch.ts); no handoff dir: no polling
    const watch = steerWatchFor(s);
    const stop = new AbortController();
    const onCtxAbort = (): void => stop.abort();
    ctx.signal?.addEventListener("abort", onCtxAbort, { once: true });
    if (ctx.signal?.aborted) stop.abort();
    let steerText = "";
    const stopPoll = watch.start((text) => {
      steerText = steerText ? `${steerText}\n\n${text}` : text;
      stop.abort();
    });
    let r: Awaited<ReturnType<typeof launchWaits.wait>>;
    try {
      r = await launchWaits.wait(runId, cap.seconds * 1000, stop.signal);
    } finally {
      stopPoll();
      ctx.signal?.removeEventListener("abort", onCtxAbort);
    }
    // a steer that landed after the last poll (the wait resolved first) is taken now, so this result shows it
    steerText = takeLateSteer(watch, steerText);
    if (steerText && r.outcome === "abort" && !ctx.signal?.aborted) {
      const ms = Date.now() - started;
      watch.commit(); // the steer is in the returned text
      s.trace?.emit({ event: "launch_wait", role: run.role, runId, outcome: "steer", ms });
      return { text: `pi-foreman launch-wait: run ${runId} (${run.role}) is still running after ${Math.round(ms / 1000)}s; the wait ended early because a steer arrived. Continue with bg_wait ${runId} after acting on it.\n${steerText}`, path: null, plain: true };
    }
    const ms = Date.now() - started;
    s.trace?.emit({ event: "launch_wait", role: run.role, runId, outcome: r.outcome, ms });
    const raw = details && typeof details === "object" ? (details as { asyncDir?: unknown }).asyncDir : undefined;
    const asyncDir = typeof raw === "string" ? raw : null;
    const text = launchWaitText({ outcome: r.outcome, runId, role: run.role, ms, maxSeconds: cap.seconds, capBy: cap.by, by: r.by, end: r.end, asyncDir });
    const climb = s.ladder.eligible.get(run.role);
    const topClimb = s.ladder.topHandoffs.get(run.role);
    // a steer taken as the run ended is delivered only if it is shown here; otherwise it stays pending
    const shown = foldSteer(watch, steerText, climb && climb.runId === runId && !r.end?.policyBlock && !r.end?.repeatRefusal ? `${text}\n${climbHint(climb)}` : topClimb && topClimb.runId === runId ? `${text}\n${topClimbHint(topClimb)}` : text, !ctx.signal?.aborted);
    return { text: steerFor(s).append(shown), path: r.end?.resultPath ?? asyncDir };
  }

  /** The receipt line of a detached launch (launchwait.ts detachedLaunchLine); null for a child session, an error or a launch with no known run. */
  function detachedLine(s: Session, input: unknown, details: unknown, isError: boolean): string | null {
    const runId = launchId(input, details, isError);
    const run = runId ? s.runs.get(runId) : undefined;
    if (s.isChild || !runId || !run) return null;
    const raw = details && typeof details === "object" ? (details as { asyncDir?: unknown }).asyncDir : undefined;
    return detachedLaunchLine({ runId, role: run.role, resultPath: typeof raw === "string" ? raw : null });
  }

  // Knob 5a (launchwait.ts): a completion notice whose result an earlier message delivered is dropped from the model context.
  pi.on("context", async (event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild || !dedupeOn(get(s.config.config, "ceremony.dedupeNotify"))) return undefined;
    const calls = dedupeToolCallNotices(event.messages);
    const ended = dropEndedRunNotices(calls?.messages ?? event.messages, s.attention.endedRuns);
    const hiddenLong = dropSuppressedNotices(ended?.messages ?? calls?.messages ?? event.messages, s.attention.suppressed);
    const r = dedupeNotices(hiddenLong?.messages ?? ended?.messages ?? calls?.messages ?? event.messages);
    const base = hiddenLong ?? ended ?? calls;
    // Prompt cache: a message already sent keeps its first verdict (notices.ts stableNoticeFilter); new state reaches only unsent ones.
    const fresh = r?.messages ?? base?.messages ?? event.messages;
    const stable = stableNoticeFilter(event.messages, fresh, s.noticeVerdicts);
    for (const runId of r?.deduped ?? []) {
      if (s.dedupeTraced.has(runId)) continue;
      s.dedupeTraced.add(runId);
      s.trace?.emit({ event: "notify_deduped", runId, mode: r!.mode, trimmed_lines: s.trimmedLines.get(runId) ?? 0 });
    }
    return stable ? { messages: stable } : undefined;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed") return undefined;
    const s = await ensureSession(ctx);
    await s.reviewSync; // PASS marks and the comment-only check land before the stop guard reads the ledger
    if (!s.isChild) savePause(s); // the work of this run reaches the session entry at the settle (D27)
    // A source that starts a turn by itself when it ends makes this settle a pause, not a finish: neither gate runs (the stop guard's once-per-session reminder and the refusal counter stay unspent).
    const pending = pendingWakeSources(s);
    if (pending.length > 0) {
      s.trace?.emit({ event: "finish_gate", skipped: "pending_wait", runId: pending.join(",") }); // the ids ride in `runId`: `note` is dropped for this event, a new field would change the pinned allowlist
      return undefined;
    }
    const outcome = await run(s, ctx, "ledger_guard_stop", stopPayload(payloadCtx(s, ctx), s.stopContinued), "Stop");
    const r = translateStop(outcome);
    if (r.openFailure) notifyOnce(s, ctx, "open:ledger_guard_stop", r.openFailure);
    // §2.4: a reviewer child with a record folder and no record yet is held once, in the same continue as a ledger hold.
    const owes = !s.stopContinued && verdictOwed();
    if (!r.hold && !owes) return await ceremonyFinishGate(s, ctx, event.entries);
    s.stopContinued = true;
    if (r.hold) s.trace?.emit({ event: "stop_hold", guard: "ledger_guard_stop", decision: "continue" });
    if (owes) s.trace?.emit({ event: "stop_hold", guard: "review_verdict", decision: "continue" });
    const reason = [r.hold ? (r.reason ?? "") : "", owes ? VERDICT_REMINDER : ""].filter(Boolean).join("\n\n");
    return {
      entries: [...event.entries, { type: "custom_message" as const, customType: "pi-foreman-stop-gate", content: reason, display: true }],
      continue: true,
    };
  });

  /** Ids of what will wake this foreman session on its own: foreman_wait entries, running or launching subagents, bg_run tasks of this pi process that notify and trigger. */
  function pendingWakeSources(s: Session): string[] {
    if (s.isChild) return [];
    const ids = waits.active(s.id).map((w) => `wait:${w.id}`);
    for (const id of [...s.activeRuns, ...s.pendingLaunches]) ids.push(`run:${id}`);
    try {
      for (const id of wakingBgTaskIds(s.cwd, s.id)) ids.push(`bg:${id}`);
    } catch {
      // no task records: none running
    }
    return ids;
  }

  /**
   * D2: a triaged standard/heavy session finishes only after its required steps
   * (ceremony.required). Not while a child of this session still runs (its completion starts the
   * next turn). A turn end with open ledger items and no new work since the last owner prompt is a pause (D27). At most 2
   * refusals per unchanged state (missing steps, work, review verdict); then the settle passes, visibly (D28).
   */
  async function ceremonyFinishGate<E>(s: Session, ctx: ExtensionContext, entries: E[]) {
    if (s.isChild || !isTriaged(s.ceremony) || s.activeRuns.size > 0) return undefined;
    // A handoff wait or a pending checkpoint waits for the parent/owner: the turn may end; the next user/parent input clears it.
    if (s.waitingForParent) {
      s.trace?.emit({ event: "ceremony_gate", reason: "waiting_for_parent", tier: s.ceremony.tier });
      return undefined;
    }
    startPushNotice(s, ctx);
    const escalated = await trivialFinishCheck(s, ctx);
    const gateMode = reviewGateMode(get(s.config.config, "ceremony.reviewGate"));
    // A parent ruling never satisfies the gate (R6 lane 4c, ruling 3); after a FAIL the refusal names it.
    const gate = combined(s.reviewGates); // every checkout with work or a review must have a standing PASS
    const missing: string[] = openSteps(s.steps, requiredOf(s, s.ceremony.tier), gateMode, gate);
    // A rejected plan blocks the heavy finish until a new approval or the user lowers the tier (/ceremony).
    const rejected = s.ceremony.tier === "heavy" && s.plan?.status === "rejected";
    if (rejected) missing.push("plan");
    // High stakes (highstakes.ts): the pass that must run and the FAIL not yet cleared, for standard and heavy sessions.
    const hsNeeds: ReturnType<typeof finishNeeds> = s.ceremony.tier === "standard" || s.ceremony.tier === "heavy" ? await hsFinish(s) : { missing: [], hint: "" };
    missing.push(...hsNeeds.missing);
    if (missing.length === 0) return hsNeeds.remind ? await hsReminderHold(s, ctx, entries, hsNeeds.remind, hsNeeds.reasons ?? []) : undefined;
    // D27: open ledger items and no builder run or foreman edit since the last owner prompt: a pause, not a finish.
    const lf = boundLedger(s.markerDir, s.id);
    const openLedger = (() => { try { return lf ? hasOpenLedgerLine(fs.readFileSync(lf, "utf8")) : false; } catch { return false; } })();
    if (!rejected && openLedger && s.work.builders === s.workAtPrompt.builders && s.work.edits === s.workAtPrompt.edits) {
      s.trace?.emit({ event: "ceremony_gate", reason: "pause", tier: s.ceremony.tier });
      // work from an earlier prompt that no PASS covers: one reminder with the next turn (appended, never system text)
      if (missing.includes("reviewer") && s.work.builders + s.work.edits > 0 && !s.reminderQueued) {
        s.reminderQueued = true;
        pi.sendMessage({ customType: "pi-foreman-review-reminder", content: "pi-foreman: unreviewed work: a reviewer PASS is still missing before finish or PR.", display: true }, { deliverAs: "nextTurn" });
      }
      return undefined;
    }
    // The no-change valve (ledger nochange-finish): git runs only when the counters already say nothing was built or edited.
    if (!rejected && s.steps.builder === 0 && s.work.builders === 0 && s.tally.files.length === 0) { // a launched builder (failed or not) is work even when the tree stays clean
      const porcelain = await cleanTreeStatus(ctx.cwd, editModeOfSession(s).scratchDir, platform);
      if (noChange(s.steps, s.tally.files.length, porcelain)) {
        s.trace?.emit({ event: "ceremony_gate", reason: "no_change", tier: s.ceremony.tier });
        ctx.ui.notify("pi-foreman: finished without a change: no builder or reviewer required", "info");
        return undefined;
      }
    }
    // D28: the count belongs to the state the refusal answers (missing steps, work, review verdict); a new state starts at zero.
    const stateKey = [missing.join(","), `${s.work.builders}.${s.work.edits}`, Object.entries(s.reviewGates).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, g]) => `${k}:${g.last ?? ""}:${g.failAt ?? ""}`).join(",")].join("|"); // every checkout's verdict, not the combined one
    if (s.finishKey !== stateKey) (s.finishKey = stateKey), (s.finishRefusals = 0);
    // Ladder (e): after a FAIL with the builder still on its bottom rung, the revision climbs; this refusal
    // counts as one of the state's two refusals (same counter), with its own message.
    if (missing.includes("reviewer") && gate.last === "fail" && s.finishRefusals < 2 && (await builderClimbOpen(s, ctx))) {
      s.finishRefusals++;
      savePause(s);
      s.trace?.emit({ event: "finish_refused", tier: s.ceremony.tier, missing: missing.join(","), climb_available: true });
      return {
        entries: [...entries, { type: "custom_message" as const, customType: "pi-foreman-ceremony-gate", content: finishRefusal(s.ceremony.tier, missing as Step[], openHint(s.reviewGates, { cwd: s.cwd, own: await hsOwnRoot(s) })) + " Relaunch the builder for the revision; it climbs to its strong rung.", display: true }],
        continue: true,
      };
    }
    if (s.finishRefusals >= 2) {
      const text = `pi-foreman: finished with ceremony incomplete: missing ${missing.join(", ")}`;
      s.trace?.emit({ event: "ceremony_incomplete", tier: s.ceremony.tier, missing: missing.join(",") });
      ctx.ui.notify(text, "warning");
      if (s.incompleteKey === stateKey) return undefined;
      s.incompleteKey = stateKey;
      savePause(s);
      return { entries: [...entries, { type: "custom_message" as const, customType: "pi-foreman-ceremony-incomplete", content: text, display: true }] };
    }
    s.finishRefusals++;
    savePause(s);
    s.trace?.emit({ event: "finish_refused", tier: s.ceremony.tier, missing: missing.join(",") });
    return {
      entries: [...entries, { type: "custom_message" as const, customType: "pi-foreman-ceremony-gate", content: finishRefusal(s.ceremony.tier, missing as Step[], gateMode === "pass" && missing.includes("reviewer") ? openHint(s.reviewGates, { cwd: s.cwd, own: await hsOwnRoot(s) }) : "") + (hsNeeds.hint ? ` ${hsNeeds.hint}` : "") + (hsNeeds.remind ? ` ${hsNeeds.remind}.` : "") + escalated + (missing.includes("reviewer") && gate.last === "fail" && gate.failAt !== undefined ? rulingNote(s, gate.failAt) : "") + (rejected ? ` The owner rejected the plan: launch no builder; report to the owner, and get a new plan approved with ${CHECKPOINT_TOOL} before going on.` : ""), display: true }],
      continue: true,
    };
  }

  /**
   * The finish with every other step done and a high-stakes review still due: held once per reason set with the reminder (not a refusal: it is not counted),
   * then let go with an owner notice. A session that changed nothing is never held.
   */
  async function hsReminderHold<E>(s: Session, ctx: ExtensionContext, entries: E[], remind: string, reasons: string[]) {
    if (s.steps.builder === 0 && s.work.builders === 0 && s.tally.files.length === 0 && noChange(s.steps, s.tally.files.length, await cleanTreeStatus(ctx.cwd, editModeOfSession(s).scratchDir, platform))) return undefined;
    const key = reasons.join(",");
    if (s.hsReminded?.join(",") !== key) {
      s.hsReminded = reasons;
      persistCeremonyState(s);
      s.trace?.emit({ event: "high_stakes_reminded", reasons: key });
      return { entries: [...entries, { type: "custom_message" as const, customType: "pi-foreman-ceremony-gate", content: `pi-foreman: ${remind}; otherwise finish again.`, display: true }], continue: true };
    }
    if (!s.hsSkipped.has(key)) {
      s.hsSkipped.add(key);
      s.trace?.emit({ event: "high_stakes_skipped", reasons: key });
      ctx.ui.notify(`pi-foreman: finished while a high-stakes review is due (${key})`, "info");
    }
    return undefined;
  }

  /** Pushed branches without a PR: evaluated in the background, one display-only warning each (pushnotice.ts). */
  function startPushNotice(s: Session, ctx: ExtensionContext): void {
    if (s.isChild || !s.prPack) return;
    void s.pushNotice.run((name) => {
      try {
        ctx.ui.notify(`pi-foreman: pushed branch ${name} has no pull request (open one)`, "warning");
      } catch {
        // display only
      }
    });
  }

  /** The builder's review_fail climb is on and its live rung (latest launch, any path) is the bottom one; on the top rung the valve applies. */
  async function builderClimbOpen(s: Session, ctx: ExtensionContext): Promise<boolean> {
    const live = s.ladder.live.get("builder");
    if (!live) return false;
    const r = await currentRoles(s, ctx);
    if (!strongOnRevision(s.config.config, r.provider, "builder") || !onBottomRung(r.roles, "builder", live)) return false;
    const strong = get(r.roles, "builder.strong.model");
    return typeof strong !== "string" || rankRefusalFor(s.config.config, foremanBaseModel(ctx), strong, ["builder"]) === null; // a strong rung the rank policy refuses is no climb
  }

  /** ceremony.required.<tier> as it applies to this session (trivial.ts effectiveRequired). */
  /** `/foreman close`: the required steps still open and what the parent would have to rule ("" = none). */
  function closeCeremonyNote(s: Session): string {
    if (s.isChild || !isTriaged(s.ceremony)) return "";
    return rulingNeeded(openSteps(s.steps, requiredOf(s, s.ceremony.tier), reviewGateMode(get(s.config.config, "ceremony.reviewGate")), combined(s.reviewGates)));
  }

  /** The parent ruling file newer than the last FAIL, named in the finish refusal ("" = none). */
  function rulingNote(s: Session, failAt: number): string {
    const f = parentApproval(childDirsOf(s), failAt, selfRulingsFor(s));
    return f ? rulingOverrideNote(f, failAt) : "";
  }

  function requiredOf(s: Session, tier: string): Step[] {
    return effectiveRequired(requiredSteps(get(s.config.config, "ceremony.required"), tier), tier, { bounded: editModeOfSession(s).mode === "bounded", ledger: boundLedger(s.markerDir, s.id) !== null });
  }

  /** Trivial builder path (trivial.ts): at finish the builder's diff decides; a failed check escalates to standard. The refusal note, or "". */
  async function trivialFinishCheck(s: Session, ctx: ExtensionContext): Promise<string> {
    if (s.ceremony.tier !== "trivial" || !s.ceremony.trivialBuilder || !trivialBuilderPath(get(s.config.config, "ceremony.required"))) return "";
    const v = await checkTrivial(reviewFacts.recorded(), ctx.cwd, readBound(get(s.config.config, "ceremony.trivialBound")), editModeOfSession(s).scratchDir);
    if (!v) return "";
    setCeremony(s, escalate(s.ceremony, "standard", "auto", `trivial check: ${v.reason}`));
    s.trace?.emit({ event: "triage_escalated", from: "trivial", to: s.ceremony.tier, reason: v.reason });
    return escalationNote(v);
  }

  // ------------------------------------------------------------------- tools

  registerSafeOps(pi, {
    isChild: process.env.PI_SUBAGENT_CHILD === "1",
    session: async (ctx) => {
      const s = await ensureSession(ctx);
      const own = process.env.PI_FOREMAN_HANDOFF_DIR?.trim();
      const handoffDirs = s.isChild ? [] : [...ownHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)), ...(own && path.isAbsolute(own) ? [own] : [])];
      return { python: pyPath(s), isChild: s.isChild, opsConfig: get(s.config.config, "safety.ops"), handoffDirs, packOn: s.gitPack, trace: (r) => s.trace?.emit(r) };
    },
    script: path.join(PKG_ROOT, "scripts", "safe_ops.py"),
    preflight: async (ctx, op, callId) => {
      const s = await ensureSession(ctx);
      return safeOpDriftPreflight(s.gitDrift, s.isChild, ctx.cwd, os.homedir(), op, driftAsk(ctx, s.trace), (r) => s.trace?.emit(r), callId);
    },
    verifiedMerge: async (ctx, raw) => {
      const s = await ensureSession(ctx);
      const target = path.resolve(ctx.cwd, raw);
      return verifiedMergeFor({ run: (op, args, timeoutMs) => prRun(s, target, op, args, timeoutMs), git: async (args) => (await git(target, args))?.trim() || null });
    },
    spawner,
    env: () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
  });
  registerGitPack(pi, {
    session: async (ctx) => {
      const s = await ensureSession(ctx);
      return { python: pyPath(s), isChild: s.isChild, packOn: s.gitPack, opsConfig: get(s.config.config, "safety.ops"), trace: (r) => s.trace?.emit(r) };
    },
    script: path.join(PKG_ROOT, "scripts", "safe_ops.py"),
    preflight: async (ctx, op, callId) => {
      const s = await ensureSession(ctx);
      return safeOpDriftPreflight(s.gitDrift, s.isChild, ctx.cwd, os.homedir(), "git_" + op, driftAsk(ctx, s.trace), (r) => s.trace?.emit(r), callId);
    },
    spawner,
    env: () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
  });

  const prSession = async (ctx: ExtensionContext): Promise<PrPackSession> => {
    const s = await ensureSession(ctx);
    s.prCtx = ctx;
    return {
      python: pyPath(s),
      isChild: s.isChild,
      packOn: s.prPack,
      config: prOpsConfig(s),
      gateOn: get(s.config.config, "ceremony.reviewBeforePr") !== false,
      reviewed: async () => {
        await s.reviewSync;
        return passHeads(s.reviews);
      },
      headless: async () => {
        await s.reviewSync;
        return headlessPass(s.reviews);
      },
      records: async () => {
        await s.reviewSync;
        return s.reviews;
      },
      highStakes: hsGate(s),
      watches: s.prWatches,
      trace: (r) => s.trace?.emit(r),
      tracker: s.prHost,
      track: s.isChild ? undefined : async (repo, n, host) => (prFeedOn(s) ? addTracked(s.agentDir, repo, n, undefined, host) : "off"),
      trackedHost: (repo, n, hosts) => trackedHostOf(s.agentDir, repo, n, hosts),
      githubHosts: () => resolveGithubHosts(s.config.config),
      draftFlow: () => draftFlowOn(s),
      recordPr: async (o) => {
        const where = await repoIdentity(s, o.cwd);
        appendPrRow(s.agentDir, { session: s.usage.line.foremanSession, workspace: where.workspace, repo: o.repo, branch: o.branch, number: o.number, head: o.head, ts: new Date().toISOString() });
      },
    };
  };
  registerPrFollow(pi, { isChild: process.env.PI_SUBAGENT_CHILD === "1", session: prSession });
  const prPackNames = registerPrPack(pi, {
    isChild: process.env.PI_SUBAGENT_CHILD === "1",
    session: prSession,
    script: path.join(PKG_ROOT, "scripts", "safe_ops.py"),
    preflight: async (ctx, op, callId, cwd) => {
      const s = await ensureSession(ctx);
      return safeOpDriftPreflight(s.gitDrift, s.isChild, cwd ?? ctx.cwd, os.homedir(), "foreman_" + op, driftAsk(ctx, s.trace), (r) => s.trace?.emit(r), callId);
    },
    pushRefusal: async (ctx, cwd) => {
      const s = await ensureSession(ctx);
      // The push floors alone (not the gate decision, whose dangerous-class ask on a bare push would refuse every PR) on a synthetic `git push` in the PR's checkout.
      const at = cwd ?? ctx.cwd;
      const floor = lineFloors("git push", parseShell("git push", { cwd: at, platform }), floorEnvOf(s, at, sessionDirOf(ctx)));
      return floor ? floor.reason : null;
    },
    spawner,
    env: () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
  });

  // pr_create is gated inside the pack's own execute; only this extension's own registration skips the hook (the registry keeps the first tool per name).
  function isPackPrCreate(name: string): boolean {
    return name === "pr_create" && prPackNames.includes("pr_create") && isOwnTool(pi.getAllTools(), "pr_create", [ENTRY, HERE]);
  }

  // D9 long wait (wait.ts): foreman only; the wake is an ordinary custom message (no gate bypass).
  const waits = registerWait(pi, {
    home: os.homedir(),
    platform,
    session: async (ctx) => {
      const s = await ensureSession(ctx);
      return { id: s.id, isChild: s.isChild, cwd: s.cwd, agentDir: s.agentDir, roots: await gateRootsOf(s, ctx.cwd, sessionDirOf(ctx)), config: () => s.config.config, trace: (r) => s.trace?.emit(r), owned: () => s.owned.readWrite, ownTasks: (cwd) => (s.isChild ? [] : ownTaskReadable([cwd, workspaceOf(cwd).root, s.usage.line.workspace], s.usage.line.foremanSession, platform)), pressure: () => pressureOf(s), idle: () => s.activeRuns.size === 0, intercomRun: () => s.turn.cause === "intercom", inRun: () => s.inRun, onStart: (spec, id) => {
        markHandoffWait(s, spec, id);
      }, onCancel: (id) => cancelHandoffWait(s, id), steer: (text) => steerFor(s).append(text) };
    },
  });

  // D5 remote close (close.ts): `/foreman close` and a parent's intercom `foreman:close`; an ordinary close turn.
  const close = registerClose(pi, {
    platform,
    activeWaits: (id) => waits.active(id),
    cancelWaits: (id) => {
      const ids = waits.cancelAll(id);
      const s = sessions.get(id);
      if (s) for (const w of ids) cancelHandoffWait(s, w);
      return ids;
    },
    activeRuns: (id) => sessions.get(id)?.activeRuns.size ?? 0,
    session: async (ctx) => {
      const s = await ensureSession(ctx);
      return { id: s.id, isChild: s.isChild, cwd: s.cwd, reviewRounds: () => closeLines(s.agentDir, s.usage.line.foremanSession), config: () => s.config.config, trace: (r) => s.trace?.emit(r), markCause: () => void (s.turn.cause = "close"), ceremonyNote: () => closeCeremonyNote(s), watchedPrs: () => s.prWatches.numbers(), refreshWatched: () => s.prWatches.refresh(), mergedPr: () => (process.env[HANDOFF_DIR_ENV]?.trim() ? s.prWatches.mergedPrs().at(-1)?.n ?? null : null), selfFinish: async (c, req) => {
        const handoff = process.env[HANDOFF_DIR_ENV]?.trim() ?? "";
        const py = pyPath(s);
        const script = path.join(PKG_ROOT, "scripts", "foreman_close.py");
        if (!handoff || !py || !req.pr) return { lines: ["cleanup: not started (no handoff dir or no usable Python)"] };
        return selfFinish({ cwd: s.cwd, handoff, sessionId: s.id, stateDir: path.join(s.agentDir, "pi-foreman", "state"), trusted: safeTrusted(c), pid: process.pid, status: (n) => prRun(s, s.cwd, "pr_status", { number: n }), sinceMs: Date.now() - process.uptime() * 1000, git: async (args, dir) => (await git(dir ?? s.cwd, args))?.trim() ?? null, closeScript: async (args) => (await runScript(s, "foreman_close.py", args, 120_000)).text, spawnCleanup: (args) => spawnDetached(py, ["-E", "-s", script, ...args], handoff) }, req.pr.n);
      }, pushNotice: (c) => startPushNotice(s, c), runSync: (c) => runSync(s, c), report: (c, file) => closeReport(s, c, file), retro: async (c) => (await runScript(s, "foreman_retro.py", retroInputs(s, c, "--session"))).text, markClosed: () => void markOwnClosed(s.agentDir, process.env), remoteReply: (kind, arg) => remoteReplier({ python: pyPath(s), spawner, pkgRoot: PKG_ROOT, agentDir: s.agentDir, cwd: s.cwd, env: process.env })(kind, arg), closeChildren: (send) => closeChildren({ agentDir: s.agentDir, opener: openerIntercomId(process.env, s.agentDir, s.id), send, waitMs: Math.max(0, Number(get(s.config.config, "close.childWaitMs") ?? 60_000) || 0), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), runRemote: remoteRunner({ python: pyPath(s), spawner, pkgRoot: PKG_ROOT, agentDir: s.agentDir }) }) };
    },
  });

  // Pi 1.2+: an inbound intercom message starts an idle run through triggerTurn (no input event, and agent_start fires
  // before the message_end). Registered after registerClose so a foreman:close run is claimed first: it keeps cause "close"
  // (no idle downshift of the close turn); any other intercom run is cause "intercom" with the sender for the turn notice.
  pi.on("before_agent_start", async (event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild) return;
    const inbound = intercomInbound({ hook: "before_agent_start", messageType: (event as { messageType?: unknown }).messageType, message: (event as { message?: unknown }).message });
    if (!inbound) return;
    s.turn.cause = close.closing(s.id) ? "close" : "intercom";
    s.turn.intercomFrom = intercomSender(inbound.details);
    await idleModel.beforeTurn(s.turn.cause);
  });

  // The start note (startnote.ts, retro.startNote): its own handler, because Pi collects one message per handler and the triage hint above must not be dropped.
  // A main session without a parent only; sent once, recorded in a session entry. A message appended to the transcript, never system text.
  pi.on("before_agent_start", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild || s.startNoteDone || process.env.PI_FOREMAN_HANDOFF_DIR?.trim()) return;
    s.startNoteDone = true;
    if (get(s.config.config, "retro.startNote") === false || get(s.config.config, "retro.report") === false) return;
    if (startNoteRecorded((ctx.sessionManager.getBranch?.() ?? []) as unknown[])) return;
    const text = startNoteText(s.cwd);
    if (!text) return;
    try {
      pi.appendEntry(START_NOTE_ENTRY, { v: 1 });
    } catch {
      // the session file is not writable now: the note is still sent
    }
    return { message: { customType: START_NOTE_TYPE, content: text, display: true } };
  });

  // `/foreman session open|brief|close|list` (session.ts): user commands, foreman sessions only.
  const sessionHost: Parameters<typeof registerSession>[1]["session"] = async (ctx) => {
    const s = await ensureSession(ctx);
    const roots = await piRootsOf(s);
    return { id: s.id, isChild: s.isChild, cwd: s.cwd, agentDir: s.agentDir, python: pyPath(s), protectedRoots: { installRoot: roots.installRoot, npmRoot: roots.npmRoot, npmRootPending: s.npmRootPending }, model: idleModel.baseModel(ctx.model) ?? undefined, config: s.config.config, trace: (r) => s.trace?.emit(r), recordWorktree: async (e) => {
      const o = manifestOwner({ id: s.id, isChild: s.isChild, foremanSession: s.usage.line.foremanSession, launchId: s.usage.line.launchId }, process.env);
      await recordEntries([e], { ...o, stateDir: manifestCtx(s, ctx.cwd).stateDir }, (args) => runScript(s, "foreman_close.py", args, 15_000), (k, why) => s.trace?.emit({ event: "manifest_record_failed", kind: k.kind, error: why }));
    } };
  };
  const sessionCmd = registerSession(pi, {
    spawner,
    pkgRoot: PKG_ROOT,
    onChildNotice: (sessionId, label, kind, notePath) => void waits.childNotice(sessionId, label, kind, notePath, true),
    onPlanWait: (text) => pi.sendMessage({ customType: CHILD_BLOCKED_TYPE, content: text, display: true }, { triggerTurn: false }), // append-only, quiet: no turn of its own
    session: sessionHost,
  });

  if (process.env.PI_SUBAGENT_CHILD !== "1") registerSessionOpenTool(pi, { spawner, pkgRoot: PKG_ROOT, session: sessionHost });

  // the owner's protected targets: the foreman proposes, the owner confirms, the adapter writes (never for a child)
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.registerTool({
      name: "foreman_protect",
      label: "Protect a target",
      description: "Add or remove a protected target (a host, a path or a command glob) in the owner's permissions, after the owner confirms in a dialog. Use it when the owner asks to protect or guard a target.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["add", "remove"] }, kind: { type: "string", enum: ["host", "path", "command"] }, glob: { type: "string", minLength: 1, maxLength: 300 }, note: { type: "string", maxLength: 200 }, check: { type: "string", enum: ["model", "read-only", "ask"], description: "Optional stricter check mode for this entry (add only); it can never be looser than gate.protected.check. To change it, remove the entry and add it again." }, file: { type: "string", enum: ["project", "user"], description: "Default project (.workflow/permissions.json)." } }, required: ["action", "kind", "glob"], additionalProperties: false } as never,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const s = await ensureSession(ctx);
        const r = await protectEntry(s, ctx, { action: params.action, kind: params.kind, glob: params.glob, note: params.note, check: params.check, file: params.file });
        return { content: [{ type: "text" as const, text: r.text }], details: { decision: r.ok ? "written" : "refused" }, ...(r.ok ? {} : { isError: true }) };
      },
    } as never);
  }

  // D10: the foreman records its triage; children never get the tool.
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.registerTool({
      name: TRIAGE_TOOL,
      label: "Record the tier",
      // Bug fix (sizing): the `subagent` schema is upstream, so the foreman's tool description gets the sentence that places size/risk.
      prepareLoadout: (loadout: { declared: readonly { name: string; description?: string; parameters?: unknown }[] }) => {
        const sizingOn = [...sessions.values()].every((x) => sizingConfig(x.config.config).enabled);
        // sizing off: the MCP sentence alone, only where a role has an MCP ceiling (no ceiling, no launch field to explain)
        const hasMcpRole = (roles: unknown): boolean => typeof roles === "object" && roles !== null && Object.keys(roles).some((r) => roleMcpEntries(roles, r).length > 0);
        const mcpOn = [...sessions.values()].some((x) => hasMcpRole(get(x.config.config, "roles")));
        // The launch fields the gates read get a typed, loose declaration on Pi's wrapper of the `subagent` tool (launchschema.ts), so a model that sends only declared keys can send them.
        extendSubagentDeclaration(loadout.declared, { sizing: sizingOn, mcp: mcpOn });
        const description = sizingOn ? subagentDescription(loadout.declared, true) : mcpOn ? mcpDescription(loadout.declared) : null;
        return description ? { descriptions: { subagent: description } } : undefined;
      },
      description: "Record the ceremony tier of the current task (trivial, standard or heavy) with a one-line reason, before acting. Required before you change workspace files yourself: only a trivial tier allows that; at standard or heavy a builder makes the changes. Never lowers a tier that is already recorded or escalated.",
      parameters: { type: "object", properties: { tier: { type: "string", enum: ["trivial", "standard", "heavy"] }, reason: { type: "string", minLength: 1, description: "Why this tier, in one line." } }, required: ["tier", "reason"], additionalProperties: false } as never,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const s = await ensureSession(ctx);
        const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], details: { decision: "refused" }, isError: true });
        if (s.isChild) return refuse(`${TRIAGE_TOOL} is for the foreman only.`);
        const want = params.tier;
        if (!isTier(want)) return refuse(`${TRIAGE_TOOL}: tier must be trivial, standard or heavy.`);
        // Item 13: the edit mode already refused a change, so the task needs a builder.
        const raised = want === "trivial" && s.ceremony.needsChange === true;
        const tier = raised ? "standard" : want;
        const r = foremanTriage(s.ceremony, tier, typeof params.reason === "string" ? params.reason.slice(0, 200) : "");
        if ("error" in r) {
          s.trace?.emit({ event: "triage", tier, decision: "refused" });
          return refuse(r.error);
        }
        setCeremony(s, r.state);
        s.trace?.emit({ event: "triage", tier, decision: "recorded" });
        if (raised) s.trace?.emit({ event: "triage_escalated", from: "trivial", to: tier, reason: "edit_mode" });
        const note = raised ? "Recorded as standard, not trivial: the edit mode already refused a change of yours, so a builder makes it. " : "";
        const em = editModeOfSession(s);
        const advice = tier === "trivial" && trivialBuilderPath(get(s.config.config, "ceremony.required")) ? trivialPathAdvice(em.mode === "bounded") : tier === "trivial" && em.mode !== "bounded" ? `No builder is required, but ${editModeAdvice(em.mode, em.scratchDir)} for any project change (that makes the task standard).` : triageAdvice(tier);
        return { content: [{ type: "text" as const, text: [`${note}${tierLine(s.ceremony)} ${advice} ${TRIAGE_RULES}`, finishLine({ [tier]: requiredOf(s, tier) }, tier)].filter(Boolean).join(" ") }], details: { decision: "recorded", tier } };
      },
    } as never);
  }

  // Item 6: a note for the owner's side panel; foreman only, never takes a path (the text is the argument).
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.registerTool({
      name: SHOW_TOOL,
      label: "Show a note",
      description: "The general explanation tool: use it whenever the owner asks you to explain something they should read rendered (a design, a bug analysis, a comparison, how something works), with text, tables, code fences and ```mermaid diagrams; each call writes a standalone page the owner opens in the browser, then answer in chat with a two to three sentence summary that points at it. Not for status lines or questions (questions go to ask_user_question). Each call adds a page to the panel's list, so write each note self-contained; the pages of the last 20 calls are kept. Title up to 120 characters; give exactly one of markdown (converted to the page) or html (a whole page you wrote, stored as is and opened with scripts and network access), each up to 256 KiB; takes the text itself, never a file path.",
      parameters: { type: "object", properties: { title: { type: "string", minLength: 1, description: "Heading of the note, up to 120 characters." }, markdown: { type: "string", description: "The whole note as markdown, up to 256 KiB. Give this or html, not both." }, html: { type: "string", description: "The whole note as one HTML page, up to 256 KiB, stored as is. Give this or markdown, not both." } }, required: ["title"], additionalProperties: false } as never,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const s = await ensureSession(ctx);
        const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], details: { decision: "refused" }, isError: true });
        if (s.isChild) return refuse(`${SHOW_TOOL} is for the foreman only.`);
        const title = typeof params.title === "string" ? params.title.trim() : "";
        // an empty text counts as the one not given (ledgercall.ts absent)
        const html = typeof params.html === "string" && !absent(params.html) ? params.html : undefined;
        const markdown = typeof params.markdown === "string" && !absent(params.markdown) ? params.markdown : undefined;
        if (!title) return refuse(`${SHOW_TOOL}: title is required.`);
        if (title.length > NOTE_TITLE_MAX) return refuse(`${SHOW_TOOL}: the title is ${title.length} characters, the limit is ${NOTE_TITLE_MAX}. Shorten it.`);
        if ((html === undefined) === (markdown === undefined)) return refuse(`${SHOW_TOOL}: give exactly one of markdown or html.`);
        const size = Buffer.byteLength(html ?? markdown ?? "", "utf8");
        if (size > NOTE_MAX_BYTES) return refuse(`${SHOW_TOOL}: the note is ${size} bytes, the limit is ${NOTE_MAX_BYTES} (256 KiB). Cut it down or split it.`);
        if (!s.show) return refuse(`${SHOW_TOOL}: no side panel is available in this session (the scratch dir is disabled).`);
        try {
          const r = await s.show.note(title, markdown ?? "", html);
          // the harness knows the Herdr pane (env) but not the layout: without a pane no panel can show the note, with one only the block is in doubt
          const inHerdr = !!((process.env.HERDR_PANE_ID ?? "").trim() || (process.env.HC_TERMINAL_ID ?? "").trim());
          const hint = inHerdr
            ? " It is shown in the Herdr plan panel if your layout has a pi-foreman-plan block (see docs/herdr.md#notes)."
            : ` No Herdr pane was detected, so no panel can show it: the note is written at ${r.path}, and the Herdr layout needs a pi-foreman-plan panel block (see docs/herdr.md#notes).`;
          const page = r.page ? ` It writes a page the owner opens in the browser: ${r.page}.` : " Its page could not be written.";
          return { content: [{ type: "text" as const, text: `shown: ${title} (v${r.v}, ${r.diagrams} diagram${r.diagrams === 1 ? "" : "s"}) at ${r.path}.${page}${hint}` }], details: { decision: "shown", v: r.v, diagrams: r.diagrams } };
        } catch {
          return refuse(`${SHOW_TOOL}: the note could not be written.`);
        }
      },
    } as never);
  }

  // R14 item 4, R18 item 2: the blocking dialogs of the trace, the text of `/foreman dialogs --json`; foreman only, read only.
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.registerTool({
      name: DIALOGS_TOOL,
      label: "Permission dialogs",
      description: "Count the blocking dialogs of a trace (overlay asks, permission prompts, child dialogs, checkpoint, ask_user_question, guard asks, drift asks) per family, with the redacted command lines and a total: the JSON of /foreman dialogs --json. Without trace, the session's own trace. Read only.",
      parameters: { type: "object", properties: { trace: { type: "string", minLength: 1, description: "Path of a trace file; default: this session's trace." } }, additionalProperties: false } as never,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const s = await ensureSession(ctx);
        if (s.isChild) return { content: [{ type: "text" as const, text: `${DIALOGS_TOOL} is for the foreman only.` }], details: { decision: "refused" }, isError: true };
        const text = dialogsJson(typeof params.trace === "string" && params.trace ? { file: path.resolve(s.cwd, params.trace) } : s.trace);
        return { content: [{ type: "text" as const, text }], details: { decision: "done" } };
      },
    } as never);
  }

  // Review verdict (verdict.ts): registered inactive in every adapter process; a reviewer child gets it through its tool list (`--tools`, scripts/foreman_config.py with_review_tools).
  // The record goes into the launch's record folder (binding `verdictDir`), written by this code only: floors.ts protects the tree.
  pi.registerTool({
    name: VERDICT_TOOL,
    label: "Review verdict",
    defaultActive: false,
    executionMode: "sequential",
    description: "Give the verdict of your review as data; the harness records gates and ledger marks only from this call. Call it once your checks are done. verdict: pass, fail, or incomplete (you could not run your checks; reason is required). items: a result (pass, fail, open) for each ledger item your task lists; V only when it is listed. findings: each problem with kind (defect = blocking, now or later = advice that never fails a review), text, and for a defect its file, line and class. A pass carries no failed item and no defect; a fail needs one. A second call replaces the first. Then write your report for the foreman.",
    parameters: { type: "object", properties: { verdict: { type: "string", enum: [...VERDICT_VALUES] }, items: { type: "array", maxItems: MAX_ITEMS, items: { type: "object", properties: { id: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string", enum: ["V"] }] }, result: { type: "string", enum: [...ITEM_RESULTS] }, note: { type: "string", maxLength: 200, description: "One line." } }, required: ["id", "result"], additionalProperties: false } }, findings: { type: "array", maxItems: MAX_FINDINGS, items: { type: "object", properties: { kind: { type: "string", enum: [...FINDING_KINDS] }, text: { type: "string", maxLength: 300, description: "One line." }, file: { type: "string", maxLength: 200, description: "Repo-relative path." }, line: { type: "integer", minimum: 1 }, class: { type: "string", enum: [...FINDING_CLASSES] } }, required: ["kind", "text"], additionalProperties: false } }, reason: { type: "string", maxLength: 300, description: "One line; required when verdict is incomplete." } }, required: ["verdict"], additionalProperties: false } as never,
    async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const s = await ensureSession(ctx);
      const refuse = (text: string, reason: string) => {
        s.trace?.emit({ event: "review_verdict_call", accepted: false, reason });
        return { content: [{ type: "text" as const, text }], details: { decision: "refused" }, isError: true };
      };
      const b = launchBinding;
      if (!s.isChild || !b || !REVIEW_ROLES.includes(b.role) || !b.verdictDir || !fs.existsSync(b.verdictDir)) return refuse(`${VERDICT_TOOL}: this launch has no verdict channel (no record folder from the foreman); give the verdict in your report.`, "no_channel");
      const allowed = allowedItems(b.items, b.highStakes === true);
      const c = checkVerdictCall(params, allowed);
      if ("error" in c) return refuse(c.error, "invalid");
      let replaced = false;
      try {
        replaced = writeRecord(b.verdictDir, recordOf(b.launchId, c.call)).replaced;
      } catch {
        return refuse(`${VERDICT_TOOL}: the record could not be written; give the verdict in your report.`, "write_failed");
      }
      s.trace?.emit({ event: "review_verdict_call", accepted: true, verdict: c.call.verdict, items: c.call.items.length, findings: c.call.findings.length });
      const given = new Set(c.call.items.map((i) => String(i.id)));
      const left = allowed.filter((id) => !given.has(String(id)));
      return { content: [{ type: "text" as const, text: [`recorded: ${c.call.verdict}${c.call.items.length ? `, ${c.call.items.length} item result${c.call.items.length === 1 ? "" : "s"}` : ""}${c.call.findings.length ? `, ${c.call.findings.length} finding${c.call.findings.length === 1 ? "" : "s"}` : ""}.`, replaced ? "This call replaced your earlier record." : "", left.length > 0 ? `Items this call left out (they stay open): ${left.join(", ")}.` : ""].filter(Boolean).join(" ") }], details: { decision: "recorded", verdict: c.call.verdict } };
    },
  } as never);

  // Report tools (reportstool.ts, docs/retro.md): `foreman_report` is registered in every adapter process, so a child gets it through its tool list; `retro.report: false`
  // takes it off the active tools of a main session at start; a child keeps a tool its role declares, and the call refuses there. `foreman_reports` (list, group, set) is deferred and refuses in a child.
  const reportSession = (s: Session): ReportSession => {
    const expire = get(s.config.config, "retro.expireDays");
    return {
      cwd: s.cwd,
      isChild: s.isChild,
      id: s.id,
      foremanSession: s.usage.line.foremanSession,
      role: s.usage.line.role,
      launchId: s.usage.line.launchId,
      enabled: get(s.config.config, "retro.report") !== false,
      expireDays: typeof expire === "number" && expire >= 1 ? expire : undefined,
      workspaceOverride: get(s.config.config, "retro.workspaceKey"),
    };
  };
  /** `/foreman flag-ask` (askflag.ts) also writes a report: kind permission, subject the family, what the command (masked, paths cut, 300 characters); the full command stays in the trace. */
  const flagReport = async (s: Session, rec: Record<string, unknown>): Promise<"recorded" | "seen" | null> => {
    const rs = reportSession(s);
    if (!rs.enabled) return null;
    try {
      const r = recordReport({ cwd: s.cwd, role: "foreman", session: rs.foremanSession, runId: null, source: "owner", ...(rs.expireDays !== undefined ? { expireDays: rs.expireDays } : {}), ...(await reportContext(s.cwd, rs.workspaceOverride)) }, { kind: "permission", subject: rec.family, what: rec.command, effect: "slowed", suggest: rec.note });
      return r.status === "recorded" || r.status === "seen" ? r.status : null;
    } catch {
      // a report never fails the command
      return null;
    }
  };
  pi.registerTool({
    name: REPORT_TOOL,
    label: "Report a fault",
    description: REPORT_DESCRIPTION,
    parameters: REPORT_PARAMS as never,
    async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const s = await ensureSession(ctx);
      const r = await runReport(reportSession(s), params);
      if (r.event) s.trace?.emit({ event: "report", role: s.usage.line.role, ...r.event });
      return { content: [{ type: "text" as const, text: r.text }], details: { decision: r.decision }, ...(r.isError ? { isError: true } : {}) };
    },
  } as never);
  pi.registerTool({
    name: REPORTS_TOOL,
    label: "Reports",
    description: REPORTS_DESCRIPTION,
    parameters: REPORTS_PARAMS as never,
    async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const r = runReports(reportSession(await ensureSession(ctx)), params);
      return { content: [{ type: "text" as const, text: r.text }], details: { decision: r.decision }, ...(r.isError ? { isError: true } : {}) };
    },
  } as never);

  // Ledger helper (ledgercall.ts, ceremony.ledgerHelper): registered inactive; the foreman activates
  // it at session start unless the knob is off, reviewer children get it through their tool list.
  pi.registerTool({
    name: LEDGER_TOOL,
    label: "Ledger",
    defaultActive: false,
    executionMode: "sequential",
    description: "Manage the requirements ledger. Foreman: action status, mark (items: numbers, several in one call; \"V\" only after a reviewer PASS with no revision since), add (text, or texts: up to 32 items in one call), upsert ({item?, text}: replace that item's whole text keeping its state, or append a new item when item is omitted; identical text is a no-op; entries: [{item?, text}] does up to 32 in one call), note or defer ({item, text} or {items: [n], text}: exactly one item), init ({topic, texts?}: creates .workflow/LEDGER-<topic>.md with one open item per text plus item V and binds it, for a foreman without the write tool; an existing file binds only when no other ledger is bound). Every call returns ledger status.",
    parameters: { type: "object", properties: { action: { type: "string", enum: [...LEDGER_TOOL_ACTIONS] }, items: { type: "array", items: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string", enum: ["V", "v"] }] } }, item: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string", enum: ["V", "v", ""] }], description: "upsert, note, defer: the item; upsert without it appends a new item." }, texts: { type: "array", maxItems: 32, items: { type: "string" }, description: "add: several item texts, one line each, instead of text; init: one line per open item (at most 32), refused when the file exists." }, entries: { type: "array", maxItems: 32, items: { type: "object", properties: { item: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string", enum: ["V", "v"] }] }, text: { type: "string" } }, required: ["text"], additionalProperties: false }, description: "upsert: several {item?, text} entries instead of item and text; an item may appear once." }, text: { type: "string", description: "add: the item text; upsert: the new item text; note: the note; defer: the reason; mark: an optional note, given to every marked item." }, topic: { type: "string", description: "init: the ledger topic (letters, digits, . _ -); the file is .workflow/LEDGER-<topic>.md." } }, required: ["action"], additionalProperties: false } as never,
    async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const s = await ensureSession(ctx);
      const mode = ledgerHelperMode(get(s.config.config, "ceremony.ledgerHelper"));
      const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], details: { decision: "refused" }, isError: true });
      const kind = typeof params.action === "string" ? params.action : "unknown";
      // a child closes V through its verdict (review_verdict, item V), never through this tool
      if (s.isChild) return refuse(`${LEDGER_TOOL} is not available to this role.`);
      if (mode === "off") return refuse(`${LEDGER_TOOL} is off (ceremony.ledgerHelper); use the shell command ledger.`);
      if (kind === "init") {
        const r = await initLedger(s, ctx, params);
        s.trace?.emit({ event: "ledger_call", kind, allowed: r.ok });
        return r.ok ? { content: [{ type: "text" as const, text: r.text }], details: { decision: "done" } } : refuse(r.text);
      }
      const plan = planLedgerCall(params, { gate: combined(s.reviewGates), planPass: params.action === "mark" && planOnlyPass(s, ctx) });
      if ("error" in plan) {
        s.trace?.emit({ event: "ledger_call", kind, allowed: false, items: Array.isArray(params.items) ? params.items.map(String).join(",").slice(0, 60) : undefined });
        return refuse(plan.error);
      }
      if (plan.upserts) {
        // every named item must exist before anything is written (a dry run on a copy of the file)
        const file = boundLedger(s.markerDir, s.id);
        let dry: string | null = null;
        try {
          dry = file ? fs.readFileSync(file, "utf8") : null;
        } catch {
          // unreadable: refused below
        }
        let error = dry === null ? `${LEDGER_TOOL}: this session has no ledger of its own.` : "";
        for (const u of plan.upserts) {
          if (error || dry === null || u.item === null) continue;
          const r = rewriteItemText(dry, u.item, u.text);
          if ("error" in r) error = r.error;
          else dry = r.file;
        }
        if (error) {
          s.trace?.emit({ event: "ledger_call", kind, allowed: false });
          return refuse(error);
        }
      }
      const out: string[] = [];
      let ok = true;
      let traceItems = plan.items;
      // Entries are applied one by one, each taking the ledger lock itself (the lock is not reentrant); a failure stops the rest and the answer lists both sets.
      const ups = plan.upserts ?? (plan.upsert ? [plan.upsert] : []);
      const upLabel = (u: { item: string | null; text: string }): string => (u.item !== null ? `item ${u.item}` : `new "${u.text.slice(0, 40)}"`);
      const applied: string[] = [];
      const unapplied: string[] = [];
      const touched: string[] = [];
      for (const u of ups) {
        if (!ok) {
          unapplied.push(upLabel(u));
          continue;
        }
        const file = boundLedger(s.markerDir, s.id);
        let content: string | null = null;
        try {
          content = file ? fs.readFileSync(file, "utf8") : null;
        } catch {
          // unreadable: the core script reports it below
        }
        if (u.item !== null) {
          const rewrite = (): void => {
          if (!file || content === null) out.push(`${LEDGER_TOOL}: this session has no ledger of its own.`), (ok = false);
          else {
            const r = rewriteItemText(content, u.item, u.text);
            if ("error" in r) out.push(r.error), (ok = false);
            else if (!r.changed) out.push(`upsert ${u.item}: unchanged (no-op)`);
            else {
              const tmp = path.join(path.dirname(file), `.ledger-${process.pid}-${Date.now()}.tmp`);
              try {
                fs.writeFileSync(tmp, r.file, "utf8");
                try {
                  fs.chmodSync(tmp, fs.statSync(file).mode & 0o7777);
                } catch {
                  // keep the default mode
                }
                const rr = renameRetry(tmp, file);
                if (rr.error) throw rr.error;
                out.push(`upserted ${u.item}`);
                bumpLedgerRev(s);
              } catch (err) {
                try {
                  fs.rmSync(tmp, { force: true });
                } catch {
                  // best effort
                }
                out.push(`ledger: ${(err as Error).message}`);
                ok = false;
              }
            }
          }
          };
          // The ledger is read inside the lock, so a ledger.py child in flight lands first.
          if (file) {
            await ledgerGate(file).exclusive(() => {
              try {
                content = fs.readFileSync(file, "utf8");
              } catch {
                content = null;
              }
              rewrite();
            });
          } else rewrite();
        } else {
          const dup = content === null ? null : findItemByText(content, u.text);
          if (dup) {
            out.push(`upsert: item ${dup} already has this text (no-op)`);
            traceItems = dup;
          } else {
            const r = await runLedger(s, ["add", u.text], null);
            if (r.text) out.push(r.text);
            ok = ok && r.ok;
            if (r.ok) bumpLedgerRev(s);
            const n = /^added (\d+):/.exec(r.text);
            if (n) traceItems = n[1];
          }
        }
        (ok ? applied : unapplied).push(upLabel(u));
        touched.push(u.item ?? traceItems);
      }
      if (ups.length > 1) traceItems = touched.filter(Boolean).join(",");
      const added: { id: string; text: string }[] = [];
      for (const c of plan.calls) {
        const label = `add "${(c[1] ?? "").slice(0, 40)}"`;
        if (c[0] === "add" && !ok) {
          unapplied.push(label);
          continue;
        }
        const r = await runLedger(s, c, null);
        if (r.text) out.push(r.text);
        ok = ok && r.ok;
        if (r.ok && c[0] === "add") bumpLedgerRev(s);
        if (c[0] === "add") (r.ok ? applied : unapplied).push(label);
        const n = c[0] === "add" && r.ok ? /^added (\d+):/m.exec(r.text) : null;
        if (n) added.push({ id: n[1], text: c[1] ?? "" });
      }
      // A texts add traces every new number; each one is annotated with its own text below.
      if (!absent(params.texts)) traceItems = added.map((a) => a.id).join(",");
      if (!ok && unapplied.length > 0 && applied.length + unapplied.length > 1) out.push(`${LEDGER_TOOL}: stopped; applied: ${applied.join(", ") || "none"}; not applied: ${unapplied.join(", ")}.`);
      const st = await runLedger(s, ["status"], null);
      if (st.text) out.push(st.text);
      ok = ok && st.ok;
      if (plan.attested) await s.reviewSync;
      const unbound = plan.attested && ok ? headlessPass(s.reviews) : null;
      if (unbound) out.push(`Note: the reviewer PASS carries no commit (${unbound}), so the PR gate will refuse; run a reviewer again on the head before pr_create.`);
      s.trace?.emit({ event: "ledger_call", kind, allowed: true, items: traceItems || undefined, attested: plan.attested || undefined });
      // ledgerHint reads one item and no text from a list, so a texts add gives each new item its own hint.
      const hints = !absent(params.texts) ? added.map((a) => ledgerHint(kind, a.id, "", a.text)) : [ok ? ledgerHint(kind, traceItems, out.join("\n"), params.text) : null];
      for (const hint of hints) if (hint) writeHint(boundLedger(s.markerDir, s.id), hint.ids, hint.text, s.retro.hints, hintOpts(s));
      return { content: [{ type: "text" as const, text: out.join("\n") }], details: { decision: ok ? "done" : "failed" }, ...(ok ? {} : { isError: true }) };
    },
  } as never);

  /**
   * `foreman_ledger` init: a new ledger file is created exclusively and bound like a `write` of it (the binding is replaced, the diff base resets);
   * an existing file binds under the `edit` rule (no live binding, or this path) and takes no texts.
   */
  async function initLedger(s: Session, ctx: ExtensionContext, params: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const plan = planLedgerInit(params);
    if ("error" in plan) return { ok: false, text: plan.error };
    const file = path.join(s.cwd, ".workflow", `LEDGER-${plan.topic}.md`);
    if (!ownWorkPath(s, file)) return { ok: false, text: `${LEDGER_TOOL}: ${file} is outside this session's workspace.` };
    let created = false;
    if (fs.existsSync(file)) {
      if (plan.texts.length > 0) return { ok: false, text: `ledger_exists: ${file} exists; init with texts creates a new file only. Call init without texts to bind it, or add items with action add.` };
      const live = boundLedger(s.markerDir, s.id);
      const real = (p: string): string => {
        try {
          return fs.realpathSync.native(p);
        } catch {
          return path.resolve(p);
        }
      };
      if (live && real(live) !== real(file)) return { ok: false, text: `ledger_bound_elsewhere: this session is bound to ${live}; ${file} is left unbound.` };
    } else {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const t = s.ceremony;
        fs.writeFileSync(file, ledgerInitContent(plan.topic, t.triaged || t.source !== "default" ? t.tier : null, plan.texts), { encoding: "utf8", flag: "wx" });
        created = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, text: `ledger_exists: ${file} exists; call init again without texts to bind it.` };
        return { ok: false, text: `${LEDGER_TOOL}: ${(err as Error).message}` };
      }
    }
    // The write post path: ledger_bind, a new diff base for a ledger written, the tier from the header.
    const outcome = await run(s, ctx, "ledger_bind", postToolPayload("write", { path: file, file_path: file }, payloadCtx(s, ctx), false), mapTool("write").coreName);
    if (outcome.kind === "failure") return { ok: false, text: `${LEDGER_TOOL}: the ledger ${created ? "was created but " : ""}could not be bound: ${outcome.message}` };
    if (created) reviewFacts.reset();
    refreshLedgerTier(s);
    const bound = boundLedger(s.markerDir, s.id);
    // A new ledger is a subject change like a direct write of it (#264: ledger changes reopen review); binding an existing file changes nothing.
    if (created && bound) bumpLedgerRev(s);
    const st = await runLedger(s, ["status"], null);
    return { ok: !!bound && st.ok, text: [`${created ? "created" : "bound"} ${file}`, bound ? "" : "not bound: the ledger bind did not take effect.", st.text].filter(Boolean).join("\n") };
  }

  /** One core ledger.py run, bound like the bin/ledger shim (session id + marker dir); `file` adds -f. */
  async function runLedger(s: Session, args: string[], file: string | null): Promise<{ ok: boolean; text: string }> {
    const py = pyPath(s);
    if (!py) return { ok: false, text: "ledger: no usable Python (run /foreman doctor)." };
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
    env.CLAUDE_CODE_SESSION_ID = s.id;
    env.TMPDIR = s.markerDir;
    const lockFile = file ?? boundLedger(s.markerDir, s.id);
    const run = () => retryLedgerRun(() => spawner(py, ["-E", "-s", path.join(PKG_ROOT, "core", "scripts", "ledger.py"), ...(file ? ["-f", file] : []), ...args], { cwd: s.cwd, env, timeoutMs: 30_000 }), (ms) => new Promise<void>((res) => setTimeout(res, ms)));
    const r = await (lockFile ? ledgerGate(lockFile).exclusive(run) : run());
    const text = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n") || (r.error ? `ledger: ${r.error.message}` : r.timedOut ? "ledger: timed out" : "");
    return { ok: !r.error && !r.timedOut && r.code === 0, text };
  }

  // Plan checkpoint (checkpoint.ts): the owner approves the plan file; foreman only. Never approves on its own.
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.registerTool({
      name: CHECKPOINT_TOOL,
      label: "Plan checkpoint",
      // Never in parallel with other tool calls of the same message: no write lands while the owner reviews.
      executionMode: "sequential",
      description: "Ask the owner to approve a plan file (.workflow/scratch/plan-<topic>.html or plan-<topic>.md) before builders start. At tier heavy no builder launches until the owner approved the current version of the plan. The owner answers approve, revise (with a note) or reject; without an answer the checkpoint stays pending.",
      parameters: { type: "object", properties: { path: { type: "string", minLength: 1, description: "Path of the plan file, plan-<topic>.html or plan-<topic>.md in the scratch dir." } }, required: ["path"], additionalProperties: false } as never,
      async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const s = await ensureSession(ctx);
        const tier = s.ceremony.tier;
        const done = (decision: string, by: string | null, text: string, isError = false, reason?: string) => {
          s.trace?.emit({ event: "checkpoint", decision, by, tier, ...(reason ? { reason } : {}) });
          persistRounds(s);
          return { content: [{ type: "text" as const, text }], details: { decision, by }, ...(isError ? { isError: true } : {}) };
        };
        if (s.isChild) return done("refused", null, `${CHECKPOINT_TOOL} is for the foreman only.`, true);
        const configRefusal = checkpointConfigRefusal(get(s.config.config, "ceremony.checkpoint"));
        if (configRefusal) return done("refused", null, configRefusal, true, "checkpoint_parent");
        // below heavy a plan phase a parent's launch started ends with the plan review's PASS: no owner dialog opens
        if (parentPhaseByReview(s)) return done("refused", null, parentPhaseCheckpointText(isTriaged(s.ceremony)), true, "plan_phase_review");
        const r = readPlan(params.path, planOpts(s, ctx));
        if ("error" in r) return done("refused", null, r.error, true);
        const plan = r.plan;
        const name = path.basename(plan.path);
        const ruling = rulingPickup(s, `checkpoint ${name}`);
        if (ruling) return done("pending", null, `pi-foreman: a newer ruling arrived before the checkpoint press; ${name} is not presented. Act on it, then call ${CHECKPOINT_TOOL} again.\n${ruling}`);
        const hash8 = plan.hash.slice(0, 8);
        s.trace?.emit({ event: "plan_version", tier, from: sha256(plan.bytes).slice(0, 16), to: plan.hash.slice(0, 16) }); // from = hash of the file bytes, to = version (body) hash
        // ceremony.planReview (planreview.ts): a [plan-review] verdict on these bytes first; a first FAIL sends the plan back for a revision.
        let reviewed: string | null = null;
        let reviewFact = "not required";
        if (planReviewOn(s.config.config, tier)) {
          const cap = planReviewRounds(get(s.config.config, "ceremony.planReviewRounds"));
          const g = s.planReviews.gate(plan.path, plan.hash, cap);
          if ("refusal" in g) return done("refused", null, planReviewRefusalText(g.refusal, plan.rel, tier, g.stale), true, g.refusal);
          // Capped: the checkpoint opens on a FAIL with the open findings visible.
          reviewed = planReviewSection(g.verdict, await g.verdict.findings, g.capped ? { rounds: g.rounds ?? cap, cap } : undefined);
          reviewFact = g.verdict.verdict === "pass" ? "passed" : "failed";
        }
        const alreadyApproved = !!s.plan && s.plan.status === "approved" && s.plan.hash === plan.hash && s.plan.path === plan.path;
        const planPage = s.show?.checkpointed(plan.path, alreadyApproved ? "approved" : "waits for you"); // ruling point (show.ts): the plan the owner is about to see, and its page
        if (alreadyApproved && s.plan) {
          // No dialog ran: the trace carries by: null so a re-check never counts as another approval.
          return done("approve", null, `${name} (${hash8}) is already approved by the owner (${s.plan.by}, ${s.plan.approvedAt}); builders may launch while it stays unchanged.`);
        }
        // Pending first: a crash, an abort or no answer leaves it pending, never approved.
        const rec: PlanRecord = { topic: plan.topic, path: plan.path, hash: plan.hash, status: "pending", approvedAt: null, by: null };
        s.plan = rec;
        s.waitingForParent = true; // pending: the owner answers; the finish gate lets the turn end until the next input
        const pendingText = `No answer from the owner; the checkpoint of ${name} (${hash8}) stays pending — ask the owner in your reply. Builders stay refused at tier heavy until the owner approves (call ${CHECKPOINT_TOOL} again).`;
        // The owner answers in this session's own pane, also in a session opened by another session: no file from a parent approves a plan.
        if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return done("pending", null, pendingText);
        let answer: string | undefined;
        s.trace?.emit({ event: "dialog", surface: "checkpoint" });
        try {
          const page = await planPageOutcome(planPage, undefined, showOffReason(!!s.live, s.id));
          ctx.ui.notify(`${ownerSummary(plan.markdown)}\n${planPageLineOf(page)}\n\n${planSummary(plan.markdown, plan.rel, plan.hash)}${reviewed ? `\n${reviewed}` : ""}`, "info");
          const spec: DialogSpec = {
            ask: `Approve the plan for ${plan.topic}?`,
            summary: "Builders start only after you approve. Read the plan page first.",
            facts: [["Plan", planSummary(plan.markdown, plan.rel, plan.hash).split("\n")[0].replace(/^Plan:\s*(?:Plan:\s*)?/i, "")], ["Version", hash8], ["Review", reviewFact]],
            ...("path" in page ? { links: [{ label: "Plan page", path: page.path, text: "open the plan page", kind: "page" as const }], detail: ["The page is a path on this session's machine."] } : { detail: [`Plan page: not available (${page.reason})`] }),
            answers: "revise: you say what to change   reject: the work stops   approve: builders start",
          };
          answer = await withBlockedOn(herdrEvents, BLOCK_CHECKPOINT, cleanDialogText(spec.ask), () => shapedSelect(ctx.ui, ctx.mode, spec, [...CHECKPOINT_CHOICES], { signal }));
        } catch {
          answer = undefined;
        }
        // A newer checkpoint replaced this one while the dialog was open: this answer is not applied.
        if (s.plan !== rec || answer === undefined || !(CHECKPOINT_CHOICES as readonly string[]).includes(answer)) return done("pending", null, pendingText);
        s.waitingForParent = false; // the owner answered
        if (answer === "approve") {
          // The owner approved what was on disk during the dialog: approve only if those are still the bytes hashed above.
          if (currentPlanHash(rec, planOpts(s, ctx)) !== rec.hash) {
            return done("pending", null, `${name} changed while the owner was reviewing it, so the approval is not applied: the checkpoint stays pending. Call ${CHECKPOINT_TOOL} again so the owner approves the current version.`);
          }
          s.show?.planDecided("approved", rec.hash);
          rec.status = "approved";
          rec.source = "dialog";
          rec.approvedAt = new Date().toISOString();
          rec.by = ctx.mode === "tui" ? "user" : "rig";
          // the owner's dialog answer is kept in the harness-only approval store, keyed by the plan version hash
          saveStored(s.agentDir, rec.hash, rec.topic, { approval: { at: rec.approvedAt, by: rec.by } });
          if (s.planPhase) {
            s.planPhase = false; // an approval ends the plan phase
            delete process.env.PI_FOREMAN_PLAN_PHASE;
            s.trace?.emit({ event: "plan_phase", decision: "off", cause: "checkpoint" });
          }
          s.live?.recordCheckpoint("approve");
          return done("approve", rec.by, `The owner approved ${name} (${hash8}). Builders may launch at tier heavy while the file stays unchanged; any edit needs a new ${CHECKPOINT_TOOL}.`);
        }
        if (answer === "revise") {
          let note: string | undefined;
          try {
            note = await withBlockedOn(herdrEvents, BLOCK_CHECKPOINT, "What should change?", () => ctx.ui.input("What should change?", undefined, { signal }));
          } catch {
            note = undefined;
          }
          rec.status = "revise";
          s.show?.planDecided("revise", rec.hash);
          if (note && note.trim()) rec.note = note.trim();
          s.live?.recordCheckpoint("revise");
          return done("revise", null, `The owner asked for a revision of ${name}. The owner's words:\n${rec.note ?? "(no note given)"}\nChange the plan (edit it), then call ${CHECKPOINT_TOOL} again. Builders stay refused at tier heavy until the owner approves.`);
        }
        rec.status = "rejected";
        s.show?.planDecided("rejected", rec.hash);
        ctx.ui.notify(`pi-foreman: ${name} was rejected; the heavy path is stopped (no builder launches until a new plan is approved).`, "warning");
        s.live?.recordCheckpoint("reject");
        return done("reject", null, `The owner rejected ${name}. The heavy path is stopped: launch no builder; report to the owner and ask how to go on. A new plan needs a new ${CHECKPOINT_TOOL} approval.`);
      },
    } as never);
  }

  // Owner script (scriptapproval.ts, scriptrun.ts): the owner approves a script's bytes in a dialog, the harness runs them. Never in a
  // subagent child, never approved without the owner's own answer (no ruling file, no timeout). The harness only looks for the dry-run and undo marker literals in the script text; it does not judge it.
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.registerTool({
      name: SCRIPT_TOOL,
      label: "Owner script",
      // Never in parallel with other tool calls of the same message: no write lands while the owner decides or the script runs. A real run whose tool call is aborted (Escape) is the one exception: it runs on in the background (s.scriptRun), and while it lives every other action but status and stop is refused, so no second script and no dry run or undo overlaps it.
      executionMode: "sequential",
      description: "Ask the owner to approve a script for a change the guards close to every agent (user config, global installs, protected files), then run it. Write the script into the scratch dir: POSIX sh, LF line endings, no reliance on $0 or sibling files (the harness runs a private copy from the workspace root, stdin closed), and it must honour --dry-run or DRY_RUN=1 by changing nothing on that run. propose (path, description, risk, undo) opens the owner's dialog (approve, revise with a note, reject); on approve the dry run runs at once and its output is returned. Read the dry-run output before run: when it shows an unexpected state or a different change than described, stop and propose again with a corrected description. dry reruns the dry run, run is the real run (it needs a passed dry run of the same text), status shows the proposal and the undo state, undo runs the script that really ran with the single argument undo (only when the script has the marker line `# foreman-undo: supported` as a whole line, after a real run, within an hour of it, at most three attempts, exit 0 counts once; no second dialog, the owner gets a notice); stop ends a real run that keeps running in the background after its call was aborted; these five take no path. When the owner aborts the call of a real run (Escape), the script is not killed: the call returns at once, the script runs on until it ends or hits its time limit, its result arrives as a message, and until then only status and stop are accepted. A small fix of the script after approval reruns with a notice to the owner, a larger one needs a new propose. Without an answer the proposal stays pending.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["propose", "dry", "run", "status", "undo", "stop"] },
          path: { type: "string", minLength: 1, description: "propose only: path of the script in the scratch dir." },
          description: { type: "string", description: "propose only: one paragraph on what the script changes, at most 600 characters; the owner sees it whole." },
          risk: { type: "string", description: "propose only: what can go wrong, at most 300 characters." },
          undo: { type: "string", description: "propose only: how the change is undone, at most 300 characters." },
          timeoutSeconds: { type: "number", minimum: 1, maximum: 3600, description: "Time limit of the run, default 600." },
        },
        required: ["action"],
        additionalProperties: false,
      } as never,
      async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const s = await ensureSession(ctx);
        const out = (decision: string, text: string, extra: Record<string, unknown> = {}, isError = false) => ({ content: [{ type: "text" as const, text }], details: { decision, ...extra }, ...(isError ? { isError: true } : {}) });
        const refusal = (r: { code: ScriptRefusalCode; error: string }) => out("refused", r.error, { code: r.code }, true);
        if (s.isChild) return refusal({ code: "script_child", error: `pi-foreman: ${SCRIPT_TOOL} refused (script_child): a subagent child never proposes, runs or undoes an owner script; report the needed change to the foreman.` });
        const o = planOpts(s, ctx);
        const action = params.action;
        const running = s.scriptRun;
        if (running && (action === "propose" || action === "dry" || action === "run" || action === "undo")) return refusal({ code: "script_running", error: `pi-foreman: ${SCRIPT_TOOL} refused (script_running): an owner script is still running (pid ${running.pid ?? "unknown"}, since ${new Date(running.since).toISOString()}); its result arrives as a message. status shows it, stop ends it.` });

        /** What a finished dry or real run records and reports: state, trace, the text for the model. */
        const finishRun = (kind: ScriptRunAction, plan: { hash: string }, r: ScriptRunResult) => {
          const exit = r.error ? null : r.exitCode;
          if (kind === "run" && r.started && (s.script.proposal?.status === "approved" || s.script.proposal?.status === "dry_ok")) recordRealRun(s.script, plan.hash, Date.now());
          const status = recordRun(s.script, kind, plan.hash, exit);
          s.trace?.emit({ event: "script_run", kind, hash: shortHash(plan.hash), exit, seconds: r.seconds, ...(r.stopped ? { outcome: "stopped" } : r.aborted ? { outcome: "aborted" } : {}) });
          const p = s.script.proposal;
          const how = r.error ?? (r.timedOut ? "stopped at the time limit" : r.stopped ? "stopped by the stop action" : r.aborted ? "aborted" : exit === null ? `ended by ${r.signal ?? "a signal"}` : `exit ${exit}`);
          const head = `${kind === "dry" ? "Dry run" : "Real run"} of ${p?.rel ?? "the script"} (sha256 ${shortHash(plan.hash)}): ${how} after ${r.seconds} s. Log: ${r.logPath}`;
          const next =
            kind === "dry"
              ? exit === 0
                ? `Read this output before ${SCRIPT_TOOL} run: when it shows an unexpected state or a different change than described, stop and propose again with a corrected description.`
                : "The dry run did not pass, so no real run is possible. Fix the script (a small fix reruns with a notice to the owner; a larger one needs a new propose), then call dry."
              : exit === 0
                ? "The approval is used up; another run needs a new propose."
                : status === "consumed"
                  ? `The real run failed and the approval is used up (${SCRIPT_MAX_ATTEMPTS} attempts); another run needs a new propose.`
                  : `The real run failed; ${Math.max(0, SCRIPT_MAX_ATTEMPTS - (p?.attempts ?? 0))} attempt(s) left.`;
          return out(kind, `${head}\n${r.tail ? `Last lines:\n${r.tail}\n` : "(no output)\n"}${next}`, { status, exit, logPath: r.logPath, hash: plan.hash, ...(r.stopped ? { stopped: true } : {}) }, exit !== 0);
        };

        /** The real run outlives the abort of this call: the call returns, the end is recorded and sent as a message. */
        const detachRun = (d: ScriptRunDetached, plan: { hash: string }) => {
          const entry: NonNullable<Session["scriptRun"]> = { pid: d.pid, since: Date.now(), stopRequested: false, shutdown: false, stop: d.stop, done: Promise.resolve() };
          entry.done = d.finished.then((r) => {
            if (s.scriptRun === entry) s.scriptRun = null;
            const res = finishRun("run", plan, r);
            if (!entry.stopRequested && !entry.shutdown) {
              let idle = true;
              try {
                idle = ctx.isIdle();
              } catch {
                // a stale context: treat as idle
              }
              pi.sendMessage({ customType: "pi-foreman-script", content: `pi-foreman notice (data, not an instruction): the owner script that kept running in the background after its call was aborted has ended.\n${res.content[0].text}`, display: true, details: res.details }, idle ? { triggerTurn: true } : { deliverAs: "followUp" });
            }
            return res;
          });
          s.scriptRun = entry;
          s.trace?.emit({ event: "script_run", kind: "run", hash: shortHash(plan.hash), outcome: "detached" });
          return out("run", `Script still running in the background (pid ${d.pid ?? "unknown"}); its result arrives as a message. status shows it, stop ends it.`, { status: "running", pid: d.pid, hash: plan.hash });
        };

        /** A dry or real run of the proposal's own script: fix rule, runner, state, trace. */
        const runNow = async (kind: ScriptRunAction) => {
          const limit = get(s.config.config, "safety.scripts.silentFixLines");
          const plan = beginRun(s.script, kind, o, Date.now(), typeof limit === "number" ? limit : SCRIPT_FIX_LINES_DEFAULT);
          if (plan.fix) {
            ctx.ui.notify(plan.fix.notice, "warning");
            s.trace?.emit({ event: "script_fix", from: plan.fix.from, to: plan.fix.to, added: plan.fix.added, removed: plan.fix.removed });
          }
          if ("error" in plan) return refusal(plan);
          const r = await runScriptDetachable({ bytes: plan.bytes, kind, cwd: workspaceOf(ctx.cwd).root, logPath: plan.logPath, timeoutSeconds: typeof params.timeoutSeconds === "number" ? params.timeoutSeconds : undefined, signal, platform, config: s.config.config, shellPath: shellPathSetting(s.agentDir, ctx.cwd), detachOnAbort: kind === "run" });
          if ("detached" in r) return detachRun(r, plan);
          if ("code" in r) {
            // refused before anything spawned: not one of the real attempts
            if (kind === "run" && s.script.proposal) s.script.proposal.attempts = Math.max(0, s.script.proposal.attempts - 1);
            return refusal(r);
          }
          return finishRun(kind, plan, r);
        };

        /** An undo run of the stored bytes that really ran: no dialog, a warning notice and a trace event per attempt. */
        const undoNow = async () => {
          const plan = beginUndo(s.script, o, Date.now());
          if ("error" in plan) return refusal(plan);
          ctx.ui.notify(`Undo of ${cleanText(s.script.proposal?.rel ?? "the script")} through foreman_script: running the script that ran (sha256 ${shortHash(plan.hash)}) with the argument undo, attempt ${plan.attempt} of ${SCRIPT_MAX_ATTEMPTS}.`, "warning");
          const r = await runOwnerScript({ bytes: plan.bytes, kind: "undo", cwd: workspaceOf(ctx.cwd).root, logPath: plan.logPath, timeoutSeconds: typeof params.timeoutSeconds === "number" ? params.timeoutSeconds : undefined, signal, platform, config: s.config.config, shellPath: shellPathSetting(s.agentDir, ctx.cwd) });
          if ("code" in r || !r.started) {
            // nothing spawned (refused or aborted before the start): not one of the attempts
            const up = s.script.proposal;
            if (up) {
              up.undoAttempts = Math.max(0, up.undoAttempts - 1);
              up.logCounts.undo = Math.max(0, up.logCounts.undo - 1);
              up.logs.pop();
            }
            if ("code" in r) return refusal(r);
            return out("undo", `Undo of ${up?.rel ?? "the script"} did not start (${r.error ?? (r.aborted ? "aborted" : "not started")}); the attempt is given back.`, { hash: plan.hash }, true);
          }
          const exit = r.error ? null : r.exitCode;
          recordUndo(s.script, plan.hash, exit);
          s.trace?.emit({ event: "script_run", kind: "undo", hash: shortHash(plan.hash), attempts: plan.attempt, exit, seconds: r.seconds });
          const p = s.script.proposal;
          const how = r.error ?? (r.timedOut ? "stopped at the time limit" : r.aborted ? "aborted" : exit === null ? `ended by ${r.signal ?? "a signal"}` : `exit ${exit}`);
          const next = exit === 0 ? "The undo is done; it counts once." : plan.attempt >= SCRIPT_MAX_ATTEMPTS ? "The undo failed and no attempt is left; a new propose is the way." : `The undo failed; ${SCRIPT_MAX_ATTEMPTS - plan.attempt} attempt(s) left.`;
          return out("undo", `Undo of ${p?.rel ?? "the script"} (sha256 ${shortHash(plan.hash)}), attempt ${plan.attempt} of ${SCRIPT_MAX_ATTEMPTS}: ${how} after ${r.seconds} s. Log: ${r.logPath}\n${r.tail ? `Last lines:\n${r.tail}\n` : "(no output)\n"}${next}`, { exit, logPath: r.logPath, hash: plan.hash }, exit !== 0);
        };

        if (action === "dry" || action === "run" || action === "status" || action === "undo") {
          if (params.path !== undefined) return refusal({ code: "script_path", error: `pi-foreman: ${SCRIPT_TOOL} refused (script_path): ${action} takes no path; it uses the script of the proposal. A different script needs a new propose.` });
          if (action === "undo") return undoNow();
          if (action !== "status") return runNow(action);
          const st = scriptStatus(s.script, Date.now());
          const live = s.scriptRun ? { pid: s.scriptRun.pid ?? null, since: new Date(s.scriptRun.since).toISOString() } : null;
          return out("status", st ? JSON.stringify(live ? { ...st, running: live } : st, null, 2) : "No script is proposed in this session.", { status: live ? "running" : st?.status ?? null });
        }
        if (action === "stop") {
          if (params.path !== undefined) return refusal({ code: "script_path", error: `pi-foreman: ${SCRIPT_TOOL} refused (script_path): stop takes no path.` });
          if (!running) return out("refused", `${SCRIPT_TOOL}: no owner script is running in the background; there is nothing to stop.`, {}, true);
          running.stopRequested = true;
          running.stop("stopped");
          return (await running.done) as ReturnType<typeof out>;
        }
        if (action !== "propose") return out("refused", `${SCRIPT_TOOL}: action must be propose, dry, run, status, undo or stop.`, {}, true);

        const done = (decision: string, by: string | null, hash: string | null, text: string, isError = false) => {
          s.trace?.emit({ event: "script", decision, by, hash });
          return out(decision, text, { by }, isError);
        };
        const proposed = proposeScript(s.script, params, o);
        if ("error" in proposed) return done("refused", null, null, proposed.error, true);
        // Pending first: a crash, an abort or no answer leaves it pending, never approved.
        const p = proposed.proposal;
        const short = shortHash(p.hash);
        const pendingText = `No answer from the owner; the proposal of ${p.rel} (${short}) stays pending and nothing ran — ask the owner in your reply, then call ${SCRIPT_TOOL} propose again.`;
        // Only the owner's own answer in this session's dialog approves: no ruling file, no parent verdict, no timeout.
        if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return done("pending", null, short, pendingText);
        const title = scriptSelectTitle(p);
        s.trace?.emit({ event: "dialog", surface: "script" });
        let answer: string | undefined;
        try {
          // One notice: the terminal replaces an info status line by the next one sent back to back.
          ctx.ui.notify([...scriptNoticeLines(p), scriptUndoLine(p)].join("\n"), "info");
          const spec: DialogSpec = {
            ask: title,
            summary: p.description,
            facts: [["Risk", p.risk], ["Undo", p.undo]],
            detail: [`Path: ${cleanText(p.rel)} (${p.lines} lines)`, scriptUndoLine(p)],
            answers: "approve: the dry run runs first   revise: you say what to change   reject: nothing runs",
          };
          answer = await withBlockedOn(herdrEvents, BLOCK_SCRIPT, title, () => shapedSelect(ctx.ui, ctx.mode, spec, [...SCRIPT_CHOICES], { signal }));
        } catch {
          answer = undefined;
        }
        // A newer proposal replaced this one while the dialog was open: this answer is not applied.
        if (s.script.proposal !== p || answer === undefined || !(SCRIPT_CHOICES as readonly string[]).includes(answer)) return done("pending", null, short, pendingText);
        if (answer === "reject") {
          decideScript(s.script, { kind: "reject" }, o, Date.now());
          return done("reject", null, short, `The owner rejected ${p.rel}. Nothing ran: do not make this change another way; report to the owner and ask how to go on.`);
        }
        if (answer === "revise") {
          let note: string | undefined;
          try {
            note = await withBlockedOn(herdrEvents, BLOCK_SCRIPT, "What should change?", () => ctx.ui.input("What should change?", undefined, { signal }));
          } catch {
            note = undefined;
          }
          decideScript(s.script, { kind: "revise", note: note ?? "" }, o, Date.now());
          return done("revise", null, short, `The owner asked for a revision of ${p.rel}. The owner's words:\n${p.note || "(no note given)"}\nNothing ran. Change the script or its description, then call ${SCRIPT_TOOL} propose again.`);
        }
        // The owner approved the bytes whose hash the dialog showed: other bytes on disk now leave the proposal pending.
        const decided = decideScript(s.script, { kind: "approve" }, o, Date.now());
        if ("error" in decided) return done("pending", null, short, decided.error);
        const by = ctx.mode === "tui" ? "user" : "rig";
        s.trace?.emit({ event: "script", decision: "approve", by, hash: short });
        const dry = await runNow("dry");
        return { ...dry, content: [{ type: "text" as const, text: `The owner approved ${p.rel} (sha256 ${short}).\n${dry.content[0].text}` }], details: { ...dry.details, decision: "approve", by } };
      },
    } as never);
  }

  // ---------------------------------------------------------------- commands

  pi.registerCommand("ceremony", {
    description: "Show or set the ceremony tier: /ceremony [trivial|standard|heavy]",
    handler: async (args, ctx) => {
      const s = await ensureSession(ctx);
      const want = args.trim().toLowerCase();
      if (!want) {
        ctx.ui.notify(tierLine(s.ceremony), "info");
        return;
      }
      if (!isTier(want)) {
        ctx.ui.notify("Usage: /ceremony trivial|standard|heavy", "warning");
        return;
      }
      setCeremony(s, userOverride(s.ceremony, want));
      s.tally = emptyTally();
      ctx.ui.notify(tierLine(s.ceremony), "info");
    },
  });

  /** Run one scripts/*.py of the package with the resolved interpreter; the text to show. */
  async function runScript(s: Session, script: string, args: string[], timeoutMs = 60_000, input?: string, signal?: AbortSignal): Promise<{ text: string; ok: boolean }> {
    const py = pyPath(s);
    if (!py) return { text: `${script}: no usable Python (run /foreman doctor).`, ok: false };
    const r = await spawner(py, ["-E", "-s", path.join(PKG_ROOT, "scripts", script), ...args], { timeoutMs, cwd: s.cwd, input, signal });
    const text = (r.stdout.trim() || r.stderr.trim() || `${script} produced no output.`);
    return { text, ok: !r.error && !r.timedOut && r.code === 0 };
  }

  pi.registerCommand("retro", {
    description: "Friction metrics of this session and permission-allow proposals (foreman only); --model adds a foreman-written section (one turn)",
    handler: async (args, ctx) => {
      const s = await ensureSession(ctx);
      if (s.isChild) {
        ctx.ui.notify("/retro is for the foreman only.", "warning");
        return;
      }
      if (/(?:^|\s)--model(?:\s|$)/.test(args) && (!retroEnabled(get(s.config.config, "retro.enabled"), ctx.mode) || (ctx.mode !== "tui" && ctx.mode !== "rpc"))) {
        ctx.ui.notify("pi-foreman: /retro --model is off (retro is disabled or this is not an interactive session).", "warning");
        return;
      }
      const day = new Date().toISOString().slice(0, 10);
      const argv = [...retroInputs(s, ctx, "--session"), "--proposals-out", path.join(s.agentDir, "pi-foreman", "state", "retro", `permission-proposals-${day}.json`)];
      const r = await runScript(s, "foreman_retro.py", argv);
      const suggestLine = suggestHint(s.agentDir);
      if (suggestLine && r.ok) r.text = `${r.text}\n${suggestLine}`;
      const clearLine = readClearHint(s.agentDir);
      if (clearLine && r.ok) r.text = `${r.text}\n${clearLine}`;
      ctx.ui.notify(r.text, r.ok ? "info" : "error");
      let file: string | null = null;
      try {
        file = appendStateRetro(path.join(s.agentDir, "pi-foreman", "state"), s.id, r.text);
      } catch (err) {
        ctx.ui.notify(`pi-foreman: could not write the retro file: ${(err as Error).message}`, "warning");
      }
      // D8 (12): --model asks the foreman for one reply of at most 10 lines; agent_end appends it.
      if (file && /(?:^|\s)--model(?:\s|$)/.test(args)) {
        if (!ctx.isIdle()) return ctx.ui.notify("pi-foreman: /retro --model runs only while the foreman is idle; the metrics were written.", "warning");
        s.retro.modelFile = file;
        let limits: string | null = null;
        const limitsPath = knownLimitsArg(args);
        if (limitsPath) {
          try {
            limits = fs.readFileSync(limitsPath, "utf8");
          } catch {
            limits = null; // a missing file adds no block
          }
        }
        // followUp: a turn already started (isIdle raced) finishes before the retro request runs.
        pi.sendUserMessage(modelRetroPrompt(limits), { deliverAs: "followUp" });
      }
    },
  });
  pi.on("agent_end", async (event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild || !s.retro.modelFile) return;
    const file = s.retro.modelFile;
    s.retro.modelFile = null;
    try {
      appendModelRetro(file, lastAssistantText(event.messages));
      ctx.ui.notify(`pi-foreman: model retro appended to ${file}`, "info");
    } catch (err) {
      ctx.ui.notify(`pi-foreman: could not append the model retro: ${(err as Error).message}`, "warning");
    }
  });

  /** Retro inputs of this session (agent dir, review log, usage, session file, trace). */
  function retroInputs(s: Session, ctx: ExtensionContext, sessionFlag: string): string[] {
    const args = ["--agent-dir", s.agentDir, "--usage", s.usage.file];
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) args.push(sessionFlag, sessionFile);
    if (s.trace) args.push("--trace", s.trace.file);
    // Bound children of this session trace to trace-<launchId>.jsonl (retro.ts sessionTrace).
    for (const id of s.launches.keys()) {
      const f = traceFile(get(s.config.config, "trace.dir"), s.markerDir, id);
      if (fs.existsSync(f)) args.push("--trace", f);
    }
    // The bridge logs cost 0: pass registry rates of the logged models (a file, not the command line).
    try {
      const rates: Record<string, unknown> = {};
      for (const l of readUsage(s.agentDir, { session: s.id }).filter(isCostLine)) {
        const rate = lookupRate(ctx.modelRegistry as never, l.provider, l.model);
        if (rate) rates[`${l.provider}/${l.model}`] = rate;
      }
      if (Object.keys(rates).length) {
        const ratesFile = path.join(s.agentDir, "pi-foreman", "state", "retro", "rates.json");
        fs.mkdirSync(path.dirname(ratesFile), { recursive: true });
        fs.writeFileSync(ratesFile, JSON.stringify(rates));
        args.push("--rates", ratesFile);
      }
    } catch {
      // no rates: the logged cost is kept
    }
    return args;
  }

  /** scripts/foreman_close.py report + cleanup for `/foreman close` (`## Close` into `file`); close.json as fallback. */
  async function closeReport(s: Session, ctx: ExtensionContext, file: string): Promise<CloseReport | null> {
    const stateDir = path.join(s.agentDir, "pi-foreman", "state");
    const args = closeReportArgs({ sessionId: s.id, stateDir, cwd: s.cwd, file, trusted: safeTrusted(ctx) });
    const r = await runScript(s, "foreman_close.py", args, 600_000);
    try {
      const parsed = parseCloseReport(JSON.parse(r.text));
      if (parsed) return parsed;
    } catch {
      // not JSON: read what the script wrote
    }
    return readCloseJson(stateDir, s.id);
  }

  /** scripts/foreman_sync.py for this session (/sync and remote close). */
  function runSync(s: Session, ctx: ExtensionContext, extra: string[] = []): Promise<{ text: string; ok: boolean }> {
    const args = ["--cwd", s.cwd, "--state", path.join(s.agentDir, "pi-foreman", "state"), "--session", s.id, ...retroInputs(s, ctx, "--session-file"), ...extra];
    if (safeTrusted(ctx)) args.push("--trusted-project");
    return runScript(s, "foreman_sync.py", args, 600_000);
  }

  pi.registerCommand("sync", {
    description: "Pull, commit (explicit paths) and push the configured sync.repos, then the retro (foreman only)",
    handler: async (args, ctx) => {
      const s = await ensureSession(ctx);
      if (s.isChild) {
        ctx.ui.notify("/sync is for the foreman only.", "warning");
        return;
      }
      const words = args.trim().split(/\s+/).filter(Boolean);
      const extra = words.filter((w) => w === "--dry-run");
      if (extra.length < words.length) ctx.ui.notify(`pi-foreman: /sync ignores ${words.filter((w) => w !== "--dry-run").join(" ")} (only --dry-run is accepted).`, "warning");
      await syncCommand({ activeRuns: s.activeRuns.size, run: async () => { const r = await runSync(s, ctx, extra.slice(0, 1)); return { ...r, text: withNudge(r.text, s.agentDir, get(s.config.config, "knowledge.nudgeDays")) }; }, notify: (t, l) => ctx.ui.notify(t, l) });
    },
  });

  pi.registerCommand("foreman", {
    description: "pi-foreman commands: /foreman doctor [warm] | /foreman status | /foreman waits | /foreman cost [workspace] | /foreman budget lift | /foreman update-check | /foreman setup [args] | /foreman config apply-preset <name> [--foreman <model id>] [--dry-run] | /foreman config validate | /foreman close [result-path] | /foreman session open|brief|close|list | /foreman plan [off] | /foreman trust bridge | /foreman perms mode|reload|list",
    handler: async (args, ctx) => {
      const [sub = "", ...rest] = args.trim().split(/\s+/);
      if (sub === "close") return close.command(args.trim().slice(sub.length), ctx);
      if (sub === "plan") {
        const s = await ensureSession(ctx);
        if (s.isChild || rest.length > 1 || (rest[0] !== undefined && rest[0] !== "off")) {
          ctx.ui.notify("Usage: /foreman plan | /foreman plan off (foreman session only)", "warning");
          return;
        }
        s.planPhase = rest[0] !== "off";
        if (s.planPhase) s.planPhaseOrigin = "owner"; // the owner's phase, also inside a child: a plan-review PASS never ends it
        else delete process.env.PI_FOREMAN_PLAN_PHASE;
        s.trace?.emit({ event: "plan_phase", decision: s.planPhase ? "on" : "off", cause: "user" });
        persistCeremonyState(s);
        ctx.ui.notify(s.planPhase ? "pi-foreman: plan phase on. Changes only under .workflow/, explorers need no ledger, builders wait for a checkpoint approval or /foreman plan off." : "pi-foreman: plan phase off.", "info");
        return;
      }
      if (sub === "session") return sessionCmd.command(args.trim().slice(sub.length), ctx);
      if (sub === "trust") {
        const s = await ensureSession(ctx);
        if (s.isChild || rest.length !== 1 || rest[0] !== "bridge") {
          ctx.ui.notify("Usage: /foreman trust bridge (foreman session only)", "warning");
          return;
        }
        // the owner's confirm dialog only: no auto review, no model answer
        ctx.ui.notify(await trustBridgeCommand(s.agentDir, s.cwd, projectBridgeConfigRisks(s.cwd), { hasUI: ctx.hasUI, mode: ctx.mode, confirm: blockedConfirmOn(herdrEvents, BLOCK_CONFIRM, (title, msg) => ctx.ui.confirm(title, msg)) }), "info");
        return;
      }
      if (sub === "perms") {
        const s = await ensureSession(ctx);
        if (rest[0] === "suggest" || rest[0] === "review" || rest[0] === "adopt") {
          ctx.ui.notify(await workshopCommand(s, ctx, rest), "info");
          return;
        }
        if (rest[0] === "protect") {
          const usage = "Usage: /foreman perms protect add|remove <host|path|command> <glob> [--check model|read-only|ask] [--note <text>] [--user] (--check is for add only; to change an entry, remove it and add it again)";
          let args = rest.slice(1);
          // `--check <mode>` comes out of the words first: `--note` takes every word after it
          let check: string | undefined;
          const ci = args.indexOf("--check");
          if (ci >= 0) {
            check = args[ci + 1];
            args = [...args.slice(0, ci), ...args.slice(ci + 2)];
            if (check === undefined || !PROTECTED_CHECK_MODES.includes(check as never) || args[0] === "remove") {
              ctx.ui.notify(usage, "warning");
              return;
            }
          }
          const user = args.includes("--user");
          const ni = args.indexOf("--note");
          const note = ni >= 0 ? args.slice(ni + 1).filter((w) => w !== "--user").join(" ") : undefined;
          const head = (ni >= 0 ? args.slice(0, ni) : args).filter((w) => w !== "--user");
          if (head.length < 3 || (ni >= 0 && !note)) {
            ctx.ui.notify(usage, "warning");
            return;
          }
          const r = await protectEntry(s, ctx, { action: head[0], kind: head[1], glob: head.slice(2).join(" "), ...(note ? { note } : {}), ...(check ? { check } : {}), file: user ? "user" : "project" });
          ctx.ui.notify(r.text, r.ok ? "info" : "warning");
          return;
        }
        ctx.ui.notify(permsCommand(s, rest), "info");
        return;
      }
      if (sub === "budget") {
        const s = await ensureSession(ctx);
        if (rest[0] !== "lift" || s.isChild) {
          ctx.ui.notify("Usage: /foreman budget lift (foreman session only)", "warning");
          return;
        }
        ctx.ui.notify("pi-foreman: the read budget only reminds; it never refuses a read, so there is nothing to lift.", "info");
        return;
      }
      if (sub === "flag-ask") {
        const s = await ensureSession(ctx);
        const rec = askFlag.flag(s.id, rest.join(" "));
        if (rec) s.trace?.emit(rec);
        const reportState = rec ? await flagReport(s, rec) : null;
        ctx.ui.notify(rec ? `pi-foreman: flagged the last answered ask (${rec.family}${s.trace ? "" : `; tracing is off, ${reportState === "recorded" ? "the report was written" : reportState === "seen" ? "the report already exists" : "nothing was written"}`}).` : "pi-foreman: no ask answered in this session yet; nothing flagged.", rec ? "info" : "warning");
        return;
      }
      if (sub === "dialogs") {
        const s = await ensureSession(ctx);
        if (!rest.includes("--json")) {
          ctx.ui.notify("Usage: /foreman dialogs --json", "warning");
          return;
        }
        ctx.ui.notify(dialogsJson(s.trace), "info");
        return;
      }
      if (sub === "cost") {
        const s = await ensureSession(ctx);
        const json = rest.includes("--json");
        const all = rest.includes("--all");
        const ws = rest.filter((w) => w !== "--json" && w !== "--all").join(" ").trim();
        const wsPath = ws ? workspaceOf(path.resolve(ctx.cwd, ws)).root : all ? workspaceOf(s.cwd).root : "";
        syncKeepalives(s, ctx);
        if (json) {
          const scoped = ws || all;
          const jl = scoped ? readUsage(s.agentDir, { workspace: wsPath }) : readUsage(s.agentDir, { session: s.usage.line.foremanSession });
          ctx.ui.notify(JSON.stringify(costReport(jl, loadPrices(PKG_ROOT), scoped ? `all sessions in ${wsPath}` : `session ${s.usage.line.foremanSession}`), null, 2), "info");
          return;
        }
        const lines = ws ? readUsage(s.agentDir, { workspace: wsPath }) : readUsage(s.agentDir, { session: s.usage.line.foremanSession });
        const title = ws ? `pi-foreman cost: all sessions in ${wsPath}` : `pi-foreman cost: session ${s.usage.line.foremanSession}`;
        ctx.ui.notify(formatSummary(aggregate(lines, loadPrices(PKG_ROOT)), title), "info");
        return;
      }
      if (sub === "update-check") {
        const s = await ensureSession(ctx);
        const r = await runScript(s, "foreman_update_check.py", []);
        ctx.ui.notify(withNudge(r.text, s.agentDir, get(s.config.config, "knowledge.nudgeDays")), r.ok ? "info" : "error");
        return;
      }
      if (sub === "status") {
        const s = await ensureSession(ctx);
        const open = s.isChild ? 0 : waits.active(s.id).length;
        ctx.ui.notify([pressureStatusLine(pressureOf(s), pressureNow()), `open waits: ${open}`, `tier: ${s.ceremony.tier}`, `deferred tools: ${deferred.hidden.length}`].join("\n"), "info");
        return;
      }
      if (sub === "waits") {
        const s = await ensureSession(ctx);
        const addon = addonPresent(pi.getAllTools().map((t) => t.name), { agentDir: s.agentDir, cwd: ctx.cwd });
        ctx.ui.notify(formatWaits(s.isChild ? [] : waits.active(s.id), addon ? readAddonTasks(ctx.cwd) : []), "info");
        return;
      }
      if (sub === "setup") {
        const s = await ensureSession(ctx);
        const inv = setupInvocation(PKG_ROOT, args.trim().slice(sub.length), s.agentDir);
        const r = await spawner(inv.command, inv.args, { timeoutMs: 300_000, cwd: s.cwd, env: inv.env });
        const ok = !r.error && !r.timedOut && r.code === 0;
        ctx.ui.notify([r.stdout.trim(), r.stderr.trim(), ...hubWorkflowDriftLines({ hubWorkflow: get(s.config.config, "paths.hubWorkflow") }), ...(classifierTarget(s.config.config, ctx.model?.provider, ctx.modelRegistry as never) ? [] : [`WARN ${noClassifierModelText(ctx.model?.provider)}`])].filter(Boolean).join("\n") || (r.error ? `setup.mjs: ${r.error.message}` : r.timedOut ? "setup.mjs timed out." : "setup.mjs produced no output."), ok ? "info" : "error");
        return;
      }
      if (sub === "config") {
        const s = await ensureSession(ctx);
        const cmd = parseConfigArgs(rest, s.agentDir);
        if ("usage" in cmd) {
          ctx.ui.notify(cmd.usage, "warning");
          return;
        }
        const r = await runScript(s, "foreman_config.py", cmd.argv);
        ctx.ui.notify(configResultText(r.text, cmd.applies, r.ok), r.ok ? "info" : "error");
        return;
      }
      if (sub !== "doctor") {
        ctx.ui.notify("Usage: /foreman doctor | /foreman status | /foreman waits | /foreman cost [workspace] | /foreman budget lift | /foreman flag-ask [note] | /foreman update-check | /foreman setup [args] | /foreman config apply-preset <name> [--foreman <model id>] [--dry-run] | /foreman config validate | /foreman close [result-path] | /foreman session open|brief|close|list | /foreman plan [off]", "warning");
        return;
      }
      if (rest.length === 1 && rest[0] === "warm") {
        const s = await ensureSession(ctx);
        if (s.isChild) {
          ctx.ui.notify("Usage: /foreman doctor warm (foreman session only)", "warning");
          return;
        }
        const m = ctx.model;
        const r = await doctorWarm({
          model: () => m ?? null,
          policy: () => (m ? resolveWarmPolicy(s.config.config, m.provider, m.id, bridgeTtlS) : null),
          replayable: () => replayable(m as never, pi.getThinkingLevel()),
          driftPending: () => !!m && m.provider === BRIDGE_PROVIDER && s.claudeCfg.pending(ctx.cwd).length > 0,
          busy: () => !ctx.isIdle() || warmQueued(s),
          hasUI: ctx.hasUI,
          confirm: blockedConfirmOn(herdrEvents, BLOCK_CONFIRM, (title, msg) => ctx.ui.confirm(title, msg)),
          rates: (promptTokens) => (m ? warmRates({ table: loadPrices(PKG_ROOT), registry: lookupRate(ctx.modelRegistry as never, m.provider, m.id), model: m.id, promptTokens, ttlSeconds: resolveWarmPolicy(s.config.config, m.provider, m.id, bridgeTtlS).ttlSeconds }) : null),
          api: () => liveReplayApi({ pi, hidden: () => deferred.hidden }, ctx),
          trace: (rec) => s.trace?.emit(rec),
        });
        ctx.ui.notify(r.text, r.level === "info" ? "info" : r.level === "warning" ? "warning" : "error");
        return;
      }
      const s = await ensureSession(ctx);
      const lines = await doctor(s, ctx);
      const failed = lines.some((l) => l.startsWith("FAIL"));
      ctx.ui.notify(["pi-foreman doctor", ...lines].join("\n"), failed ? "error" : "info");
    },
  });

  async function doctor(s: Session, ctx: ExtensionContext): Promise<string[]> {
    const out: string[] = [];
    const ok = (m: string): void => void out.push(`OK   ${m}`);
    const fail = (m: string, fix: string): void => void out.push(`FAIL ${m} — fix: ${fix}`);

    if (s.python.ok) ok(`Python ${s.python.info.version.join(".")} at ${s.python.info.executable} (${s.python.info.source})`);
    else fail(`no Python ≥ 3.13 (tried: ${s.python.rejected.join("; ") || "nothing"})`, NO_PYTHON_FIX.replace(/; run \/foreman doctor\.$/, "."));
    for (const r of s.python.rejected) if (r.includes("inside the workspace")) out.push(`INFO Python candidate ${r}: the guards never run on an interpreter or venv a child can write; use one outside the project (python.path in your user foreman.json or PI_FOREMAN_PYTHON).`);

    if (fs.existsSync(path.join(CORE_DIR, "scripts", "ledger_guard_write.py"))) ok(`core scripts at ${CORE_DIR}`);
    else fail(`core scripts missing under ${CORE_DIR}`, "reinstall pi-foreman (core/ is vendored with the package).");
    const unbundled = missingBundled(PKG_ROOT);
    if (unbundled.length) fail(`bundled packages missing under ${path.join(PKG_ROOT, "node_modules")}: ${unbundled.join(", ")}`, "run pi update --extensions (or npm ci in a checkout), then restart.");
    else ok(`bundled packages present under ${path.join(PKG_ROOT, "node_modules")}`);
    const reg = await import("./registry.ts"); // doctor-only helpers; keeps the top-level import line untouched
    out.push(...reg.worktreeDoctor(s.agentDir, s.cwd, platform));
    const doctorRoots = await piRootsOf(s);
    out.push(...worktreeRootDoctor(s.config.config, s.cwd, platform, { installRoot: doctorRoots.installRoot, npmRoot: doctorRoots.npmRoot }));

    if (s.config.source === "defaults") fail("config CLI did not run; L1 defaults in use", "fix Python first, then check scripts/foreman_config.py.");
    else if (s.config.errors.length) fail(`config errors: ${s.config.errors.join("; ")}`, "correct the named keys in your foreman.json.");
    else ok(`config loaded (${s.config.warnings.length} warning(s)${s.config.warnings.length ? ": " + s.config.warnings.join("; ") : ""})`);

    const generated = await generateSubagents({ python: pyPath(s), pkgRoot: PKG_ROOT, agentDir: s.agentDir, projectDir: s.cwd, trusted: safeTrusted(ctx), spawner });
    let settings: Record<string, unknown> | null = null;
    try {
      settings = JSON.parse(fs.readFileSync(path.join(s.agentDir, "settings.json"), "utf8"));
    } catch {
      settings = null;
    }
    if (!generated) fail("could not generate the subagents block", "fix Python/config first.");
    else {
      const have = (settings?.subagents ?? {}) as Record<string, unknown>;
      const keys = ["agentOverridesByProvider", "agentOverrides", "forceTopLevelAsync"];
      const same = keys.every((k) => canonical(have[k] ?? null) === canonical((generated as Record<string, unknown>)[k] ?? null));
      if (same) ok("generated subagents block in settings.json is in sync");
      else fail("subagents block in settings.json differs from generate-subagents", "run /foreman setup or the installer to regenerate it.");
    }

    // compaction overrides setup wrote: for every settings file with a record, the recorded value must still be the one in the file
    try {
      const managed = JSON.parse(fs.readFileSync(path.join(s.agentDir, "pi-foreman", "managed.json"), "utf8")) as { entries?: Record<string, { compactionDerived?: Record<string, number> }> };
      for (const [file, entry] of Object.entries(managed.entries ?? {})) {
        const derived = entry?.compactionDerived;
        if (!derived || !Object.keys(derived).length) continue;
        let fileSettings: Record<string, unknown> | null = null;
        try {
          fileSettings = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
          fileSettings = null;
        }
        const overrides = ((fileSettings?.compaction as { modelOverrides?: Record<string, { reserveTokens?: number }> } | undefined)?.modelOverrides) ?? {};
        const drifted = Object.keys(derived).filter((k) => overrides[k]?.reserveTokens !== derived[k]);
        if (drifted.length) fail(`compaction override in ${file} differs from what setup wrote: ${drifted.join(", ")}`, "run /foreman setup; it keeps a value you set yourself and records it as yours.");
        else ok(`compaction overrides written by setup in ${file} are in sync (${Object.keys(derived).length})`);
      }
    } catch {
      // no managed state yet: nothing to compare
    }
    if (piModelDataDir().error) out.push("INFO compaction: Pi model data not found; registry-derived overrides skipped (set PI_FOREMAN_PI_AI_DATA or PI_FOREMAN_PI_BIN)");

    for (const e of s.childExtensions) {
      if (fs.existsSync(e.path) && fs.statSync(e.path).isFile()) ok(`required child extension ${e.id}: ${e.path}`);
      else fail(`required child extension ${e.id} not found at ${e.path}`, "install the package or correct safety.requiredChildExtensions.");
    }
    if (s.registration) ok(`required child extensions registered (${s.registrationVia}, requireForAllRunners)`);
    else fail(`required child extensions not registered${s.registrationError ? `: ${s.registrationError}` : ""}`, "check the paths above and restart the session.");
    out.push(`INFO required child extension registration path: ${registrationPathLabel(s.registrationVia)}`);
    // The only reader of safety.git.commit.*: the keys are accepted so old configs load, nothing else may read them. Set means a non-blank string or a list with one.
    const commitKeySet = ["messagePattern", "requiredTrailers", "forbiddenTrailers", "checkCommand"].some((k) => {
      const v = get(s.config.config, `safety.git.commit.${k}`);
      return Array.isArray(v) ? v.some((x) => typeof x === "string" && x.trim() !== "") : typeof v === "string" && v.trim() !== "";
    });
    if (commitKeySet) out.push("INFO safety.git.commit.* is no longer used; commit messages are checked by the project's commit hooks");

    // Host pressure: a fresh sample (the sampler timer's call); a missing probe is never a FAIL.
    try {
      const file = pressurePath(s.agentDir);
      const args = ["sample", "--workspace", s.cwd, "--state", file, "--limits", JSON.stringify(limitsOf(s.config.config))];
      const fx = process.env[PRESSURE_FIXTURE_ENV]?.trim();
      if (fx) args.push("--fixture", fx);
      await (deps.pressureRun ?? ((a) => runScript(s, "foreman_pressure.py", a, 20_000)))(args);
    } catch {
      // fall through to the stored file
    }
    out.push(pressureDoctorLine(readPressure(pressurePath(s.agentDir), sampleSecondsOf(s.config.config), pressureNow())));

    if (!s.isChild && ctx.model) {
      // the base model, never the idle-downshift one: children and the rank policy keep the base
      const found = rankDoctorFindings(s.config.config, foremanBaseModel(ctx), (await currentRoles(s, ctx)).roles);
      for (const f of found) fail(f.message, f.fix);
      if (found.length === 0 && ranksOf(s.config.config).size > 0 && ["explorer", "builder", "reviewer"].some((r) => rolePolicy(s.config.config, r) !== "any")) ok("every role's normal model is launchable under the foreman model (rank policy)");
      const w = missingPairWarning(s.config.config, (await currentRoles(s, ctx)).roles, `${ctx.model.provider}/${ctx.model.id}`);
      if (w) out.push(`WARN ${w}`);
    }
    out.push(`INFO ${providersLine(ctx.modelRegistry as unknown as Parameters<typeof providersLine>[0])}`);
    const providers = get(s.config.config, "providers");
    const names = providers && typeof providers === "object" ? Object.keys(providers as object).filter((p) => p !== "allowed") : [];
    if (names.length === 0) out.push("INFO no providers in the provider map");
    for (const p of names) {
      let configured = false;
      try {
        configured = ctx.modelRegistry.getProviderAuthStatus(p).configured;
      } catch {
        configured = false;
      }
      if (configured) ok(`auth for provider ${p}`);
      else fail(`no auth for provider ${p}`, `run /login ${p} or set its API key environment variable.`);
      const missing = modelGaps(s.config.config, p, ctx.modelRegistry as unknown as RegistryLike).filter((g) => g.startsWith("model "));
      for (const g of missing) fail(g, "correct the model id in the provider map; Pi's model list shows what the registry has.");
      if (missing.length === 0) ok(`every model mapped for ${p} is in the model registry`);
    }

    if (isolationOn(isoSetting, ctx.model?.provider)) out.push(...isolationDoctor({ dir: isolationDir(s.agentDir), env: process.env, platform }));
    if (ctx.model?.provider === BRIDGE_PROVIDER) out.push(...bridgeTtlDoctorLines(s.config.config, ttlSetting, process.env));
    const permsRt = gateRuntimeOf(s);
    if (permsRt) out.push(...protectHintLines(permsRt.store.resolve()));
    if (ctx.model?.provider === BRIDGE_PROVIDER) {
      const risks = projectClaudeRisks(s.cwd);
      if (risks.length) fail(`project Claude Code config runs in claude-bridge turns: ${risks.join(", ")}`, PROJECT_CLAUDE_FIX);
      else ok("no project Claude Code hooks, command helpers or .mcp.json");
    }
    const bridgeTrust = bridgeTrusted(s.agentDir, s.cwd);
    const bridgeCfg = bridgeTrust ? [] : projectBridgeConfigRisks(s.cwd);
    if (bridgeTrust) ok("project .pi/claude-bridge.json is trusted by the owner (bridge-trust.json, hash matches)");
    else if (bridgeCfg.length) fail(`project claude-bridge config: ${bridgeCfg.join(", ")}`, PROJECT_BRIDGE_FIX);
    else ok("no executable path, AskClaude or strictMcpConfig false in .pi/claude-bridge.json");
    const userBridge = userBridgeConfigRisks(s.agentDir);
    const userBridgeFile = path.join(s.agentDir, "claude-bridge.json");
    if (userBridge.fail.length) fail(`user claude-bridge config ${userBridgeFile}: ${userBridge.fail.join(", ")}`, "remove them unless you meant them: AskClaude runs Claude Code with the project's settings and bypassPermissions, and strictMcpConfig false loads project MCP servers in every bridge turn.");
    if (userBridge.warn.length) out.push(`WARN user claude-bridge config ${userBridgeFile} sets ${userBridge.warn.join(", ")}: claude-bridge starts that program for every turn and summary. Fine if you set it on purpose; pi-foreman asks before bridge use when this file changes.`);
    if (!userBridge.fail.length && !userBridge.warn.length) ok("no executable path, AskClaude or strictMcpConfig false in the user claude-bridge config");
    let projectSettings: Record<string, unknown> | null = null;
    try {
      projectSettings = JSON.parse(fs.readFileSync(path.join(s.cwd, ".pi", "settings.json"), "utf8"));
    } catch {
      projectSettings = null;
    }
    const order = bridgeLoadOrder(projectSettings?.packages, settings?.packages, PKG_ROOT, path.join(s.cwd, ".pi"), s.agentDir);
    if (order === "bridge-first") fail("pi-claude-bridge loads before pi-foreman, so its compaction and branch-summary takeover runs before pi-foreman's config-drift check", "list pi-foreman before pi-claude-bridge in settings.json packages.");
    else if (order === "foreman-first") ok("pi-foreman loads before pi-claude-bridge (the drift check precedes the bridge's summaries)");
    else if (order === "unknown") out.push("INFO load order of pi-foreman and pi-claude-bridge not found in settings.json packages");
    out.push(...intercomDoctor(s.agentDir, [settings?.packages, projectSettings?.packages], process.env, PKG_ROOT));
    const ct = classifierTarget(s.config.config, ctx.model?.provider, ctx.modelRegistry as never);
    if (!ct) out.push(`WARN ${noClassifierModelText(ctx.model?.provider)}`);
    else if (!ctx.modelRegistry.find(ct.provider, ct.modelId)) fail(`classifier model ${ct.provider}/${ct.modelId} not in the model registry; dangerous-class calls ask you`, "correct providers.<p>.roles.review.model.");
    else ok(`classifier model: ${ct.provider}/${ct.modelId} (timeout ${ct.timeoutMs} ms)`);
    const gp = gateRuntimeOf(s);
    const pr = gp.store.resolve();
    out.push(`INFO permissions: mode ${pr.mode} (${pr.modeSource})${pr.profile ? `, profile ${pr.profile}` : ""}, ${pr.entries.length} pattern rules, ${pr.prose.allow.length} whitelist and ${pr.prose.deny.length} blacklist sentences; decision log ${gateLogFile(s.agentDir)}`);
    if (pr.modeSource === "invalid-user-file") out.push(`WARN ${gp.store.filePath("user")} is invalid; mode ask applies until it is fixed (see the session notice for the error)`);
    if (fs.existsSync(gp.store.filePath("project"))) {
      const why = gp.store.projectDistrust();
      if (why) out.push(`WARN ${gp.store.filePath("project")}: ${why}; its widening keys (allow, additionalDirectories, classifier.allow) are ignored`);
    }
    out.push(...hubWorkflowDriftLines({ hubWorkflow: get(s.config.config, "paths.hubWorkflow") }));
    out.push(...gateMigrationLines({ agentDir: s.agentDir, config: s.config.config }));
    out.push(...modsDoctorLines({ packageRoot: PKG_ROOT, appHome: doctorAppHome(process.env, os.homedir()) }));
    for (const sh of shadowedRoles(s.cwd, childRoleIds(get(s.config.config, "roles")))) out.push(`WARN project agent shadows a role (${sh}) — fix: ${SHADOW_FIX}`);

    if (fs.existsSync(markerPath(s.markerDir, s.id))) ok(`session marker in ${s.markerDir}`);
    else fail("session marker missing", `make ${s.markerDir} writable and restart the session.`);
    out.push(`INFO ceremony: ${tierLine(s.ceremony)}`);
    out.push(`INFO sidebar status: ${s.extStatus.describe()}`);
    out.push(`INFO PR tools: ${s.prPack ? prHostLabel(get(s.config.config, "tools.prHost") ?? "auto", workspaceOf(s.cwd).root, process.env, platform) : "off (tools.pr)"}`);
    if (s.prPack && !s.isChild) {
      const hosts = resolveGithubHosts(s.config.config);
      out.push(trackerDoctorLine(prFeedOn(s), "error" in hosts ? hosts.error : undefined, lastPollAgeMs(s.agentDir, Date.now())));
    }
    // The cache lines judge the base model: while downshifted the live model is the idle rung, which the idle-rung line below covers.
    const dm = idleModel.baseRef(ctx.model);
    const dmModel = dm && ctx.model && dm.provider === ctx.model.provider && dm.id === ctx.model.id ? ctx.model : dm ? (ctx.modelRegistry.find(dm.provider, dm.id) as typeof ctx.model) : undefined;
    const cache = resolveCachePolicy(s.config.config, dm?.provider, dm?.id, bridgeTtlS);
    if (cache.active && !s.isChild) {
      const missing: string[] = [];
      if (!dmModel?.promptCache) missing.push(`models.json (${path.join(s.agentDir, "models.json")}) for ${dm ? `${dm.provider}/${dm.id}` : "the model"}: ${reg.promptCacheSnippet(dm?.provider, dm?.id, cache.ttlSeconds ?? 300)}`);
      if (missing.length) out.push(`WARN idle cache keep-alive is on by default for ${dm?.provider} but the model's promptCache is not declared: add ${missing.join(" and ")}, or switch it off with providers.${dm?.provider}.cache.keepalive.enabled: false (docs/cache.md)`);
      else ok(`idle cache keep-alive: promptCache declared for ${dm?.provider}`);
    }
    if (!s.isChild) {
      const idleSpec = get(s.config.config, `providers.${dm?.provider}.roles.foreman.idle.model`);
      const idleRef = typeof idleSpec === "string" && idleSpec && dm ? splitSpec(idleSpec, dm.provider) : null;
      out.push(...deprecatedKeepaliveLines(s.config.config));
      out.push(...retiredHighStakesLines(s.config.config));
      out.push(...cacheDoctorLines({
        provider: dm?.provider,
        policy: resolveWarmPolicy(s.config.config, dm?.provider, dm?.id, bridgeTtlS),
        promptCache: dmModel?.promptCache,
        retention: process.env.PI_CACHE_RETENTION,
        selfWarmMissed: s.selfWarm.missed(),
        hasIdleRung: !!idleSpec,
        idleRung: idleRef ? { spec: String(idleSpec), provider: idleRef.provider, policy: resolveWarmPolicy(s.config.config, idleRef.provider, idleRef.id, bridgeTtlS) } : null,
      }));
    }
    if (!s.isChild) out.push("INFO /foreman doctor warm proves the idle warm live on this model (two small requests; it states the cost and asks first)");
    const addonOn = addonPresent(pi.getAllTools().map((t) => t.name), { agentDir: s.agentDir, cwd: s.cwd });
    out.push(`INFO background-tasks: ${addonOn ? "present" : "absent"}`);
    out.push(...bgFeaturesDoctor(addonOn, s.agentDir, process.env));
    if (!s.isChild) out.push(...deferredDoctorLines(addedPatterns(deferred.patterns, shippedDeferred()), pi.getAllTools().map((t) => t.name)));
    const peerLine = addonPeerRangeLine({ agentDir: s.agentDir, cwd: s.cwd, bundledRoot: PKG_ROOT }, await (deps.piVersion ?? runningPiVersion)());
    if (peerLine) out.push(peerLine);
    out.push(...optionalAddonsDoctor({ agentDir: s.agentDir, cwd: s.cwd }, pi.getAllTools().map((t) => t.name), process.env));
    out.push(dormantDoctorLine(PKG_ROOT, withBuiltinKeepalive(s.config.config, dm?.provider, cache.active)));
    // The profile and its deviations are read without the project layer (the agent dir has no .pi/foreman.json), so project tightening is not noise.
    const userOnly = s.python.ok ? await loadMergedConfig({ python: pyPath(s), pkgRoot: PKG_ROOT, agentDir: s.agentDir, projectDir: s.agentDir, trusted: false, spawner }) : null;
    out.push(...profileDoctorLines(userOnly && userOnly.source === "cli" ? userOnly.config : s.config.config, s.config.config, PKG_ROOT));
    return out;
  }
}

/** Trace label for a core-guard ask, from the translated block reason (undefined = approved). */
/** `tools.deferred` of the shipped config/foreman.defaults.json (empty when unreadable). */
function shippedDeferred(): string[] {
  try {
    const d = (JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "config", "foreman.defaults.json"), "utf8")) as { tools?: { deferred?: unknown } }).tools?.deferred;
    return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A `subagent` call that starts a run: a launch (no action) or a resume. */
function isLaunchArgs(args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const a = actionOf(args as Record<string, unknown>);
  return a === null || a === "resume";
}

function askOutcome(isChild: boolean, reason: string | undefined): string {
  if (reason === undefined) return "approved";
  if (isChild) return "child";
  if (reason.startsWith("Denied by the user.")) return "denied";
  return "no-ui";
}

/** The drift confirm of `ctx`; `trace` gets one `dialog` record (surface `drift`) when the confirm actually opens. */
function driftAsk(ctx: ExtensionContext, trace?: TraceWriter | null) {
  return {
    mode: ctx.mode,
    hasUI: ctx.hasUI,
    confirm: blockedConfirmOn(herdrEvents, BLOCK_CONFIRM, (title, msg) => {
      trace?.emit({ event: "dialog", surface: "drift" });
      return ctx.ui.confirm(title, msg);
    }),
  };
}

/** The running Pi's version: Pi resolves its own package for extensions, so its VERSION export is the host's. Null when unavailable. */
async function runningPiVersion(): Promise<string | null> {
  try {
    const v = ((await import("@earendil-works/pi-coding-agent")) as { VERSION?: unknown }).VERSION;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

function safeTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

