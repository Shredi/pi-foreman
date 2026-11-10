// pi-foreman core adapter: wires the vendored Python core into Pi (design §§5-7, 9).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SteerWatch, foldSteer, pickupRuling, takeLateSteer } from "./steerwatch.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterSpawn, beforeSpawn, changedFileOf, escalate, gateThreshold, initialCeremony, isTier, ledgerTier, onFileChanged, onStrongLaunch, promptSignals, tierLine, TIERS, userOverride } from "./ceremony.ts";
import { checkTrivial, effectiveRequired, escalationNote, trivialBuilderPath } from "./trivial.ts";
import type { CeremonyState } from "./ceremony.ts";
import { canonical, generateSubagents, get, loadMergedConfig, pythonPathHint, readProjectDeferred } from "./config.ts";
import type { Json, MergedConfig } from "./config.ts";
import { loadRegister, normaliseChildExtensions, registrationPathLabel } from "./childext.ts";
import { buildOverlayRules, checkToolCall, isOverlayTool, isSelfHost, npmCiWorktreeLabel,OVERLAY_UNAVAILABLE, readBaseline, resolveDecision } from "./permoverlay.ts";
import type { Decision, MatchCtx, OverlayRules } from "./permoverlay.ts";
import { childHandoffDirs, openedHandoffDirs, ownedRoots, ownHandoffDirs, resolveNpmRoot, underOwned } from "./owned.ts";
import { recheckExempt } from "./recheckexempt.ts";
import type { OwnedRoots } from "./owned.ts";
import { launchNeedsNestedRefusal, sessionRootInputs, treeCeilingOf, treeRootOf, worktreeRootDoctor } from "./worktreeroot.ts";
import { baseFloorEnv, gateEvaluate, gitFacts, reviewGitFacts } from "./gate.ts";
import { ownWorktreeCheck, sessionGitFacts } from "./ownworktree.ts";
import { Classifier, CLASSIFIER_ROLE, classifierTarget, denyText } from "./classifier.ts";
import { noClassifierModelText } from "./reviewwarn.ts";
import { PermStore, PERM_MODES, cleanProtected, profileName, protectHintLines, protectedBlock, workFoldersBlock } from "./permconfig.ts";
import { folderRelaxes, mergedFactKey, withMergedFacts } from "./defaults.ts";
import type { GitFacts } from "./defaults.ts";
import type { PermMode, Resolved } from "./permconfig.ts";
import { describeCall, exactRules, proposeRule } from "./rules.ts";
import { readToolsOf, warnUnknownReadTools } from "./readtools.ts";
import { adopt as adoptSuggested, entriesFromReport, parsePicks, review as reviewAdopted, runSuggest, suggestHint } from "./permssuggest.ts";
import type { AdoptPick } from "./permssuggest.ts";
import { gateLogFile, openGateLog } from "./gatelog.ts";
import type { GateKind, GateLog, GateLayer } from "./gatelog.ts";
import { ChildAskWatch, childAskDir, childAskParentDir, awaitChildRuling, writeChildAsk } from "./childask.ts";
import type { ChildAnswer, ChildAsk, ChildAskEvent } from "./childask.ts";
import { askOwner, DEFAULT_ASK_TIMEOUT_MS, STOP_TEXT } from "./gatedialog.ts";
import { childNpmNote } from "./childnpm.ts";
import type { OwnerAnswer, OwnerDeps } from "./gatedialog.ts";
import { parseShell } from "./shellast.ts";
import { NO_PANE_TEXT, OWNER_AWAY_TEXT } from "./presencewait.ts";
import { PATH_TOOL_NAMES, tmpRoots } from "./pathrules.ts";
import type { GateRoots } from "./pathrules.ts";
import type { Registration } from "./childext.ts";
import { forceDetached } from "./detach.ts";
import { forceUserScope, SHADOW_FIX, shadowedRoles } from "./agentscope.ts";
import { actionOf, endActive, isManagementCall, launchId, outputPathBlock, recordLaunch, recordLaunchRoles, trackActive, roundSteps, subagentActionCheck, uncheckedHeavyBlock } from "./actions.ts";
import { dupRefusalText, repeatSignals, type PassMark, addChange, boundRefusal, emptySteps, finishLine, emptyTally, finishRefusal, initialReviewGate, onReviewVerdicts, onRevision, openSteps, noChange, overBound, pendingChange, readBound, dupReview, reopened, requiredSteps, reviewGateMode, reviewHint, reviewVerdictsOfRunEnd, SECOND_OPINION, stepsOfRunEnd, type ReviewGate } from "./bound.ts";
import { isBriefName, isCapsResetName, isRulingName, isTrackedRulingName, parentApproval, rulingNeeded, rulingOverrideNote, selfRulingAsk, selfRulingRefusal, SelfRulings, snapshotRulings } from "./ruling.ts";
import type { Change, Step, StepCounts, Tally } from "./bound.ts";
import type { RunRegistry } from "./actions.ts";
import { dropDeadPathRewrite, guardPayloadBlock } from "./guardgaps.ts";
import { firstRunNotice, presetNames, presetProviders, providerGapNotice } from "./firstrun.ts";
import { dormantDoctorLine } from "./features.ts";
import { bridgeTrusted, trustBridgeCommand } from "./bridgetrust.ts";
import { withNudge } from "./knowledge.ts";
import { preBashConfigOf, runPreBashHooks } from "./prebash.ts";
import { profileDoctorLines } from "./profiledoctor.ts";
import { BUNDLED_PACKAGE_ROOTS, collectOrientation } from "./orient.ts";
import type { PiRoots } from "./orient.ts";
import { applyRootsBlock } from "./childbrief.ts";
import { ExplorerBrief } from "./builderbrief.ts";
import { ChildReads, childReadLimits, launchReadAllowance } from "./childreads.ts";
import { bgWaitLocations, coordinationCall, launchLocations, inRecorded, noticeLocations, isReadCall, ReadBudget, READ_CLASS, readLimits, recordFiles } from "./budget.ts";
import { roleToolDenied } from "./roledeny.ts";
import { McpChild, configuredServers, searchableOf } from "./mcpchild.ts";
import { missingFloorTools } from "./toolfloor.ts";
import { DEFERRED_ENTRY, DEFERRED_SECTION, deferredDoctorLines, deferredHint, hiddenSet, latestDeferredLoaded, mergeDeferredLayers } from "./deferred.ts";
import { createToolSearchTool } from "./toolsearch.ts";
import { ToolUsageTracker, packageOf } from "./toolusage.ts";
import { SKILLS_SECTION, skillRulesOf, skillsHint, splitSkills, type SkillRef, type SkillRules } from "./skillvisibility.ts";
import type { McpChildOpts } from "./mcpchild.ts";
import { mcpHintLine, namedCeilingServers, PER_ENTRY_BINDINGS, planMcpLaunch, unknownServerLine, unknownServers, workflowBindingBlock } from "./mcplaunch.ts";
import { childSkillDirs, childSkillRefs } from "./skilldirs.ts";
import { editorBackupCommand } from "./effects.ts";
import { RUN_END_EVENTS, SUPERVISOR_TOOL, SupervisorWindow, roleToolsFrom } from "./supervisor.ts";
import { CHILD_TRACE_EVENT, gitGuardPayload, mainNeedsGitGuard, runGitGuard } from "./gitguard.ts";
import { branchMergedFact, branchMove, runShellWriteGuard, shellWriteGuardPayload, shellWriteVerdict } from "./shellwriteguard.ts";
import { childRoleIds, roleLaunchBlock, roleModelBlock } from "./roles.ts";
import { BRIDGE_PROVIDER, BridgeIsolation, bridgeLoadOrder, providersLine, isolationDir, isolationDoctor, isolationOn, loadOrderNotice, PROJECT_BRIDGE_FIX, PROJECT_CLAUDE_FIX, projectBridgeConfigRisks, projectClaudeRisks, userBridgeConfigRisks } from "./bridgeiso.ts";
import { applyLaunchModels, applyLaunchTimeouts, roleModelsOf, roleTimeoutMs, splitLevel, STRENGTHS } from "./launchmodel.ts";
import { hubWorkflowDriftLines } from "./hubdrift.ts";
import { gateMigrationLines } from "./gatemigrate.ts";
import { reviewTarget, userPromptOf } from "./review.ts";
import { git, ReviewFacts } from "./diffscan.ts";
import { applyFactCriticalRungs, applyResearchFloor, entryTraces, floorMarker, markedEntries, researchTraces } from "./research.ts";
import { applyOccasionOverrides, applyReviewModelRule, applySecurityRungs, highStakesConfig, markPolicyOverrides, missingPairWarning, planReviewerClimbs, STAKE_TAGS, stakeOf, type Stake, ReviewerFails, reviewerTextsOfRunEnd, type ReviewerClimb, type ReviewPin } from "./reviewerclimb.ts";
import type { RoleResolution } from "./roles.ts";
import { buildGuardEnv, msysEnv, patchShellEnv, piAgentDir } from "./env.ts";
import { patchChildGitEnv, stripChildCdEnv, stripChildIntercomEnv } from "./childenv.ts";
import { boundLaunchId, ChildScratch, finishScratch, launchScratch, SCRATCH_ENV, scratchRoot, storeBrief, sweepScratch } from "./childscratch.ts";
import { panelChecksLine } from "./panelchecks.ts";
import type { PanelChecksCache } from "./panelchecks.ts";
import { GitDriftWatch, patchForemanGitEnv, safeOpDriftPreflight } from "./gitdrift.ts";
import { ClaudeConfigWatch } from "./claudedrift.ts";
import { boundLedger, ensureSessionMarker, isLedgerTarget, markerPath } from "./marker.ts";
import { applyVariants, findItemByText, isLedgerOnlyCommand, isPermissionDeny, LEDGER_ACTIONS, LEDGER_TOOL, ledgerHelperMode, mentionsLedger, planLedgerCall, retryLedgerRun, rewriteItemText } from "./ledgercall.ts";
import { postToolPayload, preToolPayload, resolveToolPath, stopPayload, subagentAgents, subagentTaskText } from "./payload.ts";
import type { PayloadContext } from "./payload.ts";
import { NO_PYTHON_FIX, PythonCache, resolvePython } from "./python.ts";
import type { PythonResolution } from "./python.ts";
import { beginRun, decideScript, newScriptState, proposeScript, recordRun, SCRIPT_CHOICES, SCRIPT_FIX_LINES_DEFAULT, SCRIPT_MAX_ATTEMPTS, SCRIPT_TOOL, scriptNoticeLines, scriptSelectTitle, scriptStatus, shortHash } from "./scriptapproval.ts";
import type { ScriptRefusalCode, ScriptState } from "./scriptapproval.ts";
import { runScript as runOwnerScript } from "./scriptrun.ts";
import type { ScriptRunKind } from "./scriptrun.ts";
import { runGuard } from "./runguard.ts";
import { PR_FOLLOW, applyGitPack, applyPrPack, gitPackOn, prHostLabel, prPackOn, isOwnTool, registerGitPack, registerPrFollow, registerPrPack } from "./gitpack.ts";
import type { PrPackSession } from "./gitpack.ts";
import { addTracked, readStoreEntry } from "./prstore.ts";
import type { PrOp } from "./gitpack.ts";
import { PRWATCH_ENTRY, PrWatches, latestWatches, watchIntervalMs } from "./prwatch.ts";
import { parseWakeRules } from "./prwake.ts";
import { PrHost, branchOf, isTrackedKey, resolveGithubHosts } from "./prhost.ts";
import { PushNotice } from "./pushnotice.ts";
import { Where, originRepo } from "./where.ts";
import { ExtStatus } from "./extstatus.ts";
import { registerSafeOps, runSafeOp } from "./safeops.ts";
import { defaultSpawner } from "./spawn.ts";
import type { Spawner } from "./spawn.ts";
import { ADDON_BG_TOOL, FOREMAN_BG_TOOL, isShellTool, mapTool } from "./toolmap.ts";
import type { GuardName } from "./toolmap.ts";
import { evaluateRun, planModeOn, spawnPermissionMode, translateStop, translateToolCall } from "./translate.ts";
import { appendHeadLine, appendReview, capSet, checksLine, headlessPass, headOf, headsAt, isPrToolName, launchCwds, passCheckouts, passHeads, PR_REFUSALS, prGateRefusal, reviewedHeadWhy, toplevelOf, reviewsOfRunEnd, reviewsWithOutput } from "./reviews.ts";
import type { ReviewRecord } from "./reviews.ts";
import { AttentionNotices, dedupeToolCallNotices, dropEndedRunNotices, dropSuppressedNotices, hideStaleNotice, noticeEvent, staleNoticeRunIds, stableNoticeFilter, trimNoticeMessage } from "./notices.ts";
import { clearOpenCommand, DEFAULT_LONG_COMMANDS, isLongCommand, readOpenCommand, writeOpenCommand } from "./opencommand.ts";
import { markPassItems, MARK_NOTE, reviewerPassOfNotice, reviewerPassOfRunEnd } from "./reviewmarks.ts";
import { commentOnlySince, treeChangedSince, worktreeTree, type TreeSnap } from "./commentonly.ts";
import { sampleAway } from "./protected.ts";
import { denyFields, openTrace, toolErrorRecord, traceFile } from "./trace.ts";
import type { TraceWriter } from "./trace.ts";
import { loadPrices } from "./cost.ts";
import { budgetCap, budgetCheck, failedItemsOf, prependReReview } from "./costguard.ts";
import { costReport } from "./costreport.ts";
import { appendUsage, aggregate, isCostLine, bindLaunch, stripBinding, causeOfCustom, WAKE_MESSAGE_TYPE, causeOfInput, formatSummary, keepSection, alignSections, PARENT_SESSION_ENV, readBinding, checkoutEnv, pricedLine, readUsage, recordUsageLaunch, singleLaunchRole, usageFile, usageLine } from "./usage.ts";
import type { LadderLimits, LaunchBinding, LaunchKind, LineContext, TurnCause } from "./usage.ts";
import { workspaceOf } from "./python.ts";
import { dialogFamily, dialogFields, dialogsJson } from "./dialogs.ts";
import { AskFlag } from "./askflag.ts";
import { ASK_USER_TOOL, askAnsweredSome, writeAskRuling } from "./askhooks.ts";

const DIALOGS_TOOL = "foreman_dialogs";
import { ChildRuns, UsageTail, rungOf } from "./runs.ts";
import { childBashTimeout, type ChildBashTimeout } from "./bashtimeout.ts";
import { LiveState, intercomIdOf, labelOfHandoff } from "./livestate.ts";
import { ownerFactsLines, ownerSummary, prefixQuestions, projectNameOf, questionHint, questionPrefix, showHint } from "./ownertext.ts";
import { NOTE_MAX_BYTES, NOTE_TITLE_MAX, Show, SHOW_TOOL } from "./show.ts";
import { OpenPrsRefresher, openPrsConfig, realGh } from "./openprs.ts";
import { installSidebarLive } from "./sidebarlive.ts";
import { CompactionGate } from "./compaction.ts";
import { runtimePoint } from "./compaction-point.mjs";
import { piModelDataDir } from "./pi-model-data.mjs";
import { resolveCachePolicy, resolveWarmPolicy } from "./cachepolicy.ts";
import { bridgeTtlDoctorLines, cacheDoctorLines, deprecatedKeepaliveLines } from "./doctorcache.ts";
import { BridgeCacheTtl, bridgeTtlSetting, derivedBridgeTtlS, type BridgeTtlSetting } from "./bridgettl.ts";
import type { Presence } from "./presence.ts";
import type { SelfWarm, WarmSignals } from "./selfwarm.ts";
import { createWarm } from "./warmwire.ts";
import { IDLE_ENTRY, IdleModel, ownerAnswered } from "./idlemodel.ts";
import { coldAt as coldAtTouch } from "./warmcompact.ts";
import { KeepaliveLog, type KeepaliveResult } from "./keepalive.ts";
import { applyLedgerItems, criticOf } from "./ledgerblock.ts";
import { citedItems, hintFailTrace, ledgerHint, renameRetry, writeHint as writeHintNow, type HintWriteOpts, type HintLog } from "./hints.ts";
import { ledgerGate, type LedgerGate } from "./ledgerlock.ts";
import { appendCompactionRetro, appendModelRetro, appendStateRetro, RetroState, retroEnabled, sessionTrace, withDigest } from "./retro.ts";
import { frictionOfRunEnd } from "./friction.ts";
import { extractRetro, lastAssistantText, knownLimitsArg, modelRetroPrompt, RETRO_INSTRUCTIONS } from "./retrodigest.ts";
import { UsageFooter, cacheStatus, footerStyleOf, lookupRate, type CacheSource } from "./footer.ts";
import { symbolSet } from "./symbols.ts";
import { blockedConfirm, installBlockedShim, withBlocked } from "./herdr.ts";
import { installHerdrMeta } from "./herdrmeta.ts";
import { installBgRecords } from "./bgrecords.ts";
import { RemoteWatcher } from "./remotewatch.ts";
import { captureIdentity, IDENTITY_ENTRY, latestIdentity, restoreIdentity, writeLive } from "./identity.ts";
import type { IdentityRestore } from "./identity.ts";
import { builderLaunchRefusal, checkpointMode, CHECKPOINT_CHOICES, CHECKPOINT_TOOL, currentPlanHash, isPlanPath, launchRefusalText, PLAN_NAME, PLAN_VERDICT_FILE, readPlanVerdictFile, planSummary, planVersionHash, readPlan, readPlanVerdict, restoreFromStore, saveStored, sha256, stampPlanVersion } from "./checkpoint.ts";
import type { PlanRecord } from "./checkpoint.ts";
import type { EventBus } from "./herdr.ts";
import { claimCore, emitReady, installInert, markCoreStarted, missingBundled, setupInvocation } from "./registry.ts";

/** pi.events of the loaded extension, for the Herdr blocked signal (set in the factory). */
let herdrEvents: EventBus | undefined;
import { completedAgents, CritiqueCounter, initialRounds, isOwnerPrompt, NOTIFY_TYPE, onReviewDone, REVIEW_ROLES, rulingReset, verdictOf, walkLaunch } from "./rounds.ts";
import type { LaunchRounds, RoundState } from "./rounds.ts";
import { loopRefusal, loopVerdict, sigOf } from "./reviewloop.ts";
import type { LoopStop, ReviewKind } from "./reviewloop.ts";
import { getShellConfig as piGetShellConfig } from "@earendil-works/pi-coding-agent";
import { applyBgShellEnv } from "./bgshell.ts";
import { shellPathSetting } from "./bg.ts";
import { addonPeerRangeLine, addonPresent, bgFeaturesDoctor, optionalAddonsDoctor, formatWaits, readAddonTasks, readOwnAddonTasks, wakingBgTaskIds } from "./bg.ts";
import { registerWait, waitLimits } from "./wait.ts";
import { CRITICAL_WAIT_SECONDS, criticalReason, explorerOnly, narrowTasks, PRESSURE_FIXTURE_ENV, limitsOf, PressureSampler, pressureDoctorLine, pressurePath, pressureStatusLine, queuedReason, readPressure, sampleSecondsOf, type PressureState } from "./pressure.ts";
import { dedupeNotices, dedupeOn, detachedLaunchLine, dropAsyncGuidance, holdCap, LaunchBatch, launchWaitMode, openRequestLine, launchWaitText, LaunchWaits, noticeRuns, REPEAT_REFUSAL_ERROR, REPEAT_STOP_REASONS, runEndOf, SUPERVISOR_SURFACED_EVENT } from "./launchwait.ts";
import { HANDOFF_DIR_ENV, closeReportArgs, parentIntercomId, parseCloseReport, prMergedPrompt, readCloseJson, registerClose, syncCommand } from "./close.ts";
import { selfFinish, spawnDetached } from "./selffinish.ts";
import type { CloseReport } from "./close.ts";
import { cliModelOf, foremanModelSpec, markOwnClosed, openerIntercomId, registerSession, remoteReplier, remoteRunner, registerSessionOpenTool, sessionModelOf } from "./session.ts";
import { closeChildren } from "./closechildren.ts";
import { AskContract } from "./askcontract.ts";
import { SteerReader } from "./steer.ts";
import { foremanTriage, GATED_TOOLS, isTriaged, OUTWARD_TOOLS, triageAdvice, triageGateBlock, TRIAGE_RULES, TRIAGE_TOOL, trivialPathAdvice, workspaceTargets } from "./triage.ts";
import { allowedShellDirs, editModeAdvice, editModeBlock, editModeOf, projectChange, scratchDirOf } from "./editmode.ts";
import type { EditMode } from "./editmode.ts";
import { familyWarnings, modelGaps, splitSpec } from "./modelcheck.ts";
import { ChildLadder, childMaxTurns, climbHint, hasStrongRung, LadderState, ledgerLines, onBottomRung, revisionClimb, strongAbove, strongOnRevision, type Climb } from "./ladder.ts";
import { explicitModelAllowed, launchedModels, rankRefusal, rankRefusalFor, ranksOf, rolesOfModel } from "./ranks.ts";
import type { RegistryLike } from "./modelcheck.ts";
import { countingView, entryOccasions, occasionLinesOf, occasionOf, reviewLaunchOf, reviewResultsOfRunEnd, type Occasion, type ReviewLaunch, type ReviewResult } from "./occasion.ts";
import { panelConfig, PendingPanels, primaryPanel, shadowInstruction, shadowLaunch, type ShadowDecision } from "./panel.ts";
import { diffLinesOf, filesOfDiff, onReviewRunEnd, planReviewFiles, RECORD_TIMEOUT_MS, type RunEndFindings } from "./findings.ts";
import { buildCeremonyState, CEREMONY_ENTRY, emptyCeremonyState, latestCeremonyState, restorableApproval, type CeremonyStateEntry } from "./planstate.ts";
import { PlanReviews, planFactsBlock, planPathsOf, planReviewOn, planReviewRounds, planReviewRefusalText, planReviewResults, planReviewSection } from "./planreview.ts";
import { restoreRoundState, ROUND_STATE_FILE, roundStateDir, writeRoundState } from "./roundstate.ts";
import { launchEntries } from "./ladder.ts";
import { liftSizing, misplacedHint, subagentDescription, planSizing, prependProbe, rungOfModel, sizingConfig, sizingTrace, takeLaunchFlags, takeSizing, topModel as sizingTopModel, type EntryPlan, type RungContext } from "./sizing.ts";
import { ManifestRecorder, manifestOwner, recordEntries } from "./manifest.ts";
import { asyncResultReads, asyncRunDirs, bashOutputLogs, recordBashOutputLog, childReadable, childSurface, hubWorkflowDirs, hubWorkflowReadable, mainWorkflowReadable, ownTaskReadable, ownUsageReadable, piScratchReadable, roundWorktrees, sessionOwnedSplit } from "./roundsurface.ts";
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
const GIT_GUARD_ID = "pi-foreman-git-guard";
const GIT_GUARD_ENTRY = path.join(PKG_ROOT, "extensions", "git-guard", "index.ts");
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
  /** Deny/ask rules enforced before the permission system; null = baseline unreadable (fail closed). */
  overlay: OverlayRules | null;
  openPrs: OpenPrsRefresher | null;
  /** Child only: realpaths of the skills its role names (skilldirs.ts), resolved once. */
  skillDirs?: Promise<string[]>;
  /** Dirs the foreman owns outside the workspace (owned.ts); the npm root joins once `npm root -g` resolved. */
  owned: OwnedRoots;
  /** True until `npm root -g` resolved or failed: a custom worktree root is not owned and `--worktree` open is refused meanwhile. */
  npmRootPending: boolean;
  registrationVia?: string;
  childExtensions: { id: string; path: string }[];
  stopContinued: boolean;
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
  /** Foreman only: ms epoch of the last parent ruling/brief that lifted the caps (capsReset); persisted with reviewCount. */
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
  /** The reviewer step under ceremony.reviewGate "pass": latest verdict and a revision since (bound.ts). */
  reviewGate: ReviewGate;
  /** Finish refusals since the last user prompt (at most 2, then a forced pass). */
  finishRefusals: number;
  /** Foreman only: a handoff wait or a pending checkpoint waits for the parent/owner; the finish gate lets the turn end. Cleared by the next user/parent input. */
  waitingForParent: boolean;
  /** Foreman only: ids of the active waits that set waitingForParent (cleared with it). */
  handoffWaits: Set<string>;
  /** Foreman only: custom messages handled so far, so an idle-appended one is handled once at the next input (idlecustom.ts, ledger 11). */
  customSeen: CustomSeen;
  /** Needs-attention notices: ended runs (RUN_END_EVENTS) and what was shown (notices.ts, R12 item 9). */
  attention: AttentionNotices;
  /** Uncounted finish refusals that ask for the builder's review_fail climb, since the last user prompt (at most 2). */
  climbRefusals: number;
  /** Foreman only: per-item FAIL counts of reviewer runs (ladder.reviewerClimb, reviewerclimb.ts). */
  reviewerFails: ReviewerFails;
  /** Foreman only: the loop guard's stop (reviewloop.ts): builder and reviewer launches are refused while set; persisted in the ceremony-state entry (planstate.ts). */
  loopStop: LoopStop | null;
  /** Plan phase (persisted in the ceremony-state entry): .workflow-only writes, explorers without a ledger, no builder. Entered by PI_FOREMAN_PLAN_PHASE=1 or /foreman plan; left by a checkpoint approval or /foreman plan off. */
  planPhase: boolean;
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
  /** Pending HEAD reads of `reviews`; the PR gate waits for it. */
  reviewSync: Promise<void>;
  /** Foreman only: review runs whose `N. PASS` items were marked (reviewmarks.ts), so each run marks once. */
  reviewMarked: Set<string>;
  /** Foreman only: the working tree at the latest review PASS (commentonly.ts); null without one. */
  passSnap: TreeSnap | null;
  /** Foreman only: builder runs, HEAD, tree and ledger at the latest review PASS; a reviewer launch is no repeat once one of them changed (bound.ts repeatSignals). */
  passMark: (PassMark & { cwd: string }) | null;
  /** Foreman only: builder runs launched after a PASS; a comment-only result withdraws their revision. */
  touchUps: Set<string>;
  /** Foreman only: HEAD per directory at launch, by tool call id until the launch result names the run. */
  launchHeadsByCall: Map<string, Map<string, string | null>>;
  /** Foreman only: HEAD per directory at launch, by run id until the run ends (reviews.ts reviewedHead). */
  launchHeads: Map<string, Map<string, string | null>>;
  /** Foreman only: the latest plan checkpoint (checkpoint.ts; in memory, a restart checkpoints again; a session opened by another session reloads an approval only from the parent's ruling.md, roundstate.ts). */
  plan: PlanRecord | null;
  /** The owner-script proposal and its approval (scriptapproval.ts): in memory only, so a reload or restart drops the approval. */
  script: ScriptState;
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
  /** Plan publication for the side panel (show.ts); null without a presence file or with the scratch dir disabled. */
  show: Show | null;
  /** Foreman only: the pressure sampler timer (pressure.ts), and the launches queued behind the one that runs under high pressure (per assistant message). */
  pressureSampler: PressureSampler | null;
  pressureQ: { gen: number; entries: unknown[]; started: boolean } | null;
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
}

export default function coreAdapter(pi: ExtensionAPI, deps: AdapterDeps = {}): void {
  const spawner = deps.spawner ?? defaultSpawner;
  const platform = deps.platform ?? process.platform;
  // Deferred tool declarations (deferred.ts): the hidden set is fixed at session start; the harness tool_search finds hidden tools and un-hides one only without codemode.
  const deferred = { patterns: [] as string[], loaded: new Set<string>(), hidden: [] as string[], planMode: false, warnings: [] as string[], hint: "", trace: (_r: Record<string, unknown>): void => {} };
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
  // win32: the pi-background-tasks add-on reads PI_BG_SHELL* in its own factory, which loads after this one; set them now, before any await
  if (platform === "win32") applyBgShellEnv({ platform, getShellConfig: piGetShellConfig, shellPath: shellPathSetting(piAgentDir(process.env, os.homedir()), process.cwd()) });
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
  pi.on("session_shutdown", async () => {
    remoteWatch?.stop();
    remoteWatch = null;
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
  /** Tool call ids of `subagent` launches that carried size/risk outside the top level (sizing.ts liftSizing); read at their tool_result. */
  const misplacedSizing = new Set<string>();
  herdrEvents = pi.events as EventBus | undefined;
  // Herdr blocked shim (herdr.ts); `blockedShim.onChange((active) => ...)` can feed other consumers.
  const blockedShim = installBlockedShim(pi, { enabled: () => [...sessions.values()].every((x) => get(x.config.config, "herdr.blockedShim") !== false) });
  // Own asks hold each session's presence blocked directly (Pi can suppress ui_prompt_start, see herdr.ts).
  blockedShim.onOwn(() => {
    const holds = [...sessions.values()].map((s) => s.live?.hold());
    return () => holds.forEach((release) => release?.());
  });
  // A question tool call holds an own blocked source from tool_call to tool_execution_end, independent of Pi's ui_prompt_* events (Pi suppresses them under a stuck dialog depth).
  const questionBlocks = new Map<string, () => void>();
  const holdQuestion = (id: string, input: unknown): void => {
    questionBlocks.get(id)?.();
    const first = (input as { questions?: { header?: unknown }[] } | undefined)?.questions?.[0]?.header;
    const label = typeof first === "string" && first.trim() ? first : "question";
    questionBlocks.set(id, blockedShim.own(label));
  };
  const releaseQuestion = (id: string): void => {
    const release = questionBlocks.get(id);
    questionBlocks.delete(id);
    release?.();
  };
  let bgTrace: (rec: Record<string, unknown>) => void = () => undefined;
  const bgRecords = installBgRecords(pi, { platform: deps.platform ?? process.platform, trace: (r) => bgTrace(r) }).recorder; // hc records for background tasks (bgrecords.ts)
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
  pi.on("ui_prompt_start", async (_e, ctx) => sessionFor(ctx)?.live?.setBlocked(true));
  pi.on("ui_prompt_end", async (_e, ctx) => sessionFor(ctx)?.live?.setBlocked(false));
  // orphaned dialog (see herdr.ts): Pi may swallow ui_prompt_end, so any input or the end of the turn also clears the "ui" source
  pi.on("input", async (e, ctx) => {
    const s = sessionFor(ctx);
    s?.live?.setBlocked(false);
    if (s && (e as { source?: string }).source !== "extension") gateStopped.delete(s.id); // a new user prompt ends a "deny and stop"
  });
  pi.on("agent_end", async (_e, ctx) => {
    const s = sessionFor(ctx);
    s?.live?.setBlocked(false);
    s?.questionCalls.forEach(releaseQuestion);
  });
  pi.events?.on(CHILD_TRACE_EVENT, (data: unknown) => {
    const e = (data ?? {}) as Record<string, unknown>;
    if (e.event === "test_restore") sessions.get(String(e.sessionId))?.trace?.emit({ event: e.event, cmd: e.cmd });
  });
  let isoSetting: unknown = "auto";
  const baseline = readBaseline(PKG_ROOT);
  // A child's launch binding is in the env while its extensions load (usage.ts); read it now.
  const launchBinding = readBinding(process.env);
  if (process.env.PI_SUBAGENT_CHILD === "1" && launchBinding?.scratch) process.env[SCRATCH_ENV] = launchBinding.scratch;
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
    // Owned dirs (owned.ts): the npm root resolves in the background and rebuilds the overlay once known.
    const tmpRoot = path.dirname(scratchRoot() ?? path.join(os.tmpdir(), "pi-foreman-scratch"));
    // close.worktreeDir (worktreeroot.ts): only a session in the main checkout takes it; a refused value or a collision falls back to the default layout with one visible notice
    // the Pi install root and the global npm root are protected roots only this side knows; the npm root joins when it resolves (below)
    const installRoot = await installRootOfPi();
    const rootInputsOf = (npmRoot: string | null) => sessionRootInputs(cwd, get(config.config, "close.worktreeDir"), { installRoot, npmRoot });
    // unresolved until the npm root is known (or failed): no owned custom root, so a root under the npm root is never briefly owned
    let rootInputs: ReturnType<typeof rootInputsOf> = {};
    const computeOwned = (npmRoot: string | null, resolved = true): OwnedRoots => {
      if (resolved) rootInputs = rootInputsOf(npmRoot);
      // while pending: block globs are always safe to add early; only the owned root waits
      const globs = resolved ? rootInputs.worktreeGlobs : rootInputsOf(null).worktreeGlobs;
      return ownedRoots({ agentDir, workspaceRoot: workspaceOf(cwd).root, tmpRoot, npmRoot, worktreeRoot: rootInputs.worktreeRoot, worktreeGlobs: globs });
    };
    const owned = computeOwned(null, false);
    // The Pi session files are written by the adapter only (pi.appendEntry): the current session's dir gets a write deny (permoverlay.ts sessionDir).
    const sessionDir = sessionDirOf(ctx);
    const buildOverlay = (o: OwnedRoots): OverlayRules | null => (baseline ? buildOverlayRules(baseline, get(config.config, "safety.permissions"), config.basePermissions, agentDir, PKG_ROOT, undefined, selfHost, o, sessionDir) : null);
    const warm = createWarm({ pi, pkgRoot: PKG_ROOT, isChild, bridgeTtl: () => bridgeTtlS, ctx: () => s.idleCtx, config: () => s.config.config, usage: () => s.usage, trace: (r) => s.trace?.emit(r), signals: () => warmSignals(s), queued: () => warmQueued(s), compact: () => idleCompact(s), contextTokens: () => s.idleCtx?.getContextUsage()?.tokens ?? null, contextWindow: () => s.idleCtx?.getContextUsage()?.contextWindow ?? null, driftPending: () => warmDriftPending(s), setGlyph: (on) => { if (s.isChild) return; if (s.idleCtx) idleBind = { s, ctx: s.idleCtx }; idleModel.setWarming(on); } });
    const s: Session = {
      id,
      cwd,
      isChild,
      agentDir,
      markerDir,
      python,
      config,
      configProvider: provider,
      overlay: buildOverlay(owned),
      owned,
      npmRootPending: true,
      ceremony: initialCeremony(get(config.config, "ceremony.default")),
      childExtensions: [],
      stopContinued: false,
      notified: new Set(),
      runs: new Map(),
      activeRuns: new Set(),
      pendingLaunches: new Set(),
      mutating: new Set(),
      commandCalls: new Set(),
      questionCalls: new Set(),
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
        cwd: () => s.prCtx?.cwd ?? s.cwd,
        child: () => !!process.env.PI_FOREMAN_HANDOFF_DIR?.trim(),
        fresh: async (key, cwd) => {
          const o = await prRun(s, cwd ?? s.prCtx?.cwd ?? s.cwd, "pr_status", { number: key.n, ...(key.repo ? { repo: key.repo, ...(key.host ? { host: key.host } : {}) } : {}) });
          const st = o.kind === "ran" ? o.result.state : null;
          return st === "open" || st === "merged" || st === "closed" ? st : "unknown";
        },
        // A child foreman session (handoff dir set) whose PR was merged closes itself (close.ts `pr-merged`, selffinish.ts).
        onMerged: (info) => {
          const handoff = process.env[HANDOFF_DIR_ENV]?.trim();
          const ctx = s.prCtx;
          if (!handoff || !ctx) return;
          const label = path.basename(handoff).replace(/^\d{8}-\d{6}-/, "");
          const file = path.join(handoff, "result.md");
          void close.start(ctx, { source: "pr-merged", file, shown: file, prompt: prMergedPrompt(file, info.key.n), pr: { n: info.key.n, parent: parentIntercomId(process.env), label: /^[A-Za-z0-9._-]{1,40}$/.test(label) ? label : "child" } }).catch(() => undefined);
        },
        persist: (watches) => pi.appendEntry(PRWATCH_ENTRY, { v: 2, piSessionId: s.id, watches }),
        send: (msg, idle) => pi.sendMessage(msg, idle ? { triggerTurn: true } : { deliverAs: "followUp" }),
        idle: () => s.prCtx?.isIdle() ?? true,
        trace: (r) => s.trace?.emit(r),
        intervalMs: () => watchIntervalMs(get(s.config.config, "tools.prWatchSeconds")),
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
      reviewGate: initialReviewGate(),
      finishRefusals: 0,
      waitingForParent: false,
      handoffWaits: new Set(),
      customSeen: new CustomSeen(),
      attention: new AttentionNotices(),
      climbRefusals: 0,
      reviewerFails: new ReviewerFails(),
      loopStop: null,
      planPhase: !isChild && process.env.PI_FOREMAN_PLAN_PHASE === "1",
      ceremonyEntry: JSON.stringify(emptyCeremonyState()),
      ceremonyRestored: false,
      failItems: [],
      critique: new CritiqueCounter(),
      budgetWarned: false,
      reviewRuns: { byCall: new Map(), byRun: new Map(), blocks: new Map(), findings: new Map(), sync: Promise.resolve() },
      panels: new PendingPanels({ send: (text) => pi.sendMessage({ customType: "pi-foreman-panel", content: text, display: true }, { triggerTurn: false }), trace: (r) => s.trace?.emit(r), extra: () => prChecksLine(s) }),
      reviews: [],
      reviewFailOpen: false,
      reviewSync: Promise.resolve(),
      reviewMarked: new Set(),
      passSnap: null,
      passMark: null,
      touchUps: new Set(),
      launchHeadsByCall: new Map(),
      launchHeads: new Map(),
      plan: null,
      script: newScriptState(),
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
      keepalive: new KeepaliveLog(),
      selfWarm: warm.selfWarm,
      presence: warm.presence,
      idleCtx: null,
      lastAssistantAt: null,
      running: false,
      childRuns: new ChildRuns(new UsageTail(usageFile(agentDir, foremanSession), loadPrices(PKG_ROOT))),
      live: null,
      show: null,
      openPrs: null,
      pressureSampler: null,
      pressureQ: null,
    };
    sessions.set(id, s);
    // `npm root -g` once per session, never awaited on the hot path; the overlay is rebuilt with the root when it resolves.
    void resolveNpmRoot({ spawn: defaultSpawner, env: process.env, platform, execPath: process.execPath })
      .then((npmRoot) => {
        s.owned = computeOwned(npmRoot);
        s.npmRootPending = false;
        s.overlay = buildOverlay(s.owned);
        if (rootInputs.notice && !isChild) notifyOnce(s, ctx, "worktree-root", rootInputs.notice, "warning");
      })
      .catch(() => {
        s.owned = computeOwned(null);
        s.npmRootPending = false;
        s.overlay = buildOverlay(s.owned);
      });
    if (!isChild) {
      if (ctx.mode === "tui" && footerStyleOf(get(s.config.config, "footer.style")) === "foreman") {
        try {
          ctx.ui.setFooter((tui, theme, data) => usageFooter.mount(id, ctx, tui, theme, data, () => pi.getThinkingLevel(), (model) => cacheSourceOf(s, model)));
        } catch {
          // the footer is cosmetic: Pi's own footer stays
        }
      }
      s.live = LiveState.start({ agentDir, sessionId: id, cwd, mode: ctx.mode, env: process.env }, () => s.childRuns.views(), () => usageFooter.totalsOf(id), () => { const w = waits.active(id); const prs = sessions.get(id)?.prWatches.list().map((p) => p.n) ?? []; return prs.length > 0 ? [...w, { id: "pr_watch", kind: "pr", note: `${prs.length} pr watch`, ageSeconds: 0, leftSeconds: 0, prs }] : w; }, () => { const x = sessions.get(id); if (!x) return null; const p = pressureOf(x); return p.level === "ok" ? null : p; }, () => { const x = sessions.get(id); return x ? x.extStatus.items().map((i) => ({ n: null, state: i.state, label: i.label, src: "ext" as const })) : []; });
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
      s.openPrs = new OpenPrsRefresher({ agentDir, config: () => get(s.config.config, "radar.openPrs"), ghHost: () => { const h = get(s.config.config, "tools.prHost") ?? "auto"; return h === "auto" || h === "gh"; }, gh: realGh(cwd), hosts: () => resolveGithubHosts(s.config.config) });
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
    if (s.isChild && get(config.config, "safety.children.mayPush") !== true) patchChildGitEnv(process.env);
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
      reviews: s.reviews,
      loopStop: s.loopStop,
      gate: { steps: { ...s.steps }, reviewGate: s.reviewGate, passMark: s.passMark },
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

  /**
   * The finish gate's progress of the same session (never a fork): the recorded `gate`, else, for an entry from before it was
   * recorded, rebuilt from the newest code review: a PASS counts as builder and reviewer done, and as revised when HEAD moved since.
   */
  function restoreGate(s: Session, e: CeremonyStateEntry): void {
    if (e.gate) {
      s.steps = { ...e.gate.steps };
      s.reviewGate = e.gate.reviewGate;
      s.passMark = e.gate.passMark;
      s.passSnap = e.gate.passMark?.tree ? { cwd: e.gate.passMark.cwd, tree: e.gate.passMark.tree } : null;
      return;
    }
    const last = e.reviews.findLast((r) => r.kind !== "plan");
    if (!last || last.verdict !== "pass") return;
    s.steps = { builder: Math.max(s.steps.builder, 1), reviewer: Math.max(s.steps.reviewer, 1) };
    s.reviewGate = { last: "pass", revised: false };
    if (last.head) s.reviewSync = s.reviewSync.then(async () => {
      const cur = await headOf(s.cwd);
      if (cur !== last.head && s.reviewGate.last === "pass") s.reviewGate = onRevision(s.reviewGate);
    });
  }

  /** session_start: what the latest ceremony-state entry of the branch brings back; an approval never on a fork. */
  function restoreCeremonyState(s: Session, ctx: ExtensionContext, reason: string): void {
    if (s.isChild) return;
    const e = latestCeremonyState((ctx.sessionManager.getBranch?.() ?? []) as unknown[]);
    s.ceremonyRestored = true;
    if (!e) return persistCeremonyState(s); // a plan phase entered through the env is recorded at once
    for (const l of e.lineages) s.planReviews.restore(l.path, { hash: l.hash, verdict: l.verdict, model: l.model, findings: Promise.resolve([]) }, l.rounds, l.reviews);
    s.planPhase = e.planPhase;
    if (s.reviews.length === 0) s.reviews.push(...e.reviews); // the PR gate's verdicts and heads (reviews.ts)
    s.loopStop = e.loopStop ?? null;
    if (reason !== "fork") restoreGate(s, e);
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
      const rec = restorableApproval(e.plan, "plan" in now ? now.plan.hash : null, roundStateDir(process.env));
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
    writeRoundState({
      handoffDir: dir,
      plan: plan ? { topic: plan.topic, hash: plan.hash } : null,
      planReview: l ? { hash: l.latest.hash, verdict: l.latest.verdict, model: l.latest.model, rounds: l.rounds } : null,
      round: s.round,
      ...(s.capsResetAt > 0 ? { capsResetAt: s.capsResetAt } : {}),
    });
  }

  /** session_start of a session opened by another session: what the reload file may bring back; the approval only from the parent's ruling.md. */
  function restoreRounds(s: Session, ctx: ExtensionContext, reason: string): void {
    const dir = roundStateDir(process.env);
    if (s.isChild) return;
    s.roundStateOn = true;
    if (!dir) return;
    const o = planOpts(s, ctx);
    const r = restoreRoundState(dir, (topic) => { const p = readPlan(path.join(o.scratchDir, `plan-${topic}.md`), o); return "plan" in p ? { path: p.plan.path, hash: p.plan.hash } : null; }, selfRulingsFor(s));
    if (!r) {
      // discarded: the file now holds the fresh state, so nothing of the old one can come back later
      if (fs.existsSync(path.join(dir, ROUND_STATE_FILE))) persistRounds(s);
      return;
    }
    s.round = r.round;
    s.capsResetAt = r.capsResetAt;
    // The session entry (restoreCeremonyState) comes first; this file only fills in when it restored no approval, and never on a fork.
    const a = s.plan?.status === "approved" || reason === "fork" ? null : r.approval;
    if (a) {
      s.plan = { topic: a.topic, path: a.path, hash: a.hash, status: "approved", approvedAt: new Date(a.at).toISOString(), by: "rig", source: path.basename(a.ruling) === PLAN_VERDICT_FILE ? "ruling-plan" : "ruling", note: `restored after reload from ${a.ruling}` };
      if (a.review && !s.planReviews.lineage(a.path)) s.planReviews.restore(a.path, { hash: a.review.hash, verdict: a.review.verdict, model: a.review.model, findings: Promise.resolve([]) }, a.review.rounds);
    }
    s.trace?.emit({ event: "round_state_restored", approval: a ? "ruling" : "none" });
    persistRounds(s);
  }

  /**
   * session_start after a reload or resume (R41 item 17): the checkpoint approval and the plan-review verdicts come back from the harness-only approval
   * store, keyed by the plan version hash of the plan files now in the scratch dir. A parent ruling is restoreRounds' business.
   */
  function restoreStoredPlans(s: Session, ctx: ExtensionContext): void {
    if (s.isChild || roundStateDir(process.env)) return; // the approval of a session opened by another session comes from the parent's ruling (restoreRounds), never from a stored human answer
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
    s.childExtensions = [{ id: ADAPTER_ID, path: ENTRY }, { id: GIT_GUARD_ID, path: GIT_GUARD_ENTRY }, ...extra.list.filter((e) => e.id !== ADAPTER_ID && e.id !== GIT_GUARD_ID)];
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

  async function run(s: Session, ctx: ExtensionContext, guard: GuardName, payload: unknown, toolFamily: string | null) {
    const env = buildGuardEnv({ base: process.env, coreDir: CORE_DIR, sessionId: s.id, guard, markerDir: s.markerDir, threshold: guard === "ledger_guard_spawn" ? gateThreshold(s.ceremony) : null });
    const started = Date.now();
    const r = guard === "git_guard"
      ? await runGitGuard({ python: pyPath(s), pkgRoot: PKG_ROOT, mode: "main", payload, env, cwd: ctx.cwd, spawner })
      : await runGuard({ python: pyPath(s), coreDir: CORE_DIR, guard, payload, env, cwd: ctx.cwd, spawner });
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
    recordIdentity(s, ctx, event.reason, restored);
    await initSkills(s);
    await mcpChild?.start(get(s.config.config, "roles"), (r) => s.trace?.emit(r), get(s.config.config, "mcp.directProviders"), get(s.config.config, "mcp.directMaxTools"));
    restoreToolFloor(s, ctx); // before the hidden set, so a floor tool that is also deferred is active when it is built
    initDeferred(s, ctx);
    restoreCeremonyState(s, ctx, event.reason);
    restoreRounds(s, ctx, event.reason);
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
    deferred.planMode = recorded ? recorded.planMode : planModeOn(branch);
    deferred.trace = (r) => s.trace?.emit(r);
    let declared: string[] = [];
    try {
      declared = pi.getActiveTools();
    } catch {
      // a host without the tool api hides nothing
    }
    // The hook runs only for an active tool_search, so without one nothing is hidden.
    // A child also hides the names its role makes searchable (the floor still wins).
    const patterns = s.isChild ? [...deferred.patterns, ...searchableOf(get(s.config.config, "roles"), s.usage.line.role)] : deferred.patterns;
    deferred.hidden = declared.includes("tool_search") ? hiddenSet({ patterns, declared, loaded: [...deferred.loaded], planMode: deferred.planMode }) : [];
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

  pi.on("session_shutdown", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s) return;
    asks.get(s.id)?.releaseAll();
    asks.delete(s.id);
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
    addonSeen.delete(s.id);
    if (!s.isChild) {
      syncKeepalives(s, ctx);
      idleModel.stop();
    }
    sweepScratch(s);
    closeChildAsks(s);
    await s.show?.idle();
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
    const r = await runScript(s, "foreman_retro.py", [...retroInputs(s, ctx, "--session", true), "--json"]);
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
      // ceremony.ledgerHelper "tool": reviewer roles learn to close V with foreman_ledger (instructions/reviewer.md).
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
        instructionsCache = fs.readFileSync(path.join(PKG_ROOT, "instructions", "foreman.md"), "utf8");
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
  pi.on("context_with_system", async (event, ctx) => {
    const s = sessionFor(ctx);
    if (s?.isChild) s.selfWarm.capture(event.messages); // a child replays its request unchanged
    if (!s || s.isChild) return undefined;
    let messages = keepSection(event.messages, "pi-foreman", s.foremanSection);
    // after a compaction the stored head lacks the stable hint sections too: put them back the same way
    for (const [name, text] of [[DEFERRED_SECTION, deferred.hint], [SKILLS_SECTION, skillState.hint]]) if (text) messages = keepSection(messages ?? event.messages, name, text) ?? messages;
    // a section that first appears mid-session sits in another place of Pi's replay than in the fresh build: align the order
    // providers with mid-conversation system messages render the head and each later patch apart: folding patches into the head would break their prompt cache
    const midConvo = (ctx.model as { compat?: { supportsMidConvoSystemMessages?: boolean } } | undefined)?.compat?.supportsMidConvoSystemMessages === true;
    let canonical: string | undefined;
    try {
      if (!midConvo) canonical = ctx.getSystemPrompt();
    } catch {
      // no prompt api: the order stays
    }
    if (typeof canonical === "string") messages = alignSections(messages ?? event.messages, canonical) ?? messages;
    s.selfWarm.capture(messages ?? event.messages);
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
    const strongA = s.activeRuns.size > 0 || s.pendingLaunches.size > 0 || launchWaits.holding > 0 ? "subagent" : w.some((x) => x.bg) || addonTasksRunning(s) ? "bg_task" : w.length > 0 ? "wait" : null;
    return { strongA, turn: s.running || !idle, question: s.questionCalls.size > 0, dialog: s.live?.isBlocked() === true, command: s.commandCalls.size > 0 };
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
    const limits = childReadLimits(s.config.config, role, launchBinding?.reads);
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
    if (!w) childAskWatches.set(s.id, (w = new ChildAskWatch((a) => answerChildAsk(s, ctx, a), (e) => reportChildAsk(s, e))));
    return w;
  };
  const closeChildAsk = (s: Session, launchId: string | null): void => {
    if (!launchId) return;
    const dir = childAskDir(s.agentDir, s.id, launchId);
    childAskWatches.get(s.id)?.remove(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const closeChildAsks = (s: Session): void => {
    childAskWatches.get(s.id)?.stop();
    childAskWatches.delete(s.id);
    fs.rmSync(childAskParentDir(s.agentDir, s.id), { recursive: true, force: true });
  };
  const reportChildAsk = (s: Session, e: ChildAskEvent): void => {
    const verdict = e.kind === "answered" ? (e.allow ? "allow" : "deny") : "deny";
    gateRuntimeOf(s).log.record({ tool: e.ask.tool, layer: "child-ask", verdict, rule: e.ask.entry || "ask", reason: `child run ${e.ask.run} (${e.ask.role}): ${e.kind}${e.detail ? ` ${e.detail}` : ""}`, input: e.ask.payload, role: e.ask.role, kind: "owner" });
  };
  /** The parent's answer to one child ask (r79 item 5): the owner dialog in the parent's own pane with the child's role, run and the full command; never a model. */
  async function answerChildAsk(s: Session, ctx: ExtensionContext, a: ChildAsk): Promise<ChildAnswer> {
    if (!ctx.hasUI) return { allow: false, reason: NO_PANE_TEXT };
    const rt = gateRuntimeOf(s);
    const dangerName = /^danger-[a-z-]+$/.test(a.cause) ? a.cause : null;
    const remember = dangerName ? rememberOf(dangerName, a.tool, a.payload, undefined, undefined, s.cwd) : undefined;
    const ans = await withBlocked(herdrEvents, `ask ${a.n}: child ${a.role} ${a.tool}`, () => askOwner({ tool: a.tool, payload: a.payload, cwd: a.cwd, cause: a.cause, ...(a.reason ? { classifierReason: a.reason } : {}), child: { role: a.role, run: a.run }, ...(remember ? { remember } : {}) }, ownerDeps(s, ctx, rt)));
    return ans.allow === true ? { allow: true } : { allow: false, reason: ans.reason };
  }
  let childAskChain: Promise<void> = Promise.resolve();
  pi.events?.on(SUPERVISOR_SURFACED_EVENT, (data: unknown) => launchWaits.onSupervisorRequest(data));
  pi.on("session_shutdown", async () => launchWaits.abortAll());

  for (const channel of RUN_END_EVENTS) {
    pi.events?.on(channel, (data) => {
      launchWaits.onRunEnd(data);
      for (const s of sessions.values()) {
        s.supervisor.onRunEnd(data);
        endActive(s.activeRuns, data);
        const runId = data && typeof data === "object" ? (data as { runId?: unknown }).runId : undefined;
        if (typeof runId === "string") s.attention.onRunEnd(runId);
        if (typeof runId === "string") {
          const ended = s.scratch.onRunEnd(runId);
          finishScratch(s, ended);
          closeChildAsk(s, ended);
        }
        if (typeof runId === "string" && !s.isChild) {
          s.childRuns.onRunEnd(runId);
          s.live?.touch();
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
          const reviewResults = s.isChild ? [] : reviewResultsOfRunEnd(data, reviewLaunch);
          const counted = s.isChild ? data : countingView(data, reviewResults);
          if (!s.isChild) s.reviewerFails.onRun(runId, reviewerTextsOfRunEnd(counted), boundLedger(s.markerDir, s.id));
          if (reviewResults.length > 0) recordRunFindings(s, runId, reviewResults);
          if (!s.isChild) {
            const roles = s.launchedRoles.get(runId) ?? [];
            // Lane 3f: review_done for every review run (re-reviews and panel shadows too, kind shadow); a review that ended without a result is a no-verdict.
            const done = reviewResults.length > 0 ? reviewResults.map((r) => ({ role: r.role, decision: r.verdict ?? "no-verdict", shadow: r.shadow !== null })) : roles.filter((r) => REVIEW_ROLES.includes(r)).map((role) => ({ role, decision: "no-verdict", shadow: shadowRun(reviewLaunch) }));
            for (const d of done) s.trace?.emit({ event: "review_done", role: d.role, decision: d.decision, runId, ...(d.shadow ? { kind: "shadow" } : {}) });
            // Item-only re-review: the failed items of the latest FAIL verdict, cleared by a pass.
            for (const r of reviewResults) if (r.counts) {
              s.trace?.emit(s.critique.onReview(r.text, r.role, runId, reviewLaunch?.lines));
              if (r.occasion === "item" || r.occasion === "pre-pr") s.ladder.stakeTags.clear(); // the work diff has been reviewed (a plan-review does not review it)
              const items = failedItemsOf(r.text);
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
          if (!shadowRun(reviewLaunch)) for (const step of stepsOfRunEnd(data)) s.steps[step]++;
          for (const f of frictionOfRunEnd(data)) s.trace?.emit({ event: "friction", role: f.role, runId: f.runId, kind: f.kind, note: f.note });
          const verdicts = reviewVerdictsOfRunEnd(counted);
          s.reviewGate = onReviewVerdicts(s.reviewGate, verdicts, Date.now(), runId);
          persistCeremonyState(s);
          if (!s.isChild) onRunEndReview(s, runId, counted, verdicts.length > 0);
          const cited = s.retro.launchItems.get(runId) ?? [];
          s.retro.launchItems.delete(runId);
          if (!s.isChild && verdicts.length) writeHint(boundLedger(s.markerDir, s.id), cited, `review ${verdicts.map((v) => (v ?? "no verdict").toUpperCase()).join(", ")} (run ${runId.slice(0, 8)})`, s.retro.hints, hintOpts(s));
        }
        if (!s.isChild && typeof runId === "string" && s.launchedRoles.has(runId)) {
          // PR gate: the verdict is recorded with HEAD of the run's cwd if unchanged since launch (reviews.ts).
          const start = s.launchHeads.get(runId);
          s.launchHeads.delete(runId);
          const counting = reviewResultsOfRunEnd(data, s.reviewRuns.byRun.get(runId)).filter((x) => x.counts && x.verdict !== null);
          let nth = 0;
          for (const r of reviewsWithOutput(countingView(data, reviewResultsOfRunEnd(data, s.reviewRuns.byRun.get(runId))))) {
            const full = counting[nth]?.role === r.role ? counting[nth] : undefined;
            const first = nth++ === 0;
            s.reviewFailOpen = r.verdict === "fail";
            s.reviewSync = s.reviewSync.then(async () => {
              const cwd = r.cwd ?? s.cwd;
              const h = reviewedHeadWhy(start, cwd, await headOf(cwd));
              const prev = s.reviews.findLast((x) => x.kind === "code");
              const top = await toplevelOf(cwd);
              const rec: ReviewRecord = { role: r.role, verdict: r.verdict, head: h.head, ...(top ? { cwd: top } : {}), ...(h.why ? { why: h.why } : {}), ...(await loopFieldsOf(s, runId, full, "code", worktreeTree(cwd))) };
              appendReview(s.reviews, rec);
              if (first) loopCheck(s, runId, prev, rec);
              // pi-subagents wrote the run's output file before this run-end event; the last line names the head the verdict covers
              if (r.outputPath) appendHeadLine(r.outputPath, h);
              s.trace?.emit({ event: "review_recorded", role: r.role, runId, verdict: r.verdict, head: h.head, why: h.why });
              persistCeremonyState(s);
            });
          }
        }
      }
    });
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
      const out = await onReviewRunEnd(
        {
          results,
          launch,
          context: { session: s.usage.line.foremanSession, agentDir: s.agentDir, runId, cwd, head, live: s.ladder.live.get("reviewer") ?? null, now: Date.now() },
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
  async function loopFieldsOf(s: Session, runId: string, r: ReviewResult | undefined, kind: ReviewKind, state: Promise<string | null>): Promise<Pick<ReviewRecord, "kind" | "state" | "sig">> {
    const fail = r?.verdict === "fail";
    const found = r && fail ? await (s.reviewRuns.findings.get(runId) ?? Promise.resolve([])).then((b) => b.find((x) => x.result.index === r.index)?.findings ?? [], () => []) : [];
    return { kind, state: (await state) ?? "", sig: r && fail ? sigOf(r.text, found) : [] };
  }

  /** Loop guard: the round just recorded (last of its kind in `s.reviews`) against `prev`, the last round of that kind before the run; a trip sets the stop. One round per run. */
  function loopCheck(s: Session, runId: string, prev: ReviewRecord | undefined, cur: ReviewRecord): void {
    if (!cur.kind) return;
    const rule = loopVerdict(prev ? { verdict: prev.verdict, state: prev.state ?? "", sig: prev.sig ?? [] } : null, { verdict: cur.verdict, state: cur.state ?? "", sig: cur.sig ?? [] });
    if (!rule) return;
    s.loopStop = { rule, kind: cur.kind, sig: cur.sig ?? [] };
    s.trace?.emit({ event: "review_loop", rule, kind: cur.kind, runId });
    persistCeremonyState(s);
  }

  /** A panel shadow launch (panel.ts): it never counts for steps, rounds or review_done. */
  function shadowRun(launch: ReviewLaunch | undefined): boolean {
    return !!launch?.bind;
  }

  /** Plan review (planreview.ts): each primary `[plan-review]` verdict is kept for the plan bytes on disk now; traced `plan_review`. */
  function recordPlanReviews(s: Session, runId: string, results: ReturnType<typeof reviewResultsOfRunEnd>): void {
    const opts = { cwd: s.cwd, home: os.homedir(), platform, scratchDir: editModeOfSession(s).scratchDir };
    const plans = planPathsOf(s.reviewRuns.byRun.get(runId)?.files ?? [], opts.scratchDir);
    for (const r of planReviewResults(results)) {
      s.trace?.emit({ event: "plan_review", model: r.model, decision: r.verdict });
      const findings = (s.reviewRuns.findings.get(runId) ?? Promise.resolve([])).then((b) => b.find((x) => x.result.index === r.index)?.findings ?? [], () => []);
      for (const p of plans) {
        const rp = readPlan(p, opts);
        if ("plan" in rp) {
          s.planReviews.record(rp.plan.path, { hash: planVersionHash(rp.plan.bytes), verdict: r.verdict, model: r.model, findings });
          const state = planVersionHash(rp.plan.bytes);
          s.reviewSync = s.reviewSync.then(async () => {
            const prev = s.reviews.findLast((x) => x.kind === "plan");
            const rec: ReviewRecord = { role: r.role, verdict: r.verdict, head: null, kind: "plan", state, sig: r.verdict === "fail" ? sigOf(r.text, await findings) : [] };
            appendReview(s.reviews, rec);
            loopCheck(s, runId, prev, rec);
          });
          const rounds = s.planReviews.lineage(rp.plan.path)?.rounds ?? 1;
          saveStored(s.agentDir, rp.plan.hash, rp.plan.topic, { review: { verdict: r.verdict, model: r.model, rounds } }); // survives /reload (checkpoint.ts)
        }
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

  /** Overlay check (see permoverlay.ts); undefined = let the call go on. */
  async function overlayBlock(s: Session, ctx: ExtensionContext, toolName: string, input: Record<string, unknown>, rulingAsk?: Decision, callId = "") {
    // R41: a call the gate decided has no overlay check, auto review or confirm; a self-ruling ask is not a gate matter and still resolves here
    if (gateDecided.delete(callId) && !rulingAsk) return undefined;
    if (!s.overlay) return { block: true as const, reason: OVERLAY_UNAVAILABLE };
    // the session's own bg_run task dirs (`.pi/tasks/<session id>-*`) are readable for the session and its children, no other session's
    // and the session cwd's `.pi/scratch` (log copies; a child's cwd is its worktree)
    const ownTasks = [...ownTaskReadable([ctx.cwd, workspaceOf(ctx.cwd).root, s.usage.line.workspace], s.usage.line.foremanSession, platform), ...piScratchReadable([ctx.cwd, (() => { try { return fs.realpathSync(ctx.cwd); } catch { return ctx.cwd; } })()], platform), ...bashOutputLogs(s.bashLogs, platform)];
    const hub = hubWorkflowReadable(get(s.config.config, "paths.hubWorkflow"), platform);
    if (s.isChild) s.skillDirs ??= childSkillDirs(get(s.config.config, "roles"), launchBinding?.role, ctx.cwd, os.homedir());
    const skillDirs = s.isChild ? await s.skillDirs : undefined;
    const mctx: MatchCtx = { cwd: ctx.cwd, home: os.homedir(), platform, role: s.isChild ? "child" : "main", scratch: s.isChild ? launchBinding?.scratch : undefined, ...(s.isChild && launchBinding?.handoffDir ? { handoffDir: launchBinding.handoffDir } : {}), ...(s.isChild && launchBinding?.install ? { install: true } : {}), ownTasks, ...(s.isChild ? (() => { const rounds = roundWorktrees(path.join(s.agentDir, "pi-foreman", "state"), s.usage.line.foremanSession, platform); const f = childSurface(rounds, ctx.cwd, launchBinding?.role, platform); return { roundRoots: f.write, roundReadRoots: f.read, ...(skillDirs?.length ? { skillDirs } : {}), ...(s.usage.line.workspace ? { foremanRoot: workspaceOf(s.usage.line.workspace).root } : {}), readable: [...childReadable(boundLedger(s.markerDir, s.usage.line.foremanSession), ownHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)), rounds, platform), ...mainWorkflowReadable(rounds, platform), ...hub] }; })() : { readable: hub, ownReads: [...ownUsageReadable(s.agentDir, platform, s.id, { dir: get(s.config.config, "trace.dir"), stateDir: s.markerDir }, s.usage.line.foremanSession), ...ownTaskReadable([ctx.cwd, workspaceOf(ctx.cwd).root, s.usage.line.workspace], s.usage.line.foremanSession, platform), ...asyncResultReads(s.childFiles, platform)] }) };
    const d0 = checkToolCall(s.overlay, toolName, input, mctx);
    if (s.isChild && toolName === "bash" && typeof input.command === "string" && mctx.install && npmCiWorktreeLabel(input.command, mctx)) s.trace?.emit({ event: "overlay_allow", rule: "npm-ci-worktree", role: s.usage.line.role });
    // R16 item 4a: the self-ruling ask (ruling.ts selfRulingAsk) takes the place of an overlay ask that is no self-modification
    const d = d0 && (d0.kind === "deny" || d0.selfMod) ? d0 : (rulingAsk ?? d0);
    const r = await resolveDecision(d, { isChild: s.isChild, mode: ctx.mode, hasUI: ctx.hasUI, confirm: blockedConfirm(herdrEvents, (title, msg) => ctx.ui.confirm(title, msg)) });
    if (d) {
      const df = denyFields((d as { reason?: unknown }).reason, toolName, input, s.isChild ? s.usage.line.role : "foreman", [PKG_ROOT, ctx.cwd]);
      const asked = !(r && d.kind === "deny");
      s.trace?.emit({ event: "overlay", toolFamily: toolName, decision: r ? (d.kind === "deny" ? "deny" : "ask-denied") : "ask-approved", ...(r || asked ? df : {}), ...(asked ? dialogFields(df.command) : {}) });
      if (d.kind === "ask") askFlag.overlay({ command: df.command, rule: d.rule, approved: !r, session: s.id });
    }
    if (s.isChild && r && d?.kind === "deny") return repeatedDeny(s, ctx, d.reason) ?? r;
    return r;
  }

  /** Child deny reasons per child session (one child run): count by exact reason (R12 item 4). */
  const childDenyCounts = new Map<string, number>();

  /**
   * R12 item 4: the second identical stop-eligible deny reason (exact string, matching REPEAT_STOP_REASONS) within one child run stops
   * that run (repeatRefusalStop); other deny reasons (cd outside the workspace, worktree paths, temp-dir writes ...) never stop it.
   */
  function repeatedDeny(s: Session, ctx: ExtensionContext, reason: string): { block: true; reason: string } | undefined {
    if (!s.isChild || !REPEAT_STOP_REASONS.some((re) => re.test(reason))) return undefined;
    // a path rule of a custom worktree root (s.owned.worktreeGlobs) is a worktree path like `*.worktrees/*`: never stop-eligible
    if ((s.owned.worktreeGlobs ?? []).some((g) => reason.includes(`path rule '${g}'`))) return undefined;
    const key = `${s.id}\0${reason}`;
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
    return {
      worktree: tree ?? workspaceOf(cwd).root,
      scratch: s.isChild ? (launchBinding?.scratch ? [launchBinding.scratch] : []) : s.scratch.live(null),
      tmp: tmpRoots(os.tmpdir(), platform, real),
      scratchBase: s.owned.childScratchRoot,
      owned: [...owned.write, ...owned.read, ...extraReadDirs],
      install: [pi.installRoot, pi.npmRoot, ...BUNDLED_PACKAGE_ROOTS.map((r) => path.join(PKG_ROOT, r))].filter((x): x is string => !!x),
      roundFlow: mainWorkflowReadable(rounds, platform).filter((d) => !d.endsWith("/*")),
      handoffs: ownHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)),
      ...(s.isChild && launchBinding?.handoffDir ? { childHandoff: launchBinding.handoffDir } : {}),
      openedHandoffs: openedHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)),
      child: s.isChild,
      ...(s.isChild && process.env.FOREMAN_CHECKOUT ? { checkout: process.env.FOREMAN_CHECKOUT } : {}),
      agentDir: s.agentDir,
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
  /** Tool calls the gate decided (allow); the old overlay skips them. */
  const gateDecided = new Set<string>();
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
    }
    const rt = gs ? gateRuntimeOf(gs) : undefined;
    const resolved = rt ? rt.store.resolve() : undefined;
    if (gs && rt) for (const n of rt.store.drainNotices()) notifyOnce(gs, ctx, n, n);
    const roots = gs ? await gateRootsOf(gs, ctx.cwd, sessionDirOf(ctx), resolved?.additionalDirectories, resolved?.workFolders) : undefined;
    const configured = ((v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []))(gs ? get(gs.config.config, "safety.git.protectedBranches") : undefined);
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
      env: (cwd) => baseFloorEnv(cwd, { ...(gs?.agentDir ? { agentDir: gs.agentDir } : {}), ...(roots?.sessionDir ? { sessionDir: roots.sessionDir } : {}), pkgRoot: PKG_ROOT, protectedBranches: configured, ...(gs?.isChild ? { child: true } : {}) }),
      ...(roots ? { roots: () => roots, facts: gateFacts ?? { ...gitFacts, protectedBranches: (cwd: string) => [...gitFacts.protectedBranches(cwd), ...configured] } } : {}),
      ...(resolved ? { rules: { sets: resolved.rules, env: { cwd: ctx.cwd, home: os.homedir(), platform, checkout: rt ? rt.store.main() : ctx.cwd } } } : {}),
      ...(resolved?.protected.length ? { protected: resolved.protected } : {}),
    });
    const r = out.result;
    const role = gs?.isChild ? gs.usage.line.role : "foreman";
    const kind: GateKind = gs?.isChild ? "child" : ctx.hasUI ? "owner" : "headless";
    const payload = gatePayload(event.toolName, event.input);
    const note = (layer: GateLayer, verdict: string, rule: string, reason?: string): void => rt?.log.record({ tool: event.toolName, layer, verdict, rule, ...(reason ? { reason } : {}), input: payload, role, kind });
    if (r && "block" in r) {
      gs?.trace?.emit({ event: "guard", guard: "gate", toolFamily: event.toolName, decision: "blocked", rule: r.rule, ...denyFields(r.reason, event.toolName, event.input, role, [PKG_ROOT, ctx.cwd]) });
      note(r.layer ?? "floor", "deny", r.rule, r.reason);
      return (gs && (repeatedDeny(gs, ctx, r.reason) ?? undefined)) || { block: true as const, reason: r.reason };
    }
    // no session: no dialog, classifier or log to decide with, and the overlay below is no replacement for the gate; floors and rules ran above
    if (!gs || !rt || !resolved) return { block: true as const, reason: "pi-foreman: this tool call has no session to decide it in, so it is denied. Report this to the owner." };
    const allowed = (rule: string, layer: GateLayer, label: string, folder = false, reason?: string): undefined => {
      gs.trace?.emit({ event: "guard", guard: "gate", toolFamily: event.toolName, decision: "allowed", rule: label, role, ...(folder ? { mode: "auto", source: "workFolder" } : {}) });
      if (layer !== "classifier" && layer !== "cache") note(layer, "allow", rule, reason); // the classifier logs its own record
      gateDecided.add(event.toolCallId);
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
      if (((r && "ask" in r) || out.danger) && (event.toolName === "bash" || event.toolName === "powershell" || event.toolName === FOREMAN_BG_TOOL || event.toolName === ADDON_BG_TOOL)) {
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
        const readOnly = !m.opaque && !m.remoteOpaque && m.classes.length > 0 && [...m.classes, ...m.remoteClasses].every((c) => c === "read" || c === "net-read");
        let away = true;
        let askCause = `${named} is protected.`;
        try {
          // away fails closed: a child or headless session, presence off or unknown, an away or stale sample
          if (!gs.isChild && ctx.hasUI && get(gs.config.config, "presence.enabled") !== false) {
            if (!readOnly) await gs.presence.refresh().catch(() => undefined);
            away = sampleAway(gs.presence.sample(), gs.presence.away(), Number(get(gs.config.config, "presence.awayAfterMinutes")) || 11, Date.now());
          }
          const checkRaw = get(gs.config.config, "gate.protected.check");
          const checkMode: "model" | "read-only" | "ask" = checkRaw === "ask" || checkRaw === "read-only" ? checkRaw : "model";
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
            opaque: m.opaque || m.remoteOpaque, effect: v.effect, confidence: v.confidence, verdict: v.verdict, accepted: v.accepted, away, cached: v.cached, reason: v.reason, model: v.model, latencyMs: v.latencyMs, role,
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
            opaque: m.opaque || m.remoteOpaque, accepted: "ask", cause: "exception", away, globs: m.entries.map((x) => x.glob).join(","),
            ...denyFields(msg.slice(0, 200), event.toolName, event.input, role, [PKG_ROOT, ctx.cwd]),
          });
        }
        gs.trace?.emit({ event: "guard", guard: "gate", toolFamily: event.toolName, decision: "ask", rule, role });
        return await decideByDialog(gs, ctx, rt, resolved, { ...base, cause: askCause, noRemember: true });
      }
      // an ask-kind floor, a self-modification rule and an ask rule go to the owner before the mode step (never to the classifier, never run under mode allow; only a protected match above runs a check first)
      if (r && "ask" in r) {
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
        const v = await rt.classifier.classify(
          { tool: event.toolName, payload, reason: cause, kind, role, cwd: ctx.cwd, worktree: workspaceOf(ctx.cwd).root, branch: facts.branch, remotes: facts.remotes, ...(ownerMessage ? { ownerMessage } : {}) },
          {
            prose: resolved.prose, registry: ctx.modelRegistry as never, config: gs.config.config as never, provider: ctx.model?.provider, log: rt.log,
            recordUsage: (m) => appendUsage(gs.usage.file, usageLine({ ...gs.usage.line, role: CLASSIFIER_ROLE, launchId: null, kind: "foreman" }, m as never)),
            trace: (t) => gs.trace?.emit({ event: "review", kind: "gate", ...t }),
            notify: (text) => notifyOnce(gs, ctx, "no-classifier-model", text),
            stamp: () => {
              try {
                return String(fs.statSync(rt.store.filePath("user")).mtimeMs);
              } catch {
                return "none";
              }
            },
          },
        );
        if (v.verdict === "allow") return allowed(`prose:${v.entry}`, v.cached ? "cache" : "classifier", `classifier:${v.entry}`);
        if (v.verdict === "deny") return denied(`prose:${v.entry}`, "classifier", v.text);
        classifierReason = v.reason || v.detail;
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
    allowed: (rule: string, layer: GateLayer, label: string) => undefined;
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
  function ownerDeps(s: Session, ctx: ExtensionContext, rt: GateRuntime): OwnerDeps {
    return {
      ui: ctx.ui as unknown as OwnerDeps["ui"],
      presence: s.presence,
      presenceEnabled: get(s.config.config, "presence.enabled") !== false,
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
      return allow ? (a.allowed(rule, "dialog", `dialog:${answer}`), undefined) : a.denied(rule, "dialog", reason ?? "pi-foreman: denied.");
    };
    if (kind === "child") {
      const askDir = launchBinding?.askDir;
      if (!askDir || get(gs.config.config, "gate.childAsk") !== "parent") return done("no-parent", false, `${NO_PANE_TEXT} The call was: ${cause}.`);
      const t = get(gs.config.config, "gate.askTimeoutMs");
      const timeoutMs = typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : DEFAULT_ASK_TIMEOUT_MS;
      const turn = childAskChain; // one ask.md at a time: parallel tool calls of the child queue here
      let free: () => void = () => {};
      childAskChain = new Promise<void>((r) => (free = r));
      await turn;
      try {
        const askCause = a.dangerName ?? (cause === "no rule matches" || cause.startsWith("rule ") ? cause : cause.startsWith("self-modification") ? "selfmod" : cause);
        const n = writeChildAsk(askDir, { tool, payload, cwd: ctx.cwd, session: gs.id, cause: askCause, reason: a.classifierReason ?? cause, role, run: launchBinding?.launchId, deadline: Date.now() + timeoutMs });
        const notBefore = fs.statSync(path.join(askDir, "ask.md")).mtimeMs;
        const w = await withBlocked(herdrEvents, `ask ${n}: gate ${tool}`, () => awaitChildRuling(askDir, n, timeoutMs, 250, notBefore, () => gs.presence.away()));
        if (w.answer === "allow") return done("parent-allow", true);
        if (w.answer === "away") return done("parent-away", false, OWNER_AWAY_TEXT);
        if (w.answer === "timeout") return done("parent-timeout", false, `pi-foreman: denied: the parent did not answer within ${Math.round(timeoutMs / 1000)}s (gate.askTimeoutMs); the call is denied. Report this line to the foreman and continue with what you can.`);
        return done("parent-deny", false, w.answer === "deny" ? `pi-foreman: denied by the parent${w.reason ? `: ${w.reason}` : "."} Report this line to the foreman and continue with what you can. The ask was ${cause}${tool === "bash" ? (n2 => (n2 ? ` ${n2}` : ""))(childNpmNote(String((input as Record<string, unknown> | undefined)?.command ?? ""), launchBinding?.install === true)) : ""}` : `pi-foreman: denied: the parent's ruling-${n}.md starts with "${(w.first ?? "").slice(0, 40)}", not ALLOW or DENY.`);
      } catch (e) {
        return done("parent-deny", false, `pi-foreman: the ask for the parent could not be written (${e instanceof Error ? e.message : String(e)}); the call is denied. Report this line to the foreman.`);
      } finally {
        free();
      }
    }
    if (kind !== "owner") return done("no-ui", false, NO_PANE_TEXT); // no UI: an immediate deny
    const remember = a.noRemember ? undefined : rememberOf(a.dangerName ?? "unmatched", tool, payload, input, a.segments, ctx.cwd);
    const ans: OwnerAnswer = await withBlocked(herdrEvents, `pi-foreman: ${tool} asks`, () => askOwner({ tool, payload, cwd: ctx.cwd, cause, ...(a.classifierReason ? { classifierReason: a.classifierReason } : {}), ...(remember ? { remember } : {}) }, ownerDeps(gs, ctx, rt)));
    if (ans.allow === true) return done(ans.how === "remember" ? "allow-remember" : "allow-once", true);
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
  async function protectEntry(s: Session, ctx: ExtensionContext, a: { action: unknown; kind: unknown; glob: unknown; note?: unknown; file?: unknown }): Promise<{ ok: boolean; text: string }> {
    const no = (text: string) => ({ ok: false, text: `pi-foreman: not changed: ${text}` });
    if (s.isChild) return no("children never change the protected targets; the owner does, with /foreman perms protect.");
    if (a.action !== "add" && a.action !== "remove") return no("action must be add or remove");
    if (a.file !== undefined && a.file !== "project" && a.file !== "user") return no("file must be project or user");
    const clean = cleanProtected({ kind: a.kind, glob: a.glob, note: a.note });
    if (typeof clean === "string") return no(clean);
    if (!ctx.hasUI) return no("there is no pane to ask the owner in; the owner runs /foreman perms protect add|remove <kind> <glob> in the foreman session.");
    const file = a.file === "user" ? "user" : "project";
    const rt = gateRuntimeOf(s);
    const cur = rt.store.resolve();
    const existing = cur.protected.find((e) => e.kind === clean.kind && e.glob === clean.glob);
    const where = file === "user" ? rt.store.filePath("user") : cur.projectFile;
    if (a.action === "remove" && !existing) return no(`${clean.kind} ${clean.glob} is not protected`);
    if (a.action === "add" && existing) return no(`${clean.kind} ${clean.glob} is already protected (${existing.id})`);
    const text = a.action === "add"
      ? `Protect ${clean.kind} ${clean.glob}${clean.note ? ` (${clean.note})` : ""} in ${where}? For this target an accepted check allow replaces your ask rules, the dangerous-class whitelist and the ask/deny mode; reads are allowed when the check rates them read-only, writes and deploys only while you are present. Floors and deny rules still apply.`
      : `Remove ${existing?.id} ${clean.kind} ${clean.glob}? Its calls go back to your ask rules and the dangerous class.`;
    let yes = false;
    try {
      const confirm = blockedConfirm(herdrEvents, (title, msg) => ctx.ui.confirm(title, msg));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PROTECT_CONFIRM_MS); timer.unref?.(); });
      yes = (await Promise.race([confirm("Protected target", text), timeout])) === true;
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

  const SHELL_GATE_TOOLS = new Set(["bash", "foreman_bg", "bg_run", "powershell"]);
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
    // A session never writes a ruling file in a handoff dir where it is the child (ruling.ts): a literal path is refused here,
    // a line that writes and names a ruling and a handoff dir is an overlay ask (selfRulingAsk, judged in overlayBlock).
    let rulingAsk: Decision | undefined;
    {
      const rs = sessionFor(ctx);
      const why = rs && selfRulingRefusal(event.toolName, event.input as Record<string, unknown>, ctx.cwd, childDirsOf(rs));
      if (why) {
        rs.trace?.emit({ event: "guard", guard: "self_ruling", toolFamily: event.toolName, decision: "blocked", ...denyFields(`self_ruling: ${why}`, event.toolName, event.input, rs.isChild ? rs.usage.line.role : "foreman", [PKG_ROOT, ctx.cwd]) });
        return repeatedDeny(rs, ctx, why) ?? { block: true, reason: `pi-foreman: ${why}.` };
      }
      rulingAsk = rs ? selfRulingAsk(event.toolName, event.input as Record<string, unknown>, childDirsOf(rs), { cwd: ctx.cwd, orchestrator: !rs.isChild }) : undefined;
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
    // First of all, before the permission system and the core guards: the overlay's deny/ask rules.
    if (isOverlayTool(event.toolName)) {
      try {
        const blocked = await overlayBlock(await ensureSession(ctx), ctx, event.toolName, event.input as Record<string, unknown>, rulingAsk, event.toolCallId);
        if (blocked) return blocked;
      } catch (err) {
        return { block: true, reason: `pi-foreman: adapter error in the permission overlay (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
      }
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
    if (event.toolName === "bash" || event.toolName === "powershell" || event.toolName === FOREMAN_BG_TOOL || event.toolName === ADDON_BG_TOOL) {
      // foreman_bg and the add-on's bg_run are checked as a bash call: the same script, the same verdicts.
      const shellWrite = await shellWriteBlock(ctx, event.toolName === "powershell" ? "powershell" : "bash", event.input as Record<string, unknown>);
      if (shellWrite) return shellWrite;
    }
    if (OUTWARD_TOOLS.has(event.toolName)) {
      const triage = await triageBlock(ctx, event.toolName, event.input as Record<string, unknown>, event.toolCallId);
      if (triage) return triage;
    }
    if (isPrToolName(event.toolName) && !isPackPrCreate(event.toolName) && mapTool(event.toolName).pre.length === 0) {
      // A package tool that creates a pull request: the same review test as the git guard, against workspace HEAD.
      try {
        const s = await ensureSession(ctx);
        if (!s.isChild) await s.reviewSync;
        const refusal = await prGateRefusal({ tool: event.toolName, isChild: s.isChild, gateOn: get(s.config.config, "ceremony.reviewBeforePr") !== false, reviewed: passHeads(s.reviews), headless: headlessPass(s.reviews), cwd: ctx.cwd, input: event.input as Record<string, unknown> });
        if (refusal) {
          s.trace?.emit({ event: "pr_refused", reason: refusal.reason, toolFamily: event.toolName });
          return { block: true, reason: refusal.message };
        }
      } catch (err) {
        return { block: true, reason: `pi-foreman: adapter error in the PR gate (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
      }
    }
    const mapping = mapTool(event.toolName);
    if (mapping.pre.length === 0) return undefined;
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
      let sizingClimbs: ReadonlySet<Json> = new Set();
      let sizingTop: string | null = null;
      let occasions = new Map<Record<string, unknown>, Occasion>();
      let panel: ReturnType<typeof primaryPanel> = null;
      let shadow: ShadowDecision = { kind: "none" };
      if (event.toolName === "subagent") {
        // D8: only the adapter writes the pi-foreman usage binding (single launches, below).
        stripBinding(input);
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
        mcpNotes.push(...flags.notes);
        launchFlags = flags.entries.get(input) ?? {};
        const flagRole = singleLaunchRole(input);
        if (flagRole) {
          const a = launchReadAllowance(s.config.config, flagRole, { reads: launchFlags.reads, files: sized.entries.get(input)?.size?.files.length });
          if (a.clamped) mcpNotes.push(`pi-foreman: reads ${launchFlags.reads} is above the maximum; the read allowance is ${a.allowance}.`);
          launchFlags = { ...launchFlags, reads: a.allowance };
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
        const mcpPlan = planMcpLaunch(input, get(s.config.config, "roles"), { perEntryBindings: PER_ENTRY_BINDINGS });
        if (mcpPlan.refusal) {
          s.trace?.emit({ event: "launch_refused", reason: mcpPlan.refusal.reason, tier: s.ceremony.tier, ...launchDeny(input) });
          return { block: true, reason: mcpPlan.refusal.text };
        }
        launchMcp = mcpPlan.mcp;
        if (!mcpPlan.group && mcpPlan.entries[0]) {
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
          if (p.level === "critical") {
            const args = rawLaunch;
            const w = await waits.startPressure(ctx, { kind: "pressure", mode: "critical", args: [args], pollMs: sampleSecondsOf(s.config.config) * 1000, boundSeconds: CRITICAL_WAIT_SECONDS, note: "launch deferred" });
            s.trace?.emit({ event: "launch_deferred", level: p.level, reasons: p.reasons.join(",") });
            return { block: true, reason: `${criticalReason(p.reasons)}${"error" in w ? ` (no wait could be started: ${w.error}; relaunch with: ${JSON.stringify(args)})` : ""}` };
          }
          if (p.level === "high") {
            const queued = await narrowLaunch(s, ctx, event.toolCallId, input, rawLaunch, p);
            if (queued) return { block: true, reason: queued };
          }
        }
        // D6: pi-subagents' isolation worktree is a plain `git worktree add` of the innermost repo; inside a nested submodule checkout it would not carry the tree
        if (!s.isChild && isLaunchArgs(input) && launchNeedsNestedRefusal(rawLaunch, ctx.cwd)) {
          return { block: true, reason: "pi-foreman: worktree: true is refused inside a nested submodule checkout (the isolation worktree would hold only that submodule); launch without worktree: true — the round's own tree is the workspace." };
        }
        // Review occasions (occasion.ts) from the task markers, before any rewrite or facts block.
        if (!s.isChild && actionOf(input) === null) occasions = entryOccasions(input);
        // Review panel (panel.ts): a `[panel-shadow:<model>]` launch binds to a pending panel and gets the primary's task, or is refused.
        const foremanAt = foremanBaseModel(ctx);
        shadow = shadowLaunch(input, s.panels.views(), { config: s.config.config, isChild: s.isChild, maxThinking: get(s.config.config, "maxThinking"), childMaxThinking: get(s.config.config, "childMaxThinking"), refused: (m) => rankRefusalFor(s.config.config, foremanAt, m, ["reviewer"])?.message ?? null });
        if (shadow.kind === "refused") {
          s.trace?.emit(shadow.trace);
          return { block: true, reason: shadow.message };
        }
        if (shadow.kind === "launch") input.task = shadow.task;
        // ceremony.reviewPerRevision (D5): a second review of unchanged, already passed work is refused (a pre-pr or plan review is no repeat).
        const ownOccasion = [...occasions.values()].some((o) => o === "pre-pr" || o === "plan-review");
        const dup = !s.isChild && !ownOccasion && shadow.kind !== "launch" && get(s.config.config, "ceremony.reviewPerRevision") !== false ? dupReview(s.reviewGate, launchRoles(s, input), input) : null;
        if (dup) {
          const agent = [...new Set(launchRoles(s, input).filter((r) => REVIEW_ROLES.includes(r)))].join(",");
          if (dup === "second-opinion") s.trace?.emit({ event: "review_second_opinion", agent });
          else {
            // The mark is taken asynchronously at the PASS; wait for it, then compare builder runs, HEAD, worktree (incl. untracked) and ledger.
            await s.reviewSync;
            const mark = s.passMark;
            const signals = mark ? repeatSignals(mark, { head: await headOf(mark.cwd), tree: mark.tree && (await treeChangedSince(mark.cwd, mark.tree)) ? "changed" : mark.tree, ledger: boundLedger(s.markerDir, s.id), builderRuns: s.steps.builder }) : [];
            if (signals.length > 0) s.trace?.emit({ event: "review_dup_allowed", agent, signals: signals.join(",") });
            else {
              s.trace?.emit({ event: "review_dup_refused", agent });
              return { block: true, reason: dupRefusalText(mark?.at) };
            }
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
            return { block: true, reason: loopRefusal(s.loopStop) };
          }
          if (s.failItems.length > 0) for (const [e, occ] of occasions) if (occ === "item" && typeof e.agent === "string" && REVIEW_ROLES.includes(e.agent) && typeof e.task === "string") e.task = prependReReview(e.task, s.failItems);
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
          rounds = walkLaunch(s.round, steps);
          // A further fresh builder in the same prompt, after a revision already answered the open FAIL, is a revision too (no extra round).
          const again = !resumed && rounds.revisions === 0 && answeredBefore && s.reviewGate.last === "fail" && steps.some((g) => g.includes("builder"));
          const revision = rounds.revisions > 0 || again;
          const keyword = typeof input.model === "string" && (STRENGTHS as readonly string[]).includes(splitLevel(input.model.trim()).base);
          // ladder.ts revisionClimb: review_fail while the review gate's latest verdict is FAIL (s.reviewGate.last, not the run's own
          // verdict), else only with providers.<p>.strongOnRevision true. LadderState.plan targets max(current, strong) by rank.
          revClimb = revision && !resumed ? revisionClimb(s.config.config, resolution.provider, s.reviewGate.last === "fail") : null;
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
          const lp = s.ladder.plan(input, resolution.roles, { tier: s.ceremony.tier, preferStrong: revClimb !== null, revisionReason: revClimb ?? undefined, ranks: ranksOf(s.config.config), sizing: sizingClimbs });
          if (lp.block) {
            s.trace?.emit({ event: "launch_refused", reason: "strong_no_reason", tier: s.ceremony.tier, ...launchDeny(input) });
            return { block: true, reason: lp.block };
          }
          climbs = lp.climbs;
          ladderRoles = resolution.roles;
          // ladder.reviewerClimb (reviewerclimb.ts): the reviewer's diff is taken here, before its model is picked; the facts reuse it.
          await s.reviewRuns.sync; // earlier run ends' findings are recorded (and traced) first
          const rc = await planReviewerClimbs(input, resolution.roles, { config: s.config.config, live: s.ladder.live, fails: s.reviewerFails, diffOf: async (e) => { const d = await reviewFacts.diffOf(e, input, ctx.cwd); return d.diff || d.untracked ? (d.diff ?? "") + d.untracked : null; } });
          reviewerClimbs = rc.climbs;
          reviewerTraces = rc.traces;
        }
        const foremanAt0 = foremanBaseModel(ctx);
        const explicitReviewers = new Set<string>(); // base ids the launch call set explicitly and explicitModelAllowed honoured (a pair never replaces them)
        const launched = applyLaunchModels(input, resolution.roles, get(s.config.config, "maxThinking"), { tier: s.ceremony.tier, provider: resolution.provider, preferStrong, childMaxThinking: get(s.config.config, "childMaxThinking"), explicit: (role, m) => { const ok = explicitModelAllowed(s.config.config, foremanAt0, m, role); if (ok && role === "reviewer") explicitReviewers.add(m); return ok; } });
        for (const n of launched.notices) bottomWhy.set(n.role, noStrong);
        if (bottomWhy.size > 0) pendingBottom = bottomWhy;
        if (sizedPlans.length > 0) {
          // The top rung is written after the mapped models, like the research floor; its rung_up names it.
          for (const p of sizedPlans) {
            if (!p.combo.climb || p.target !== "top" || !sizingTop) continue;
            p.entry.model = sizingTop;
            for (const c of climbs) if (c.entry === p.entry) c.to = splitLevel(sizingTop).base;
          }
          const rungs: RungContext = { roles: resolution.roles, ranks: ranksOf(s.config.config), top: sizingTop };
          sizingRecords = sizedPlans.map((p) => sizingTrace(p, p.role === "builder" && typeof p.entry.model === "string" ? (rungOfModel(p.entry.model, rungs) ?? "default") : "default"));
        }
        // A panel shadow runs on its own model (rank-checked in shadowLaunch): no occasion override, rank loop or different-model rule.
        if (shadow.kind === "launch") input.model = shadow.model;
        else if (!s.isChild && actionOf(input) === null) {
          // ceremony.reviewByOccasion (reviewerclimb.ts): over the mapped models, before the rank check and the different-model rule.
          const reviewerEntries = launchEntries(input).filter((e) => e.agent === "reviewer" && typeof e.model === "string");
          const pinned = new Map<Json, ReviewPin>(reviewerEntries.filter((e) => explicitReviewers.has(splitLevel(e.model as string).base)).map((e) => [e, "explicit"]));
          // High stakes (reviewerclimb.ts stakeOf): the work diff is the one the security climb takes (taken once per entry).
          const stakes = new Map<Json, Stake>();
          for (const [e, o] of occasions) {
            if (e.agent !== "reviewer") continue;
            // Already high stakes by occasion: the diff only adds the sensitive_path reason, traced when highStakes.model applies.
            const needDiff = !(o === "plan-review" || o === "second-opinion") || highStakesConfig(s.config.config).model !== null;
            const d = needDiff ? await reviewFacts.diffOf(e, input, ctx.cwd) : { diff: null as string | null, untracked: "" };
            const st = stakeOf(o, s.ceremony.tier, s.ladder.stakeTags, d.diff || d.untracked ? (d.diff ?? "") + d.untracked : null, s.config.config);
            if (st) stakes.set(e, st);
          }
          const occ = applyOccasionOverrides(input, occasions, reviewerClimbs, { config: s.config.config, maxThinking: get(s.config.config, "maxThinking"), childMaxThinking: get(s.config.config, "childMaxThinking"), stakes });
          reviewerTraces.push(...occ.traces);
          for (const e of occ.overrode) pinned.set(e, "occasion");
          // [research] / [fact-critical] markers (research.ts): the floor is written before the rank check.
          const marked = markedEntries(input);
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
            const marker = floorMarker(raised, m);
            s.trace?.emit({ event: "launch_refused", reason: "rank_policy", ...launchDeny(input), policy: no.policy, foreman: no.foreman, requested: no.requested, ...(marker ? { marker } : {}) });
            return { block: true, reason: marker ? `${no.message} The [${marker}] marker raised this entry to its role's strong rung, which the rank policy refuses; drop the marker or map a strong rung the policy allows.` : no.message };
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
        notices = launched.notices.map((n) => n.text);
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
      for (const guard of mapping.pre) {
        let agents: string[] = [];
        if (guard === "destructive_guard") {
          const bad = guardPayloadBlock(event.toolName, input);
          if (bad) return { block: true, reason: bad };
        }
        if (guard === "ledger_guard_spawn") {
          agents = subagentAgents(input);
          // Plan phase: explorers research before any ledger exists; the core gate would ask for one, so it is not called for them.
          if (s.planPhase && !s.isChild && agents.length > 0 && agents.every((a) => a === "explorer") && !boundLedger(s.markerDir, s.id)) {
            s.trace?.emit({ event: "plan_phase_explorer", role: "explorer" });
            continue;
          }
          setCeremony(s, beforeSpawn(s.ceremony, agents, trivialBuilderPath(get(s.config.config, "ceremony.required"))));
        }
        // Children get the git guard in child mode from extensions/git-guard; main mode is the foreman lint.
        if (guard === "git_guard" && (s.isChild || !mainNeedsGitGuard(input.command))) continue;
        if (guard === "git_guard") {
          const drift = await s.gitDrift.gate(ctx.cwd, os.homedir(), "this git command", driftAsk(ctx, s.trace), (r) => s.trace?.emit(r), event.toolCallId);
          if (drift) return drift;
        }
        if (guard === "git_guard") await s.reviewSync;
        const prGate = { enabled: get(s.config.config, "ceremony.reviewBeforePr") !== false, reviewed_heads: passHeads(s.reviews), reviewed_checkouts: passCheckouts(s.reviews) };
        const payload = guard === "git_guard" ? gitGuardPayload(event.toolName, input, pc, get(s.config.config, "safety.git"), prGate) : preToolPayload(event.toolName, input, pc);
        if (guard === "ledger_guard_spawn") {
          (payload.tool_input as Record<string, unknown>).prompt = callerTask;
          payload.permission_mode = spawnPermissionMode(planModeOn(ctx.sessionManager.getBranch?.() ?? []), agents);
        }
        const outcome = await run(s, ctx, guard, payload, mapping.coreName);
        if (guard === "destructive_guard" && outcome.kind === "decision" && dropDeadPathRewrite(outcome.d, input.command, os.homedir())) {
          s.trace?.emit({ event: "guard_rewrite_dropped", guard, toolFamily: mapping.coreName });
        }
        const target = guard === "ledger_guard_write" ? resolveToolPath(input.path, ctx.cwd, os.homedir()) : null;
        const t = await translateToolCall({
          guard,
          outcome,
          piTool: event.toolName,
          input,
          ask: { isChild: s.isChild, mode: ctx.mode, hasUI: ctx.hasUI, confirm: blockedConfirm(herdrEvents, (title, msg) => ctx.ui.confirm(title, msg)) },
          ledgerTarget: target ? isLedgerTarget(target) : false,
        });
        if (t.openFailure) notifyOnce(s, ctx, `open:${guard}`, t.openFailure);
        if (outcome.kind === "decision" && outcome.d.decision === "ask") s.trace?.emit({ event: "ask", guard, toolFamily: mapping.coreName, decision: askOutcome(s.isChild, t.result?.reason) });
        const prReason = guard === "git_guard" && t.result && "block" in t.result ? /pr_refused:(\w+)/.exec(String(t.result.reason ?? ""))?.[1] : undefined;
        if (prReason && (PR_REFUSALS as readonly string[]).includes(prReason)) s.trace?.emit({ event: "pr_refused", reason: prReason });
        if (t.result) return t.result;
        if (guard === "ledger_guard_spawn" && agents.length > 0) {
          setCeremony(s, afterSpawn(s.ceremony));
          const modelOf = roleModelsOf(input);
          for (const role of agents) s.trace?.emit({ event: "role_launch", role, ...(modelOf.has(role) ? { model: modelOf.get(role) } : {}), ...(REVIEW_ROLES.includes(role) ? { occasion: [...occasions].find(([e]) => e.agent === role)?.[1] ?? "item" } : {}) });
        }
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
        const factCount = await reviewFacts.augment(input, ctx.cwd, (task) => {
          if (occasionOf(task) !== "plan-review") return null;
          const lg = (() => { try { return planLedger ? fs.readFileSync(planLedger, "utf8") : null; } catch { return null; } })();
          const planPaths = planPathsOf(planReviewFiles(task, null), editModeOfSession(s).scratchDir);
          return [planFactsBlock(planPaths, planLedger, lg), ...ownerFactsLines(planPaths, ctx.cwd)].join("\n");
        });
        if (factCount > 0) s.trace?.emit({ event: "review_facts", count: factCount });
        // PR gate (B-M4): HEAD at a reviewer's launch; the verdict keeps a head only if it is unchanged at run end.
        const action = actionOf(input);
        if (action === "resume" || (action === null && subagentAgents(input).some((r) => REVIEW_ROLES.includes(r)))) {
          capSet(s.launchHeadsByCall, event.toolCallId, await headsAt(launchCwds(input, ctx.cwd)));
        }
      }
      // Kept for the tool result only once the launch passed every check.
      if (pendingBottom) capSet(bottomNotes, event.toolCallId, pendingBottom);
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
      if (event.toolName === "subagent" && !s.isChild) {
        const lf = boundLedger(s.markerDir, s.id);
        const lg = (() => { try { return lf ? fs.readFileSync(lf, "utf8") : null; } catch { return null; } })();
        // R26 item 3: a reviewer launched after an open FAIL names the head that FAIL reviewed (its record's head lands in reviewSync)
        if (s.reviewFailOpen) await s.reviewSync;
        const reReview = s.reviewFailOpen ? { sha: [...s.reviews].reverse().find((r) => r.verdict === "fail" && r.head)?.head ?? null } : null;
        for (const r of applyLedgerItems(input, lg, new Set(climbs.filter((c) => c.handoff).map((c) => c.entry)), lf, criticOf(get(s.config.config, "review.critic")), reReview)) s.trace?.emit(r);
      }
      if (event.toolName === "subagent" && !s.isChild) for (const r of s.brief.apply(input)) s.trace?.emit(r);
      // R41 Ruling: the roots of Pi and npm (and a builder's absolute plan and ledger paths) in every fresh child brief
      if (event.toolName === "subagent" && !s.isChild) for (const r of applyRootsBlock(input, await piRootsOf(s), { plan: s.plan && s.plan.status === "approved" ? s.plan.path : null, ledger: boundLedger(s.markerDir, s.id) })) s.trace?.emit(r);
      if (event.toolName === "subagent" && climbs.length > 0) {
        const ledgerFile = boundLedger(s.markerDir, s.id);
        const ledger = (() => { try { return ledgerFile ? fs.readFileSync(ledgerFile, "utf8") : null; } catch { return null; } })();
        if (climbs.some((c) => c.handoff) && !kind) kind = "strong-relaunch";
        for (const r of s.ladder.apply(climbs, (task) => ledgerLines(ledger, task))) s.trace?.emit(r);
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
        s.ladder.noteLaunched(input);
        for (const p of sizedPlans) for (const t of p.probe) s.ladder.probeRisks.add(t);
        for (const p of sizedPlans) for (const t of p.risk) if (STAKE_TAGS.includes(t)) s.ladder.stakeTags.add(t);
      }
      let limits: LadderLimits | undefined;
      const single = event.toolName === "subagent" && !s.isChild ? singleLaunchRole(input) : null;
      if (single && ladderRoles) {
        const bottom = onBottomRung(ladderRoles, single, input.model);
        const p = s.configProvider ?? ctx.model?.provider;
        s.ladder.onLaunch(event.toolCallId, single, bottom);
        limits = { bottom, maxTurns: childMaxTurns(s.config.config, p, single), ...(bottom ? { strongAbove: strongAbove(s.config.config, p, single) } : {}) };
      }
      if (event.toolName === "subagent") {
        const b = recordLaunchUsage(s, ctx, input, kind, limits, launchMcp, launchFlags);
        if (!s.isChild) s.childRuns.onLaunchCall(event.toolCallId, { launchId: b?.launchId ?? null, role: single ?? "", rung: single ? rungOf(ladderRoles, single, limits?.bottom === true) : null, model: b?.model ?? null });
      }
      if (event.toolName === "subagent" && !s.isChild && !isManagementCall(input)) s.pendingLaunches.add(event.toolCallId);
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
      if (s) onCustomMessage(s, event.message);
      if (s && !s.isChild) s.customSeen.mark(event.message);
      // R12 item 9: a needs-attention notice for a run that ended is no longer displayed
      const hidden = s && !s.isChild ? hideStaleNotice(s.attention, event.message) : null;
      if (hidden) return { message: hidden };
      // Open-command notices: a known long command (test runner) is hidden; a child without a command controller loses the `command.*` lines.
      const ev = s && !s.isChild ? noticeEvent(event.message) : null;
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
      else s.trace?.emit({ event: "rung_up_steer", role: s.usage.line.role, count: steer.count, baseline: steer.baseline ?? null, rung: steer.rung, reason: "context" });
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

  /** A custom message the foreman received: at message_end, or appended while idle and found at the next input (idlecustom.ts). */
  function onCustomMessage(s: Session, message: unknown): void {
    const m = message as { customType?: string; details?: unknown; content?: unknown };
    const live = (runId: string): boolean => isLiveRun(s, runId);
    const stale = s.supervisor.staleRequest(message, live);
    if (stale) s.trace?.emit({ event: "supervisor_request", role: stale.role, decision: "stale" });
    const opened = s.supervisor.onMessage(message, live);
    if (opened) s.trace?.emit({ event: "supervisor_request", role: opened.role, decision: "open" });
    if (s.isChild) return;
    const cause = causeOfCustom(m.customType);
    // the starting intercom message of a close turn arrives after close claimed the run: the cause stays "close"
    if (cause && !(cause === "intercom" && s.turn.cause === "close")) s.turn.cause = cause;
    if (cause === "wake") s.turn.wakeKinds = [...new Set((m.details as { kinds?: unknown[] } | undefined)?.kinds ?? [])].map(String).join(",");
    // An inbound intercom message or a foreman_wait wake is the parent answering: the finish gate is active again.
    if (m.customType === INTERCOM_MESSAGE_TYPE || m.customType === WAKE_MESSAGE_TYPE) (s.waitingForParent = false), s.handoffWaits.clear();
    if (m.customType === INTERCOM_MESSAGE_TYPE) s.turn.intercomFrom = intercomSender(m.details);
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
      const stale = isSubagentWake(event.source, event.text) ? staleNoticeRunIds(unseen, s.attention.endedRuns, s.attention.suppressed) : null;
      if (stale) {
        for (const runId of stale) s.trace?.emit({ event: "notify_deduped", reason: "run_ended", runId });
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
    if (s && !s.isChild && (event.source === "interactive" || event.source === "rpc")) s.finishRefusals = 0;
    if (s && !s.isChild && (event.source === "interactive" || event.source === "rpc")) (s.waitingForParent = false), s.handoffWaits.clear();
    if (s && !s.isChild && (event.source === "interactive" || event.source === "rpc")) (s.climbRefusals = 0), persistRounds(s);
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
    if (!s || s.isChild || s.turn.cause !== "intercom" || !s.turn.intercomFrom) return;
    if (ctx.mode === "tui" || ctx.mode === "rpc") ctx.ui.notify(`pi-foreman: this turn was started by an intercom message from ${s.turn.intercomFrom}`, "info");
  });

  pi.on("agent_end", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild) return;
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
    const ids = noticeRuns(text)?.ids ?? [];
    if (ids.length > 0 && ids.every((id) => shadowRun(s.reviewRuns.byRun.get(id)))) return;
    const verdict = verdictOf(text);
    const passed = reviewerPassOfNotice(text);
    // a second opinion, plan review or panel never marks items (occasion.ts); the run end marks the counting primary
    const launch = passed ? s.reviewRuns.byRun.get(passed.runId) : undefined;
    if (passed && !(launch && (launch.panel || launch.entries.some((e) => REVIEW_ROLES.includes(e.role) && (e.occasion === "second-opinion" || e.occasion === "plan-review"))))) markByReview(s, passed.runId, passed.text);
    s.round = onReviewDone(s.round, verdict);
    persistRounds(s);
  }

  /** Retro-harvest 1/6 at a run end: a reviewer PASS marks its items; a verdict sets or clears the PASS snapshot; a touch-up builder is checked. */
  function onRunEndReview(s: Session, runId: string, data: unknown, verdict: boolean): void {
    const pass = reviewerPassOfRunEnd(data);
    if (pass) markByReview(s, runId, pass);
    if (verdict) {
      const passed = s.reviewGate.last === "pass";
      const cwd = reviewsOfRunEnd(data)[0]?.cwd ?? s.cwd;
      s.passSnap = null;
      s.passMark = null;
      const at = Date.now();
      const ledger = boundLedger(s.markerDir, s.id);
      const builderRuns = s.steps.builder;
      if (passed) s.reviewSync = s.reviewSync.then(async () => {
        const [tree, head] = await Promise.all([worktreeTree(cwd), headOf(cwd)]);
        if (s.reviewGate.last !== "pass") return;
        s.passSnap = tree ? { cwd, tree } : null;
        s.passMark = { cwd, at, head, tree, ledger, builderRuns };
        persistCeremonyState(s);
      });
    }
    if (s.touchUps.delete(runId)) s.reviewSync = s.reviewSync.then(async () => {
      if (s.reviewGate.last === "pass" && s.reviewGate.revised && (await commentOnlyNow(s))) {
        s.reviewGate = { ...s.reviewGate, revised: false };
        persistCeremonyState(s);
      }
    });
  }

  /** Mark the `N. PASS` items of a reviewer PASS in the bound ledger, once per review run (reviewmarks.ts). */
  function markByReview(s: Session, runId: string, text: string): void {
    if (s.reviewMarked.has(runId)) return;
    s.reviewMarked.add(runId);
    const file = boundLedger(s.markerDir, s.id);
    if (!file) return;
    s.reviewSync = s.reviewSync.then(async () => {
      const r = await markPassItems(text, file, async (n) => (await runLedger(s, ["mark", n, MARK_NOTE], file)).ok, async (n, t) => (await runLedger(s, ["note", n, `reviewer: ${t}`], file)).ok);
      if (r) s.trace?.emit({ event: "ledger_mark_by_review", items: r.items.join(","), skipped: r.skipped.join(","), noted: r.noted.join(",") });
    });
  }

  /** The working tree differs from the PASS snapshot only in comments or docs (commentonly.ts); traced revision_comment_only. */
  async function commentOnlyNow(s: Session): Promise<boolean> {
    const files = s.passSnap ? await commentOnlySince(s.passSnap) : null;
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

  /** Roles a `subagent` call runs: top-level, tasks, chain (and parallel steps), or the role of a resumed run. */
  function launchRoles(s: Session, input: Record<string, unknown>): string[] {
    return [...subagentAgents(input), ...roundSteps(input, s.runs).flat()];
  }

  /** Heavy tier: a builder launch needs the owner's approval of the current plan (checkpoint.ts). A refusal records nothing. */
  function builderPlanBlock(s: Session, ctx: ExtensionContext, input: Record<string, unknown>): string | undefined {
    const tier = s.ceremony.tier;
    if (s.planPhase) {
      const roles = launchRoles(s, input);
      if (roles.includes("builder")) {
        s.trace?.emit({ event: "launch_refused", reason: "plan_phase", tier, ...launchDeny(input) });
        return launchRefusalText("plan_phase", s.plan, planOpts(s, ctx).scratchDir);
      }
    }
    if (tier !== "heavy" || !launchRoles(s, input).includes("builder")) return undefined;
    const o = planOpts(s, ctx);
    const reason = builderLaunchRefusal(s.plan, tier, s.plan ? currentPlanHash(s.plan, o) : null);
    if (!reason) return undefined;
    s.trace?.emit({ event: "launch_refused", reason, tier, ...launchDeny(input) });
    return launchRefusalText(reason, s.plan, o.scratchDir);
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
   * Item 13: a change the edit mode refused needs a builder. Trace it; outside bounded mode mark the
   * ceremony and raise a trivial tier to standard at once (an untriaged session's later trivial
   * triage is recorded as standard). The text added to the refusal.
   */
  function onEditRefused(s: Session, mode: EditMode, kind: string): string {
    s.trace?.emit({ event: "foreman_edit_refused", mode, kind });
    if (mode === "bounded") return "";
    if (s.planPhase) return " The plan phase is on: write the plan under .workflow/ and use explorers; code changes wait for a checkpoint approval or /foreman plan off.";
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

  /** The owned read-write roots as literal dirs: the `*` segment (one dir per session) is expanded from disk. */
  function literalOwnedDirs(roots: string[]): string[] {
    const out: string[] = [];
    for (const r of roots) {
      const i = r.split(path.sep).indexOf("*");
      if (i < 0) {
        out.push(r);
        continue;
      }
      const parts = r.split(path.sep);
      const parent = parts.slice(0, i).join(path.sep) || path.sep;
      try {
        for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isDirectory()) out.push(path.join(parent, e.name, ...parts.slice(i + 1)));
      } catch {
        // the parent does not exist yet: nothing to allow
      }
    }
    return out;
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

  /** The ask contract of a session (askcontract.ts): `ask.md` in an own handoff dir -> `.ask` marker + blocked signal. */
  const asks = new Map<string, AskContract>();
  function askContractFor(s: Session): AskContract {
    let c = asks.get(s.id);
    if (!c) {
      c = new AskContract({ ownDirs: () => childHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)), block: (label) => blockedShim.own(label) });
      asks.set(s.id, c);
    }
    return c;
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
  /** A `ruling.md` / `ruling-plan.md` written by this session in a handoff dir where it is the PARENT gets the `plan-version:` line of that dir's plan.md (checkpoint.ts stampPlanVersion). */
  function stampParentRuling(s: Session, file: string): void {
    if (path.basename(file) !== "ruling.md" && path.basename(file) !== PLAN_VERDICT_FILE) return;
    const realOf = (d: string): string => {
      try {
        return fs.realpathSync.native(d);
      } catch {
        return path.resolve(d);
      }
    };
    const dir = realOf(path.dirname(file));
    const own = new Set(childDirsOf(s).map(realOf));
    if (own.has(dir)) return;
    const parentOf = ownHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id)).map(realOf);
    if (!parentOf.includes(dir)) return;
    const hash = stampPlanVersion(file, path.join(dir, "plan.md"));
    if (hash) s.trace?.emit({ event: "plan_ruling_stamped", to: hash.slice(0, 16) });
  }
  const bashRulingSnaps = new Map<string, Map<string, number>>();
  /** ask_user_question calls whose text read like jargon: the hint is appended to the result (ownertext.ts). */
  const questionHints = new Map<string, string>();
  const MUTATING_TOOLS = new Set(["write", "edit", "bash", "powershell"]);

  /**
   * A parent-written `ruling-<n>.md` / `brief-<x>.md` in this session's handoff dir lifts the loop stop and the read
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
    s.trace?.emit({ event: "cap_reset", by: isBriefName(hits[0]) ? "brief" : "ruling", count: hits.length });
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

  /** Plan D3: the foreman's bash/powershell may not write project files, at any tier (children are not checked). */
  /** The handoff dir where this session is the child side (its `PI_FOREMAN_HANDOFF_DIR`, else the dir whose `child` file names it), absolute, or undefined. */
  function ownChildHandoff(s: Session): string | undefined {
    const env = (process.env.PI_FOREMAN_HANDOFF_DIR ?? "").trim();
    const dir = env || childHandoffDirs(handoffsRoot(s), intercomIdOf(process.env, s.agentDir, s.id))[0];
    return dir && (path.isAbsolute(dir) || path.win32.isAbsolute(dir)) ? dir : undefined;
  }

  async function shellWriteBlock(ctx: ExtensionContext, toolName: "bash" | "powershell", input: Record<string, unknown>): Promise<{ block: true; reason: string } | undefined> {
    try {
      const s = await ensureSession(ctx);
      if (s.isChild) return undefined;
      const env = buildGuardEnv({ base: process.env, coreDir: CORE_DIR, sessionId: s.id, guard: "shell_write_guard", markerDir: s.markerDir });
      const { mode, scratchDir } = editModeOfSession(s);
      const ownHandoff = ownChildHandoff(s);
      const payload = shellWriteGuardPayload(input, payloadCtx(s, ctx), workspaceOf(ctx.cwd).root, toolName, allowedShellDirs(mode, scratchDir, ctx.cwd, platform), s.isChild ? [] : literalOwnedDirs(s.owned.readWrite), { ...(ownHandoff ? { handoffDir: ownHandoff } : {}) });
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
      const reason = precondition ? `${v.reason} branch move refused: ${precondition}.` : v.reason;
      s.trace?.emit({ event: "shell_write_refused", role: "foreman", kind: v.kind, mode, ...(precondition ? { precondition } : {}) });
      // a refusal caused only by a parent-owned name in the own handoff dir is no sign the task needs a builder: no tier escalation
      const more = v.handoffOnly ? "" : onEditRefused(s, mode, "shell");
      return { block: true, reason: mode === "bounded" ? reason : `${reason} pi-foreman: ${editModeAdvice(mode, scratchDir)}.${more}` };
    } catch (err) {
      return { block: true, reason: `pi-foreman: adapter error in the shell write guard (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
    }
  }

  /** D8: give a single-child launch its usage binding (role, launch id, kind) through extensionBindings. */
  function recordLaunchUsage(s: Session, ctx: ExtensionContext, input: Record<string, unknown>, kind?: LaunchKind, ladder?: LadderLimits, mcp?: string[], flags?: { reads?: number; install?: boolean }): LaunchBinding | null {
    const role = singleLaunchRole(input);
    if (!role) return null;
    const model = typeof input.model === "string" && input.model ? input.model : null;
    const b = recordUsageLaunch(s.launches, { foremanSession: s.usage.line.foremanSession, workspace: s.usage.line.workspace, role, model, kind, activeProvider: ctx.model?.provider, ladder });
    launchScratch(s, input, b);
    const ownHandoff = ownChildHandoff(s);
    if (!s.isChild && ownHandoff) b.handoffDir = ownHandoff;
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
    releaseQuestion(event.toolCallId);
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
    gateDecided.delete(event.toolCallId);
    sessionFor(ctx)?.gitDrift.after(ctx.cwd, os.homedir(), event.toolCallId);
    const owner = sessionFor(ctx);
    if (event.isError) owner?.trace?.emit(toolErrorRecord(event.toolName, event.content)); // R6 lane 7f
    const created = manifest.onToolResult(event.toolCallId, event.isError);
    if (owner && created.length) {
      const o = manifestOwner({ id: owner.id, isChild: owner.isChild, foremanSession: owner.usage.line.foremanSession, launchId: owner.usage.line.launchId }, process.env);
      await recordEntries(created, { ...o, stateDir: manifestCtx(owner, ctx.cwd).stateDir }, (args) => runScript(owner, "foreman_close.py", args, 15_000));
    }
    // an answer to an open ask.md is also written to ruling-<n>.md; details stay the package's (ownerAnswered reads them)
    if (owner && !owner.isChild && event.toolName === ASK_USER_TOOL) writeAskRuling(childDirsOf(owner), event.content, event.details, event.isError);
    if (owner && !owner.isChild && !event.isError && (event.toolName === "write" || event.toolName === "edit")) {
      const given = (event.input as Record<string, unknown>).path;
      if (typeof given === "string") {
        if (askContractFor(owner).onFileWritten(path.resolve(ctx.cwd, given)) === "note") owner.trace?.emit({ event: "ask_note", needs_ruling: "no" });
        if (isTrackedRulingName(path.basename(given))) {
          const abs = path.resolve(ctx.cwd, given);
          let real = abs;
          try {
            real = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
          } catch {
            // keep the resolved path
          }
          // R41 item 17: the parent pane's harness stamps the plan version into a plan ruling it wrote for a CHILD's handoff dir (never the caller's own dir)
          if (event.toolName === "write" || event.toolName === "edit") stampParentRuling(owner, real);
          selfRulingsFor(owner).mark(real);
        }
      }
    }
    // R6 4a: a ruling-<n>.md / ruling.md read through the read tool writes `.seen` and ends the blocked state now.
    if (owner && !owner.isChild && !event.isError && event.toolName === "read") {
      const given = (event.input as Record<string, unknown>).path;
      if (typeof given === "string" && isRulingName(path.basename(given))) askContractFor(owner).onRulingWake(path.resolve(ctx.cwd, given));
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
    releaseQuestion(event.toolCallId);
    if (owner?.isChild && event.toolName === "bash" && process.env[SCRATCH_ENV]) clearOpenCommand(process.env[SCRATCH_ENV]!, event.toolCallId);
    // A `.seen` written by a shell command ends the ask too: the blocked state is recomputed from the files (R6 lane 4a).
    if (owner && !owner.isChild && event.toolName === "bash") askContractFor(owner).recheck();
    const pending = owner?.pendingChanges.get(event.toolCallId);
    if (owner && !owner.isChild && !event.isError && (event.toolName === "write" || event.toolName === "edit") && isPlanPath((event.input as Record<string, unknown>).path, planOpts(owner, ctx))) {
      owner.trace?.emit({ event: "plan_written", tier: owner.ceremony.tier, by: "foreman" });
    }
    // Plan publication (show.ts): the scratch plan of a foreman and `<handoff dir>/plan.md` of a child session; a refresh, no ruling point.
    if (owner && !owner.isChild && !event.isError && (event.toolName === "write" || event.toolName === "edit")) owner.show?.planWritten((event.input as Record<string, unknown>).path);
    // A child's `Plan from` / `foreman:plan` notice is a ruling point: the snapshots roll.
    if (owner && !owner.isChild && !event.isError && event.toolName === INTERCOM_TOOL) {
      const i = event.input as Record<string, unknown>;
      if (i.action === "send") owner.show?.planSent(i.message);
    }
    const readNote = owner?.readNotices.get(event.toolCallId);
    owner?.readNotices.delete(event.toolCallId);
    const qHint = questionHints.get(event.toolCallId);
    questionHints.delete(event.toolCallId);
    const withNote = () => (readNote || qHint ? { content: [...(readNote ? [{ type: "text" as const, text: readNote }] : []), ...event.content, ...(qHint ? [{ type: "text" as const, text: qHint }] : [])] } : undefined);
    // Only a project-file change invalidates a PASS; ledger, notes and scratch writes do not.
    // It is also a revision that re-opens the reviewer step (ceremony.reviewGate).
    if (owner && !owner.isChild && !event.isError && (owner.reviewGate.last !== null && !owner.reviewGate.revised) && projectChange(event.toolName, event.input as Record<string, unknown>, editModeOfSession(owner).scratchDir, { cwd: ctx.cwd, home: os.homedir(), platform })) {
      const touchUp = owner.reviewGate.last === "pass" && !owner.reviewGate.revised && (await owner.reviewSync, await commentOnlyNow(owner));
      if (!touchUp) {
        owner.reviewGate = onRevision(owner.reviewGate);
        persistCeremonyState(owner);
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
      const closed = s?.supervisor.onSupervisorResult(event.details, event.isError, (runId) => isLiveRun(s, runId));
      if (closed) s?.trace?.emit({ event: "supervisor_request", role: closed.role, decision: event.isError ? "closed_dead_run" : "replied" });
    }
    if (event.toolName === "subagent") {
      const s = sessionFor(ctx);
      if (s) {
        s.pendingLaunches.delete(event.toolCallId);
        recordLaunch(s.runs, event.input, event.details, event.isError);
        recordLaunchRoles(s.launchedRoles, event.input, event.details, event.isError);
        const heads = s.launchHeadsByCall.get(event.toolCallId);
        s.launchHeadsByCall.delete(event.toolCallId);
        const runId = launchId(event.input, event.details, event.isError);
        const launched = s.scratch.onLaunched(boundLaunchId(event.input), runId);
        finishScratch(s, launched);
        closeChildAsk(s, launched);
        s.ladder.onLaunched(event.toolCallId, runId);
        if (runId && !s.isChild) {
          s.childRuns.onLaunched(event.toolCallId, runId, s.launchedRoles.get(runId) ?? []);
          radarTouch(s, ctx);
        }
        if (heads && runId) capSet(s.launchHeads, runId, heads);
        const rl = s.reviewRuns.byCall.get(event.toolCallId);
        s.reviewRuns.byCall.delete(event.toolCallId);
        if (rl && runId) capSet(s.reviewRuns.byRun, runId, rl);
        trackActive(s.activeRuns, event.input, event.details, event.isError);
        if (!s.isChild) {
          // Budgets restart only for a launch that started (a run id came back), not a refused one.
          if (runId) {
            recordChild(s, launchLocations(event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"), event.details, path.join(os.tmpdir(), `pi-subagents-uid-${process.getuid?.() ?? ""}`)));
            const roles = s.launchedRoles.get(runId) ?? subagentAgents(event.input as Record<string, unknown>);
            const cited = citedItems(subagentTaskText(event.input as Record<string, unknown>));
            s.retro.launchItems.set(runId, cited);
            writeHint(boundLedger(s.markerDir, s.id), cited, `${roles.join("+") || "child"} launched (run ${runId.slice(0, 8)})`, s.retro.hints, hintOpts(s));
            s.budget.onLaunch();
            if (roles.includes("builder")) {
              if (s.reviewGate.last === "pass" && !s.reviewGate.revised && !roles.some((r) => REVIEW_ROLES.includes(r))) s.touchUps.add(runId);
              s.reviewGate = onRevision(s.reviewGate);
              persistCeremonyState(s);
            }
            const after = reopened(s.reviewGate);
            if (after) for (const role of roles.filter((r) => REVIEW_ROLES.includes(r))) s.trace?.emit({ event: "rereview", role, after });
          }
        }
      }
      const launchedOn = roleModelsOf(event.input);
      for (const role of subagentAgents(event.input as Record<string, unknown>)) s?.trace?.emit({ event: "role_launched", role, exit: event.isError ? 1 : 0, pollBash: s.pollBash || undefined, ...(launchedOn.has(role) ? { model: launchedOn.get(role) } : {}) });
      if (s) s.pollBash = 0;
      const modelLine = s && !s.isChild && !event.isError && launchedOn.size > 0 ? `pi-foreman: launched ${[...launchedOn].map(([role, model]) => `${role} on ${model}${bottomNotes.get(event.toolCallId)?.has(role) ? ` (bottom rung: ${bottomNotes.get(event.toolCallId)!.get(role)})` : ""}`).join(", ")}.` : null;
      bottomNotes.delete(event.toolCallId);
      // R27 item 4: a non-item review occasion is named in the launch result, so a misclassified review is visible before it runs.
      const occasionLines = s && !s.isChild && !event.isError ? occasionLinesOf(event.input as Record<string, unknown>) : [];
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
      if (notices || tail !== null || sizingHint) return { content: [...(notices ?? []).map((text) => ({ type: "text" as const, text })), ...(trim ? trim.content : event.content), ...(tail !== null ? [{ type: "text" as const, text: tail }] : []), ...(sizingHint ? [{ type: "text" as const, text: sizingHint }] : [])] };
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
    // a steer taken as the run ended is delivered only if it is shown here; otherwise it stays pending
    const shown = foldSteer(watch, steerText, climb && climb.runId === runId && !r.end?.policyBlock && !r.end?.repeatRefusal ? `${text}\n${climbHint(climb)}` : text, !ctx.signal?.aborted);
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
    // A source that starts a turn by itself when it ends makes this settle a pause, not a finish: neither gate runs (the stop guard's once-per-session reminder and the refusal counter stay unspent).
    const pending = pendingWakeSources(s);
    if (pending.length > 0) {
      s.trace?.emit({ event: "finish_gate", skipped: "pending_wait", runId: pending.join(",") }); // the ids ride in `runId`: `note` is dropped for this event, a new field would change the pinned allowlist
      return undefined;
    }
    const outcome = await run(s, ctx, "ledger_guard_stop", stopPayload(payloadCtx(s, ctx), s.stopContinued), "Stop");
    const r = translateStop(outcome);
    if (r.openFailure) notifyOnce(s, ctx, "open:ledger_guard_stop", r.openFailure);
    if (!r.hold) return await ceremonyFinishGate(s, ctx, event.entries);
    s.stopContinued = true;
    s.trace?.emit({ event: "stop_hold", guard: "ledger_guard_stop", decision: "continue" });
    return {
      entries: [...event.entries, { type: "custom_message" as const, customType: "pi-foreman-stop-gate", content: r.reason ?? "", display: true }],
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
   * next turn). At most 2 refusals per user prompt; then the settle passes, visibly.
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
    const gate = s.reviewGate;
    const missing: string[] = openSteps(s.steps, requiredOf(s, s.ceremony.tier), gateMode, gate);
    // A rejected plan blocks the heavy finish until a new approval or the user lowers the tier (/ceremony).
    const rejected = s.ceremony.tier === "heavy" && s.plan?.status === "rejected";
    if (rejected) missing.push("plan");
    if (missing.length === 0) return undefined;
    // The no-change valve (ledger nochange-finish): git runs only when the counters already say nothing was built or edited.
    if (!rejected && s.steps.builder === 0 && s.tally.files.length === 0) {
      const porcelain = await git(ctx.cwd, ["status", "--porcelain"]);
      if (noChange(s.steps, s.tally.files.length, porcelain)) {
        s.trace?.emit({ event: "ceremony_gate", reason: "no_change", tier: s.ceremony.tier });
        ctx.ui.notify("pi-foreman: finished without a change: no builder or reviewer required", "info");
        return undefined;
      }
    }
    // Ladder (e): after a FAIL with the builder still on its bottom rung, the revision climbs; this
    // refusal does not count toward the two-refusal valve (at most 2 per user prompt).
    if (missing.includes("reviewer") && gate.last === "fail" && s.climbRefusals < 2 && (await builderClimbOpen(s, ctx))) {
      s.climbRefusals++;
      s.trace?.emit({ event: "finish_refused", tier: s.ceremony.tier, missing: missing.join(","), climb_available: true });
      return {
        entries: [...entries, { type: "custom_message" as const, customType: "pi-foreman-ceremony-gate", content: finishRefusal(s.ceremony.tier, missing as Step[], reviewHint(gate)) + " Relaunch the builder for the revision; it climbs to its strong rung.", display: true }],
        continue: true,
      };
    }
    if (s.finishRefusals >= 2) {
      s.trace?.emit({ event: "ceremony_incomplete", tier: s.ceremony.tier, missing: missing.join(",") });
      ctx.ui.notify(`pi-foreman: finished with ceremony incomplete: missing ${missing.join(", ")}`, "warning");
      return undefined;
    }
    s.finishRefusals++;
    s.trace?.emit({ event: "finish_refused", tier: s.ceremony.tier, missing: missing.join(",") });
    return {
      entries: [...entries, { type: "custom_message" as const, customType: "pi-foreman-ceremony-gate", content: finishRefusal(s.ceremony.tier, missing as Step[], gateMode === "pass" && missing.includes("reviewer") ? reviewHint(gate) : "") + escalated + (missing.includes("reviewer") && gate.last === "fail" && gate.failAt !== undefined ? rulingNote(s, gate.failAt) : "") + (rejected ? ` The owner rejected the plan: launch no builder; report to the owner, and get a new plan approved with ${CHECKPOINT_TOOL} before going on.` : ""), display: true }],
      continue: true,
    };
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
    return strongOnRevision(s.config.config, r.provider, "builder") && onBottomRung(r.roles, "builder", live);
  }

  /** ceremony.required.<tier> as it applies to this session (trivial.ts effectiveRequired). */
  /** `/foreman close`: the required steps still open and what the parent would have to rule ("" = none). */
  function closeCeremonyNote(s: Session): string {
    if (s.isChild || !isTriaged(s.ceremony)) return "";
    return rulingNeeded(openSteps(s.steps, requiredOf(s, s.ceremony.tier), reviewGateMode(get(s.config.config, "ceremony.reviewGate")), s.reviewGate));
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
      watches: s.prWatches,
      trace: (r) => s.trace?.emit(r),
      tracker: s.prHost,
      track: s.isChild ? undefined : async (repo, n, host) => (prFeedOn(s) ? addTracked(s.agentDir, repo, n, undefined, host) : "off"),
      githubHosts: () => resolveGithubHosts(s.config.config),
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
      const out = await run(s, ctx, "git_guard", gitGuardPayload("bash", { command: "git push" }, { ...payloadCtx(s, ctx), cwd: cwd ?? ctx.cwd }, get(s.config.config, "safety.git"), { enabled: false, reviewed_heads: [] }), "pr_create");
      if (out.kind === "failure") return out.message;
      return out.d.decision === "deny" || out.d.decision === "ask" ? String(out.d.reason ?? out.d.decision) : null;
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
      return { id: s.id, isChild: s.isChild, cwd: s.cwd, agentDir: s.agentDir, overlay: s.overlay, config: () => s.config.config, trace: (r) => s.trace?.emit(r), owned: () => s.owned.readWrite, ownTasks: (cwd) => (s.isChild ? [] : ownTaskReadable([cwd, workspaceOf(cwd).root, s.usage.line.workspace], s.usage.line.foremanSession, platform)), pressure: () => pressureOf(s), idle: () => s.activeRuns.size === 0, intercomRun: () => s.turn.cause === "intercom", onStart: (spec, id) => {
        markHandoffWait(s, spec, id);
        if (spec.kind === "pid" && spec.bg) bgRecords.post(`fb-${id}`, "working", spec.note, "Running");
      }, onBgEnd: (id, note, how) => (how === "timeout" ? undefined : how === "dropped" ? bgRecords.clear(`fb-${id}`) : bgRecords.post(`fb-${id}`, "done", note, how === "exited" ? "Finished" : "Killed")), onCancel: (id) => cancelHandoffWait(s, id), onRulingWake: (file) => void askContractFor(s).onRulingWake(file), steer: (text) => steerFor(s).append(text) };
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
      return { id: s.id, isChild: s.isChild, cwd: s.cwd, config: () => s.config.config, trace: (r) => s.trace?.emit(r), markCause: () => void (s.turn.cause = "close"), ceremonyNote: () => closeCeremonyNote(s), watchedPrs: () => s.prWatches.numbers(), refreshWatched: () => s.prWatches.refresh(), selfFinish: async (c, req) => {
        const handoff = process.env[HANDOFF_DIR_ENV]?.trim() ?? "";
        const py = pyPath(s);
        const script = path.join(PKG_ROOT, "scripts", "foreman_close.py");
        if (!handoff || !py || !req.pr) return { lines: ["cleanup: not started (no handoff dir or no usable Python)"] };
        return selfFinish({ cwd: s.cwd, handoff, sessionId: s.id, stateDir: path.join(s.agentDir, "pi-foreman", "state"), trusted: safeTrusted(c), pid: process.pid, status: (n) => prRun(s, s.cwd, "pr_status", { number: n }), git: async (args) => (await git(s.cwd, args))?.trim() ?? null, closeScript: async (args) => (await runScript(s, "foreman_close.py", args, 120_000)).text, spawnCleanup: (args) => spawnDetached(py, ["-E", "-s", script, ...args], handoff) }, req.pr.n);
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

  // `/foreman session open|brief|close|list` (session.ts): user commands, foreman sessions only.
  const sessionHost: Parameters<typeof registerSession>[1]["session"] = async (ctx) => {
    const s = await ensureSession(ctx);
    const roots = await piRootsOf(s);
    return { id: s.id, isChild: s.isChild, cwd: s.cwd, agentDir: s.agentDir, python: pyPath(s), protectedRoots: { installRoot: roots.installRoot, npmRoot: roots.npmRoot, npmRootPending: s.npmRootPending }, model: idleModel.baseModel(ctx.model) ?? undefined, config: s.config.config, trace: (r) => s.trace?.emit(r), recordWorktree: async (e) => {
      const o = manifestOwner({ id: s.id, isChild: s.isChild, foremanSession: s.usage.line.foremanSession, launchId: s.usage.line.launchId }, process.env);
      await recordEntries([e], { ...o, stateDir: manifestCtx(s, ctx.cwd).stateDir }, (args) => runScript(s, "foreman_close.py", args, 15_000));
    } };
  };
  const sessionCmd = registerSession(pi, {
    spawner,
    pkgRoot: PKG_ROOT,
    onChildNotice: (sessionId, label, kind, notePath) => void waits.childNotice(sessionId, label, kind, notePath),
    session: sessionHost,
  });

  if (process.env.PI_SUBAGENT_CHILD !== "1") registerSessionOpenTool(pi, { spawner, pkgRoot: PKG_ROOT, session: sessionHost });

  // the owner's protected targets: the foreman proposes, the owner confirms, the adapter writes (never for a child)
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.registerTool({
      name: "foreman_protect",
      label: "Protect a target",
      description: "Add or remove a protected target (a host, a path or a command glob) in the owner's permissions, after the owner confirms in a dialog. Use it when the owner asks to protect or guard a target.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["add", "remove"] }, kind: { type: "string", enum: ["host", "path", "command"] }, glob: { type: "string", minLength: 1, maxLength: 300 }, note: { type: "string", maxLength: 200 }, file: { type: "string", enum: ["project", "user"], description: "Default project (.workflow/permissions.json)." } }, required: ["action", "kind", "glob"], additionalProperties: false } as never,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const s = await ensureSession(ctx);
        const r = await protectEntry(s, ctx, { action: params.action, kind: params.kind, glob: params.glob, note: params.note, file: params.file });
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
      prepareLoadout: (loadout: { declared: readonly { name: string; description?: string }[] }) => {
        const description = subagentDescription(loadout.declared, [...sessions.values()].every((x) => sizingConfig(x.config.config).enabled));
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
      description: "The general explanation tool: use it whenever the owner asks you to explain something they should read rendered (a design, a bug analysis, a comparison, how something works), with text, tables, code fences and ```mermaid diagrams; then answer in chat with a two to three sentence summary that points at the panel. Not for status lines or questions (questions go to ask_user_question). Each call replaces the previous note, so write it self-contained; the panel keeps one earlier version of the same title for a diff. Title up to 120 characters, markdown up to 256 KiB; takes the text itself, never a file path.",
      parameters: { type: "object", properties: { title: { type: "string", minLength: 1, description: "Heading of the note, up to 120 characters." }, markdown: { type: "string", description: "The whole note as markdown, up to 256 KiB." } }, required: ["title", "markdown"], additionalProperties: false } as never,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const s = await ensureSession(ctx);
        const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], details: { decision: "refused" }, isError: true });
        if (s.isChild) return refuse(`${SHOW_TOOL} is for the foreman only.`);
        const title = typeof params.title === "string" ? params.title.trim() : "";
        const markdown = typeof params.markdown === "string" ? params.markdown : "";
        if (!title) return refuse(`${SHOW_TOOL}: title is required.`);
        if (title.length > NOTE_TITLE_MAX) return refuse(`${SHOW_TOOL}: the title is ${title.length} characters, the limit is ${NOTE_TITLE_MAX}. Shorten it.`);
        const size = Buffer.byteLength(markdown, "utf8");
        if (size > NOTE_MAX_BYTES) return refuse(`${SHOW_TOOL}: the note is ${size} bytes, the limit is ${NOTE_MAX_BYTES} (256 KiB). Cut it down or split it.`);
        if (!s.show) return refuse(`${SHOW_TOOL}: no side panel is available in this session (the scratch dir is disabled).`);
        try {
          const r = await s.show.note(title, markdown);
          // the harness knows the Herdr pane (env) but not the layout: without a pane no panel can show the note, with one only the block is in doubt
          const inHerdr = !!((process.env.HERDR_PANE_ID ?? "").trim() || (process.env.HC_TERMINAL_ID ?? "").trim());
          const hint = inHerdr
            ? " It is shown in the Herdr plan panel if your layout has a pi-foreman-plan block (see docs/herdr.md#notes)."
            : ` No Herdr pane was detected, so no panel can show it: the note is written at ${r.path}, and the Herdr layout needs a pi-foreman-plan panel block (see docs/herdr.md#notes).`;
          const openHint = showHint(markdown);
          return { content: [{ type: "text" as const, text: `shown: ${title} (v${r.v}, ${r.diagrams} diagram${r.diagrams === 1 ? "" : "s"}) at ${r.path}.${hint}${openHint ? ` ${openHint}` : ""}` }], details: { decision: "shown", v: r.v, diagrams: r.diagrams } };
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

  // Ledger helper (ledgercall.ts, ceremony.ledgerHelper): registered inactive; the foreman activates
  // it at session start unless the knob is off, reviewer children get it through their tool list.
  pi.registerTool({
    name: LEDGER_TOOL,
    label: "Ledger",
    defaultActive: false,
    executionMode: "sequential",
    description: "Manage the requirements ledger. Foreman: action status, mark (items: numbers, several in one call; \"V\" only after a reviewer PASS with no revision since), add (text), upsert ({item?, text}: replace that item's whole text keeping its state, or append a new item when item is omitted; identical text is a no-op), note or defer ({item, text} or {items: [n], text}: exactly one item). Reviewer children: only {action: \"mark\", items: [\"V\"]}. Every call returns ledger status.",
    parameters: { type: "object", properties: { action: { type: "string", enum: [...LEDGER_ACTIONS] }, items: { type: "array", items: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string", enum: ["V", "v"] }] } }, item: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string", enum: ["V", "v"] }], description: "upsert, note, defer: the item; upsert without it appends a new item." }, text: { type: "string", description: "add: the item text; upsert: the new item text; note: the note; defer: the reason; mark: an optional note." }, path: { type: "string", description: "Reviewer children only, when the foreman's ledger is not found: .workflow/LEDGER-<topic>.md." } }, required: ["action"], additionalProperties: false } as never,
    async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const s = await ensureSession(ctx);
      const mode = ledgerHelperMode(get(s.config.config, "ceremony.ledgerHelper"));
      const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], details: { decision: "refused" }, isError: true });
      const kind = typeof params.action === "string" ? params.action : "unknown";
      if (s.isChild) {
        // Item 14: a reviewer child closes V on the foreman's ledger; not traced as ledger_call (foreman-only).
        if (mode !== "tool" || !REVIEW_ROLES.includes(s.usage.line.role)) return refuse(`${LEDGER_TOOL} is not available to this role.`);
        const plan = planLedgerCall(params, { child: true, gate: s.reviewGate });
        if ("error" in plan) return refuse(plan.error);
        const file = childLedgerFile(s, params.path);
        if ("error" in file) return refuse(file.error);
        const r = await runLedger(s, plan.calls[0], file.path);
        if (r.ok) writeHint(file.path, ["V"], `ledger mark by ${s.usage.line.role}`, undefined, hintOpts(s));
        const st = await runLedger(s, ["status"], file.path);
        return { content: [{ type: "text" as const, text: [r.text, st.text].filter(Boolean).join("\n") }], details: { decision: r.ok ? "done" : "failed" }, ...(r.ok ? {} : { isError: true }) };
      }
      if (mode === "off") return refuse(`${LEDGER_TOOL} is off (ceremony.ledgerHelper); use the shell command ledger.`);
      const plan = planLedgerCall(params, { child: false, gate: s.reviewGate });
      if ("error" in plan) {
        s.trace?.emit({ event: "ledger_call", kind, allowed: false, items: Array.isArray(params.items) ? params.items.map(String).join(",").slice(0, 60) : undefined });
        return refuse(plan.error);
      }
      const out: string[] = [];
      let ok = true;
      let traceItems = plan.items;
      if (plan.upsert) {
        const u = plan.upsert;
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
            const n = /^added (\d+):/.exec(r.text);
            if (n) traceItems = n[1];
          }
        }
      }
      for (const c of plan.calls) {
        const r = await runLedger(s, c, null);
        if (r.text) out.push(r.text);
        ok = ok && r.ok;
      }
      const st = await runLedger(s, ["status"], null);
      if (st.text) out.push(st.text);
      ok = ok && st.ok;
      if (plan.attested) await s.reviewSync;
      const unbound = plan.attested && ok ? headlessPass(s.reviews) : null;
      if (unbound) out.push(`Note: the reviewer PASS carries no commit (${unbound}), so the PR gate will refuse; run a reviewer again on the head before pr_create.`);
      s.trace?.emit({ event: "ledger_call", kind, allowed: true, items: traceItems || undefined, attested: plan.attested || undefined });
      const hint = ok ? ledgerHint(kind, traceItems, out.join("\n"), params.text) : null;
      if (hint) writeHint(boundLedger(s.markerDir, s.id), hint.ids, hint.text, s.retro.hints, hintOpts(s));
      return { content: [{ type: "text" as const, text: out.join("\n") }], details: { decision: ok ? "done" : "failed" }, ...(ok ? {} : { isError: true }) };
    },
  } as never);

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

  /** A reviewer child's ledger: the foreman's bound ledger, else `path` inside <workspace>/.workflow/LEDGER-*.md. */
  function childLedgerFile(s: Session, p: unknown): { path: string } | { error: string } {
    const bound = boundLedger(s.markerDir, s.usage.line.foremanSession);
    if (bound) return { path: bound };
    const how = `${LEDGER_TOOL}: the foreman's ledger is not known here; pass path: ".workflow/LEDGER-<topic>.md".`;
    if (typeof p !== "string" || !p.trim()) return { error: how };
    const ws = s.usage.line.workspace || s.cwd;
    let abs: string;
    let dir: string;
    try {
      abs = fs.realpathSync.native(path.resolve(ws, p));
      dir = fs.realpathSync.native(path.join(ws, ".workflow"));
    } catch {
      return { error: how };
    }
    const same = (a: string, b: string) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (!same(path.dirname(abs), dir) || !/^LEDGER-.+\.md$/i.test(path.basename(abs))) return { error: how };
    return { path: abs };
  }

  // Plan checkpoint (checkpoint.ts): the owner approves the plan file; foreman only. Never approves on its own.
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.registerTool({
      name: CHECKPOINT_TOOL,
      label: "Plan checkpoint",
      // Never in parallel with other tool calls of the same message: no write lands while the owner reviews.
      executionMode: "sequential",
      description: "Ask the owner to approve a plan file (.workflow/scratch/plan-<topic>.md) before builders start. At tier heavy no builder launches until the owner approved the current version of the plan. The owner answers approve, revise (with a note) or reject; without an answer the checkpoint stays pending.",
      parameters: { type: "object", properties: { path: { type: "string", minLength: 1, description: "Path of the plan file, plan-<topic>.md in the scratch dir." } }, required: ["path"], additionalProperties: false } as never,
      async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const s = await ensureSession(ctx);
        const tier = s.ceremony.tier;
        const done = (decision: string, by: string | null, text: string, isError = false, reason?: string) => {
          s.trace?.emit({ event: "checkpoint", decision, by, tier, ...(reason ? { reason } : {}) });
          persistRounds(s);
          return { content: [{ type: "text" as const, text }], details: { decision, by }, ...(isError ? { isError: true } : {}) };
        };
        if (s.isChild) return done("refused", null, `${CHECKPOINT_TOOL} is for the foreman only.`, true);
        const r = readPlan(params.path, planOpts(s, ctx));
        if ("error" in r) return done("refused", null, r.error, true);
        const plan = r.plan;
        const name = `plan-${plan.topic}.md`;
        const ruling = rulingPickup(s, `checkpoint ${name}`);
        if (ruling) return done("pending", null, `pi-foreman: a newer ruling arrived before the checkpoint press; ${name} is not presented. Act on it, then call ${CHECKPOINT_TOOL} again.\n${ruling}`);
        const hash8 = plan.hash.slice(0, 8);
        s.trace?.emit({ event: "plan_version", tier, from: sha256(plan.bytes).slice(0, 16), to: plan.hash.slice(0, 16) }); // from = hash of the file bytes, to = version (body) hash
        // ceremony.planReview (planreview.ts): a [plan-review] verdict on these bytes first; a first FAIL sends the plan back for a revision.
        let reviewed: string | null = null;
        if (planReviewOn(s.config.config, tier)) {
          const cap = planReviewRounds(get(s.config.config, "ceremony.planReviewRounds"));
          const g = s.planReviews.gate(plan.path, planVersionHash(plan.bytes), cap);
          if ("refusal" in g) return done("refused", null, planReviewRefusalText(g.refusal, plan.rel, tier, g.stale), true, g.refusal);
          // Capped: the checkpoint opens on a FAIL with the open findings visible.
          reviewed = planReviewSection(g.verdict, await g.verdict.findings, g.capped ? { rounds: g.rounds ?? cap, cap } : undefined);
        }
        s.show?.checkpointed(plan.path); // ruling point (show.ts): the plan the owner is about to see
        if (s.plan && s.plan.status === "approved" && s.plan.hash === plan.hash && s.plan.path === plan.path) {
          // No dialog ran: the trace carries by: null so a re-check never counts as another approval.
          return done("approve", null, `${name} (${hash8}) is already approved by the owner (${s.plan.by}, ${s.plan.approvedAt}); builders may launch while it stays unchanged.`);
        }
        // Pending first: a crash, an abort or no answer leaves it pending, never approved.
        const rec: PlanRecord = { topic: plan.topic, path: plan.path, hash: plan.hash, status: "pending", approvedAt: null, by: null };
        s.plan = rec;
        s.waitingForParent = true; // pending: the owner/parent answers; the finish gate lets the turn end until the next input
        const pendingText = `No answer from the owner; the checkpoint of ${name} (${hash8}) stays pending — ask the owner in your reply. Builders stay refused at tier heavy until the owner approves (call ${CHECKPOINT_TOOL} again).`;
        // ceremony.checkpoint: `parent` (default for a session opened with a parent) takes the verdict from the parent-written ruling-plan.md, never a dialog.
        const parentMode = checkpointMode(get(s.config.config, "ceremony.checkpoint"), process.env) === "parent";
        const handoff = roundStateDir(process.env);
        const verdict = parentMode && handoff ? readPlanVerdict(handoff, plan.path, selfRulingsFor(s)) : null;
        let answer: string | undefined;
        if (verdict) {
          answer = verdict.kind === "approve" ? "approve" : verdict.kind;
        } else if (parentMode) {
          const file = handoff ? path.join(handoff, PLAN_VERDICT_FILE) : null;
          return done("pending", null, `${pendingText}${file ? ` The parent answers in ${file} (first line APPROVED, REVISE <text> or REJECT, written after the last plan edit; a ruling.md APPROVED there counts as APPROVED): wait with foreman_wait kind file on that path, then call ${CHECKPOINT_TOOL} again.` : ""}`);
        } else {
          if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return done("pending", null, pendingText);
          const title = `pi-foreman checkpoint: ${name} (${hash8})`;
          s.trace?.emit({ event: "dialog", surface: "checkpoint" });
          try {
            ctx.ui.notify(`${ownerSummary(plan.bytes.toString("utf8"))}\n\n${planSummary(plan.bytes.toString("utf8"), plan.rel, plan.hash)}${reviewed ? `\n${reviewed}` : ""}`, "info");
            answer = await withBlocked(herdrEvents, title, () => ctx.ui.select(title, [...CHECKPOINT_CHOICES], { signal }));
          } catch {
            answer = undefined;
          }
        }
        // A newer checkpoint replaced this one while the dialog was open: this answer is not applied.
        if (s.plan !== rec || answer === undefined || !(CHECKPOINT_CHOICES as readonly string[]).includes(answer)) return done("pending", null, pendingText);
        s.waitingForParent = false; // the owner answered
        if (answer === "approve") {
          // The owner approved what was on disk during the dialog: approve only if those are still the bytes hashed above.
          if (currentPlanHash(rec, planOpts(s, ctx)) !== rec.hash) {
            return done("pending", null, `${name} changed while the owner was reviewing it, so the approval is not applied: the checkpoint stays pending. Call ${CHECKPOINT_TOOL} again so the owner approves the current version.`);
          }
          rec.status = "approved";
          rec.source = !verdict ? "dialog" : handoff && readPlanVerdictFile(handoff, plan.path, selfRulingsFor(s)) ? "ruling-plan" : "ruling";
          rec.approvedAt = new Date().toISOString();
          rec.by = !verdict && ctx.mode === "tui" ? "user" : "rig";
          // a human's dialog answer (not a parent verdict) is kept in the harness-only approval store, keyed by the plan version hash
          if (!verdict) saveStored(s.agentDir, rec.hash, rec.topic, { approval: { at: rec.approvedAt, by: rec.by } });
          if (s.planPhase) {
            s.planPhase = false; // an approval ends the plan phase
            s.trace?.emit({ event: "plan_phase", decision: "off", cause: "checkpoint" });
          }
          return done("approve", rec.by, `The owner approved ${name} (${hash8}). Builders may launch at tier heavy while the file stays unchanged; any edit needs a new ${CHECKPOINT_TOOL}.`);
        }
        if (answer === "revise") {
          let note: string | undefined;
          if (verdict?.kind === "revise") note = verdict.note;
          else {
            try {
              note = await withBlocked(herdrEvents, "What should change?", () => ctx.ui.input("What should change?", undefined, { signal }));
            } catch {
              note = undefined;
            }
          }
          rec.status = "revise";
          if (note && note.trim()) rec.note = note.trim();
          return done("revise", null, `The owner asked for a revision of ${name}. The owner's words:\n${rec.note ?? "(no note given)"}\nChange the plan (edit it), then call ${CHECKPOINT_TOOL} again. Builders stay refused at tier heavy until the owner approves.`);
        }
        rec.status = "rejected";
        if (!verdict) ctx.ui.notify(`pi-foreman: ${name} was rejected; the heavy path is stopped (no builder launches until a new plan is approved).`, "warning");
        return done("reject", null, `The owner rejected ${name}. The heavy path is stopped: launch no builder; report to the owner and ask how to go on. A new plan needs a new ${CHECKPOINT_TOOL} approval.`);
      },
    } as never);
  }

  // Owner script (scriptapproval.ts, scriptrun.ts): the owner approves a script's bytes in a dialog, the harness runs them. Never in a
  // subagent child, never approved without the owner's own answer (no ruling file, no timeout). The script text is not inspected.
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.registerTool({
      name: SCRIPT_TOOL,
      label: "Owner script",
      // Never in parallel with other tool calls of the same message: no write lands while the owner decides or the script runs.
      executionMode: "sequential",
      description: "Ask the owner to approve a script for a change the guards close to every agent (user config, global installs, protected files), then run it. Write the script into the scratch dir: POSIX sh, LF line endings, no reliance on $0 or sibling files (the harness runs a private copy from the workspace root, stdin closed), and it must honour --dry-run or DRY_RUN=1 by changing nothing on that run. propose (path, description, risk, undo) opens the owner's dialog (approve, revise with a note, reject); on approve the dry run runs at once and its output is returned. Read the dry-run output before run: when it shows an unexpected state or a different change than described, stop and propose again with a corrected description. dry reruns the dry run, run is the real run (it needs a passed dry run of the same text), status shows the proposal; these three take no path. A small fix of the script after approval reruns with a notice to the owner, a larger one needs a new propose. Without an answer the proposal stays pending.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["propose", "dry", "run", "status"] },
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
        if (s.isChild) return refusal({ code: "script_child", error: `pi-foreman: ${SCRIPT_TOOL} refused (script_child): a subagent child never proposes or runs an owner script; report the needed change to the foreman.` });
        const o = planOpts(s, ctx);
        const action = params.action;

        /** A dry or real run of the proposal's own script: fix rule, runner, state, trace. */
        const runNow = async (kind: ScriptRunKind) => {
          const limit = get(s.config.config, "safety.scripts.silentFixLines");
          const plan = beginRun(s.script, kind, o, Date.now(), typeof limit === "number" ? limit : SCRIPT_FIX_LINES_DEFAULT);
          if (plan.fix) {
            ctx.ui.notify(plan.fix.notice, "warning");
            s.trace?.emit({ event: "script_fix", from: plan.fix.from, to: plan.fix.to, added: plan.fix.added, removed: plan.fix.removed });
          }
          if ("error" in plan) return refusal(plan);
          const r = await runOwnerScript({ bytes: plan.bytes, kind, cwd: workspaceOf(ctx.cwd).root, logPath: plan.logPath, timeoutSeconds: typeof params.timeoutSeconds === "number" ? params.timeoutSeconds : undefined, signal, platform, config: s.config.config, shellPath: shellPathSetting(s.agentDir, ctx.cwd) });
          if ("code" in r) {
            // refused before anything spawned: not one of the real attempts
            if (kind === "run" && s.script.proposal) s.script.proposal.attempts = Math.max(0, s.script.proposal.attempts - 1);
            return refusal(r);
          }
          const exit = r.error ? null : r.exitCode;
          const status = recordRun(s.script, kind, plan.hash, exit);
          s.trace?.emit({ event: "script_run", kind, hash: shortHash(plan.hash), exit, seconds: r.seconds });
          const p = s.script.proposal;
          const how = r.error ?? (r.timedOut ? "stopped at the time limit" : r.aborted ? "aborted" : exit === null ? `ended by ${r.signal ?? "a signal"}` : `exit ${exit}`);
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
          return out(kind, `${head}\n${r.tail ? `Last lines:\n${r.tail}\n` : "(no output)\n"}${next}`, { status, exit, logPath: r.logPath, hash: plan.hash }, exit !== 0);
        };

        if (action === "dry" || action === "run" || action === "status") {
          if (params.path !== undefined) return refusal({ code: "script_path", error: `pi-foreman: ${SCRIPT_TOOL} refused (script_path): ${action} takes no path; it uses the script of the proposal. A different script needs a new propose.` });
          if (action !== "status") return runNow(action);
          const st = scriptStatus(s.script, Date.now());
          return out("status", st ? JSON.stringify(st, null, 2) : "No script is proposed in this session.", { status: st?.status ?? null });
        }
        if (action !== "propose") return out("refused", `${SCRIPT_TOOL}: action must be propose, dry, run or status.`, {}, true);

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
          ctx.ui.notify(scriptNoticeLines(p).join("\n"), "info");
          answer = await withBlocked(herdrEvents, title, () => ctx.ui.select(title, [...SCRIPT_CHOICES], { signal }));
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
            note = await withBlocked(herdrEvents, "What should change?", () => ctx.ui.input("What should change?", undefined, { signal }));
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
  function retroInputs(s: Session, ctx: ExtensionContext, sessionFlag: string, reportOnly = false): string[] {
    const args = ["--agent-dir", s.agentDir, "--usage", s.usage.file];
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) args.push(sessionFlag, sessionFile);
    if (s.trace) args.push("--trace", s.trace.file);
    // Bound children of this session trace to trace-<launchId>.jsonl (retro.ts sessionTrace).
    for (const id of s.launches.keys()) {
      const f = traceFile(get(s.config.config, "trace.dir"), s.markerDir, id);
      if (fs.existsSync(f)) args.push("--trace", f);
    }
    // Backlog: file under this workspace; off when retro is off, and for the compaction report (counted by the next /retro or /sync).
    args.push("--backlog-workspace", workspaceOf(s.cwd).root);
    const wsKey = get(s.config.config, "retro.workspaceKey");
    if (typeof wsKey === "string" && wsKey.trim()) args.push("--workspace-key", wsKey.trim());
    if (reportOnly || !retroEnabled(get(s.config.config, "retro.enabled"), ctx.mode)) args.push("--no-backlog");
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
    description: "pi-foreman commands: /foreman doctor | /foreman status | /foreman waits | /foreman cost [workspace] | /foreman budget lift | /foreman update-check | /foreman setup [args] | /foreman close [result-path] | /foreman session open|brief|close|list | /foreman plan [off] | /foreman trust bridge | /foreman perms mode|reload|list",
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
        ctx.ui.notify(await trustBridgeCommand(s.agentDir, s.cwd, projectBridgeConfigRisks(s.cwd), { hasUI: ctx.hasUI, mode: ctx.mode, confirm: blockedConfirm(herdrEvents, (title, msg) => ctx.ui.confirm(title, msg)) }), "info");
        return;
      }
      if (sub === "perms") {
        const s = await ensureSession(ctx);
        if (rest[0] === "suggest" || rest[0] === "review" || rest[0] === "adopt") {
          ctx.ui.notify(await workshopCommand(s, ctx, rest), "info");
          return;
        }
        if (rest[0] === "protect") {
          const usage = "Usage: /foreman perms protect add|remove <host|path|command> <glob> [--note <text>] [--user]";
          const args = rest.slice(1);
          const user = args.includes("--user");
          const ni = args.indexOf("--note");
          const note = ni >= 0 ? args.slice(ni + 1).filter((w) => w !== "--user").join(" ") : undefined;
          const head = (ni >= 0 ? args.slice(0, ni) : args).filter((w) => w !== "--user");
          if (head.length < 3 || (ni >= 0 && !note)) {
            ctx.ui.notify(usage, "warning");
            return;
          }
          const r = await protectEntry(s, ctx, { action: head[0], kind: head[1], glob: head.slice(2).join(" "), ...(note ? { note } : {}), file: user ? "user" : "project" });
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
        ctx.ui.notify(rec ? `pi-foreman: flagged the last answered ask (${rec.family}${s.trace ? "" : "; tracing is off, nothing was written"}).` : "pi-foreman: no ask answered in this session yet; nothing flagged.", rec ? "info" : "warning");
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
      if (sub !== "doctor") {
        ctx.ui.notify("Usage: /foreman doctor | /foreman status | /foreman waits | /foreman cost [workspace] | /foreman budget lift | /foreman flag-ask [note] | /foreman update-check | /foreman setup [args] | /foreman close [result-path] | /foreman session open|brief|close|list | /foreman plan [off]", "warning");
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

    if (fs.existsSync(path.join(CORE_DIR, "scripts", "destructive_guard.py"))) ok(`core scripts at ${CORE_DIR}`);
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
    if (s.overlay) ok(`permission overlay active (${s.overlay.bashDeny.length} command deny, ${s.overlay.pathRules.length} path rules, ${s.overlay.bashAsk.length + s.overlay.pathAsk.length} project/session ask)`);
    else fail("permission overlay baseline unreadable (shell and file tools are blocked)", "reinstall pi-foreman: config/permissions.baseline.json is part of the package.");
    for (const sh of shadowedRoles(s.cwd, childRoleIds(get(s.config.config, "roles")))) out.push(`WARN project agent shadows a role (${sh}) — fix: ${SHADOW_FIX}`);

    if (fs.existsSync(markerPath(s.markerDir, s.id))) ok(`session marker in ${s.markerDir}`);
    else fail("session marker missing", `make ${s.markerDir} writable and restart the session.`);
    out.push(`INFO ceremony: ${tierLine(s.ceremony)}`);
    out.push(`INFO sidebar status: ${s.extStatus.describe()}`);
    out.push(`INFO PR tools: ${s.prPack ? prHostLabel(get(s.config.config, "tools.prHost") ?? "auto", workspaceOf(s.cwd).root, process.env, platform) : "off (tools.pr)"}`);
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
    const addonOn = addonPresent(pi.getAllTools().map((t) => t.name), { agentDir: s.agentDir, cwd: s.cwd });
    out.push(`INFO background-tasks: ${addonOn ? "present" : "absent"}`);
    out.push(...bgFeaturesDoctor(addonOn, s.agentDir, process.env));
    if (!s.isChild) out.push(...deferredDoctorLines(deferred.patterns, pi.getAllTools().map((t) => t.name)));
    const peerLine = addonPeerRangeLine({ agentDir: s.agentDir, cwd: s.cwd }, await (deps.piVersion ?? runningPiVersion)());
    if (peerLine) out.push(peerLine);
    out.push(...optionalAddonsDoctor({ agentDir: s.agentDir, cwd: s.cwd }, pi.getAllTools().map((t) => t.name), process.env));
    out.push(dormantDoctorLine(PKG_ROOT, s.config.config));
    // The profile and its deviations are read without the project layer (the agent dir has no .pi/foreman.json), so project tightening is not noise.
    const userOnly = s.python.ok ? await loadMergedConfig({ python: pyPath(s), pkgRoot: PKG_ROOT, agentDir: s.agentDir, projectDir: s.agentDir, trusted: false, spawner }) : null;
    out.push(...profileDoctorLines(userOnly && userOnly.source === "cli" ? userOnly.config : s.config.config, s.config.config, PKG_ROOT));
    return out;
  }
}

/** Trace label for a core-guard ask, from the translated block reason (undefined = approved). */
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
    confirm: blockedConfirm(herdrEvents, (title, msg) => {
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

