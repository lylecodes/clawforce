import type {
  EntityHealthConfig,
  EntityCheckParserConfig,
  EntityCheckStatusIssueRule,
  EntityIssueStateSignalConfig,
  EntityIssueStateSignalOwnerPresence,
  EntityIssueTaskConfig,
  EntityIssueSeverity,
  EntityIssuesConfig,
  EntityKindConfig,
  EntityMetadataFieldConfig,
  EntityMetadataFieldType,
  EntityReadinessConfig,
  EntityRelationshipConfig,
  EntityStateConfig,
  EntityTransitionConfig,
  WorkforceConfig,
} from "../types.js";
import { TASK_KINDS, TASK_PRIORITIES, TASK_STATES } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const METADATA_FIELD_TYPES: readonly EntityMetadataFieldType[] = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
] as const;

const ENTITY_ISSUE_SEVERITIES: readonly EntityIssueSeverity[] = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

const ENTITY_ISSUE_SIGNAL_OWNER_PRESENCE: readonly EntityIssueStateSignalOwnerPresence[] = [
  "any",
  "missing",
  "present",
] as const;

function normalizeEntityStates(kind: string, raw: unknown): Record<string, EntityStateConfig> {
  if (Array.isArray(raw)) {
    const states = raw
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .reduce<Record<string, EntityStateConfig>>((acc, state) => {
        acc[state.trim()] = {};
        return acc;
      }, {});
    if (Object.keys(states).length === 0) {
      throw new Error(`entities.${kind}.states must define at least one state`);
    }
    return states;
  }

  if (!isRecord(raw)) {
    throw new Error(`entities.${kind}.states must be an object or string array`);
  }

  const states: Record<string, EntityStateConfig> = {};
  for (const [stateName, stateDef] of Object.entries(raw)) {
    if (!stateName.trim()) continue;
    if (stateDef == null) {
      states[stateName] = {};
      continue;
    }
    if (!isRecord(stateDef)) {
      throw new Error(`entities.${kind}.states.${stateName} must be an object`);
    }
    states[stateName] = {
      description: typeof stateDef.description === "string" ? stateDef.description : undefined,
      initial: typeof stateDef.initial === "boolean" ? stateDef.initial : undefined,
      terminal: typeof stateDef.terminal === "boolean" ? stateDef.terminal : undefined,
    };
  }

  if (Object.keys(states).length === 0) {
    throw new Error(`entities.${kind}.states must define at least one state`);
  }
  return states;
}

function normalizeEntityTransitions(
  kind: string,
  states: Record<string, EntityStateConfig>,
  raw: unknown,
): EntityTransitionConfig[] {
  if (raw == null) {
    if (Object.keys(states).length > 1) {
      throw new Error(`entities.${kind}.transitions is required when more than one state is defined`);
    }
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`entities.${kind}.transitions must be an array`);
  }

  const transitions: EntityTransitionConfig[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry) || typeof entry.from !== "string" || typeof entry.to !== "string") {
      throw new Error(`entities.${kind}.transitions[${index}] must include string from/to fields`);
    }
    if (!(entry.from in states)) {
      throw new Error(`entities.${kind}.transitions[${index}].from references unknown state "${entry.from}"`);
    }
    if (!(entry.to in states)) {
      throw new Error(`entities.${kind}.transitions[${index}].to references unknown state "${entry.to}"`);
    }
    const blockedBySeveritiesRaw = entry.blockedBySeverities ?? entry.blocked_by_severities;
    const blockedByIssueTypesRaw = entry.blockedByIssueTypes ?? entry.blocked_by_issue_types;
    transitions.push({
      from: entry.from,
      to: entry.to,
      reasonRequired: typeof entry.reasonRequired === "boolean"
        ? entry.reasonRequired
        : typeof entry.reason_required === "boolean"
          ? entry.reason_required
          : undefined,
      approvalRequired: typeof entry.approvalRequired === "boolean"
        ? entry.approvalRequired
        : typeof entry.approval_required === "boolean"
          ? entry.approval_required
          : undefined,
      blockedByOpenIssues: typeof entry.blockedByOpenIssues === "boolean"
        ? entry.blockedByOpenIssues
        : typeof entry.blocked_by_open_issues === "boolean"
          ? entry.blocked_by_open_issues
          : undefined,
      blockedBySeverities: Array.isArray(blockedBySeveritiesRaw)
        ? blockedBySeveritiesRaw
          .filter((value): value is EntityIssueSeverity =>
            typeof value === "string" && ENTITY_ISSUE_SEVERITIES.includes(value as EntityIssueSeverity))
        : undefined,
      blockedByIssueTypes: Array.isArray(blockedByIssueTypesRaw)
        ? blockedByIssueTypesRaw
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : undefined,
    });
  }

  return transitions;
}

function normalizeEntityHealth(kind: string, raw: unknown): EntityHealthConfig | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const values = raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (values.length === 0) {
      throw new Error(`entities.${kind}.health must define at least one health value`);
    }
    return {
      values,
      default: values[0],
    };
  }
  if (!isRecord(raw) || !Array.isArray(raw.values)) {
    throw new Error(`entities.${kind}.health must be an array or object with values`);
  }
  const values = raw.values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (values.length === 0) {
    throw new Error(`entities.${kind}.health.values must define at least one health value`);
  }
  const defaultValue = typeof raw.default === "string" ? raw.default : undefined;
  if (defaultValue && !values.includes(defaultValue)) {
    throw new Error(`entities.${kind}.health.default must be one of the declared health values`);
  }
  const clearValue = typeof raw.clear === "string" ? raw.clear : undefined;
  if (clearValue && !values.includes(clearValue)) {
    throw new Error(`entities.${kind}.health.clear must be one of the declared health values`);
  }
  return {
    values,
    default: defaultValue ?? values[0],
    clear: clearValue,
  };
}

function normalizeEntityRelationships(kind: string, raw: unknown): EntityRelationshipConfig | undefined {
  if (raw == null) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`entities.${kind}.relationships must be an object`);
  }
  const parentRaw = raw.parent;
  if (parentRaw == null) return undefined;
  if (!isRecord(parentRaw)) {
    throw new Error(`entities.${kind}.relationships.parent must be an object`);
  }
  const allowedKindsRaw = parentRaw.allowedKinds ?? parentRaw.allowed_kinds;
  const allowedKinds = Array.isArray(allowedKindsRaw)
    ? allowedKindsRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : undefined;
  return {
    parent: {
      enabled: typeof parentRaw.enabled === "boolean" ? parentRaw.enabled : undefined,
      allowedKinds,
    },
  };
}

function normalizeMetadataField(kind: string, fieldName: string, raw: unknown): EntityMetadataFieldConfig {
  if (typeof raw === "string") {
    if (!METADATA_FIELD_TYPES.includes(raw as EntityMetadataFieldType)) {
      throw new Error(`entities.${kind}.metadataSchema.${fieldName} has invalid type "${raw}"`);
    }
    return { type: raw as EntityMetadataFieldType };
  }
  if (!isRecord(raw) || typeof raw.type !== "string") {
    throw new Error(`entities.${kind}.metadataSchema.${fieldName} must be a string or object with type`);
  }
  if (!METADATA_FIELD_TYPES.includes(raw.type as EntityMetadataFieldType)) {
    throw new Error(`entities.${kind}.metadataSchema.${fieldName} has invalid type "${raw.type}"`);
  }
  const enumValues = Array.isArray(raw.enum)
    ? raw.enum.filter((value): value is string => typeof value === "string")
    : undefined;
  return {
    type: raw.type as EntityMetadataFieldType,
    required: typeof raw.required === "boolean" ? raw.required : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    enum: enumValues && enumValues.length > 0 ? enumValues : undefined,
  };
}

function normalizeEntityMetadataSchema(kind: string, raw: unknown): Record<string, EntityMetadataFieldConfig> | undefined {
  if (raw == null) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`entities.${kind}.metadataSchema must be an object`);
  }
  const schema: Record<string, EntityMetadataFieldConfig> = {};
  for (const [fieldName, fieldDef] of Object.entries(raw)) {
    schema[fieldName] = normalizeMetadataField(kind, fieldName, fieldDef);
  }
  return schema;
}

function normalizeEntityReadiness(kind: string, states: Record<string, EntityStateConfig>, raw: unknown): EntityReadinessConfig | undefined {
  if (raw == null) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`entities.${kind}.readiness must be an object`);
  }

  const requirementsRaw = raw.requirements;
  if (requirementsRaw != null && !isRecord(requirementsRaw)) {
    throw new Error(`entities.${kind}.readiness.requirements must be an object`);
  }

  const closeTasksRaw = raw.closeTasksWhenReady ?? raw.close_tasks_when_ready;
  if (closeTasksRaw != null && !isRecord(closeTasksRaw)) {
    throw new Error(`entities.${kind}.readiness.closeTasksWhenReady must be an object`);
  }
  const requestTransitionRaw = raw.requestTransitionWhenReady ?? raw.request_transition_when_ready;
  if (requestTransitionRaw != null && !isRecord(requestTransitionRaw)) {
    throw new Error(`entities.${kind}.readiness.requestTransitionWhenReady must be an object`);
  }

  const whenStatesRaw = raw.whenStates ?? raw.when_states;
  const whenStates = Array.isArray(whenStatesRaw)
    ? whenStatesRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : undefined;
  if (whenStates) {
    for (const state of whenStates) {
      if (!(state in states)) {
        throw new Error(`entities.${kind}.readiness.whenStates references unknown state "${state}"`);
      }
    }
  }

  const blockersField = typeof raw.blockersField === "string"
    ? raw.blockersField
    : typeof raw.blockers_field === "string"
      ? raw.blockers_field
      : undefined;

  const metadataTrueRaw = requirementsRaw ? (requirementsRaw.metadataTrue ?? requirementsRaw.metadata_true) : undefined;
  const metadataEqualsRaw = requirementsRaw ? (requirementsRaw.metadataEquals ?? requirementsRaw.metadata_equals) : undefined;
  const metadataMinRaw = requirementsRaw ? (requirementsRaw.metadataMin ?? requirementsRaw.metadata_min) : undefined;
  const titleTemplatesRaw = closeTasksRaw ? (closeTasksRaw.titleTemplates ?? closeTasksRaw.title_templates) : undefined;

  return {
    whenStates,
    blockersField,
    requirements: requirementsRaw ? {
      noOpenIssues: typeof requirementsRaw.noOpenIssues === "boolean"
        ? requirementsRaw.noOpenIssues
        : typeof requirementsRaw.no_open_issues === "boolean"
          ? requirementsRaw.no_open_issues
          : undefined,
      metadataTrue: Array.isArray(metadataTrueRaw)
        ? metadataTrueRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : undefined,
      metadataEquals: isRecord(metadataEqualsRaw)
        ? Object.fromEntries(
          Object.entries(metadataEqualsRaw).filter(([, value]) =>
            typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
        ) as Record<string, string | number | boolean>
        : undefined,
      metadataMin: isRecord(metadataMinRaw)
        ? Object.fromEntries(
          Object.entries(metadataMinRaw).filter(([, value]) => typeof value === "number"),
        ) as Record<string, number>
        : undefined,
    } : undefined,
    closeTasksWhenReady: closeTasksRaw ? {
      titleTemplates: Array.isArray(titleTemplatesRaw)
        ? titleTemplatesRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : undefined,
    } : undefined,
    requestTransitionWhenReady: requestTransitionRaw ? {
      toState: typeof requestTransitionRaw.toState === "string"
        ? requestTransitionRaw.toState
        : typeof requestTransitionRaw.to_state === "string"
          ? requestTransitionRaw.to_state
          : "",
      reason: typeof requestTransitionRaw.reason === "string" ? requestTransitionRaw.reason : undefined,
      actor: typeof requestTransitionRaw.actor === "string" ? requestTransitionRaw.actor : undefined,
    } : undefined,
  };
}

function normalizeIssueSeverity(value: unknown, path: string): EntityIssueSeverity | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !ENTITY_ISSUE_SEVERITIES.includes(value as EntityIssueSeverity)) {
    throw new Error(`${path} must be one of: ${ENTITY_ISSUE_SEVERITIES.join(", ")}`);
  }
  return value as EntityIssueSeverity;
}

function normalizeIssueTaskConfig(path: string, raw: unknown): boolean | EntityIssueTaskConfig | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "boolean") return raw;
  if (!isRecord(raw)) {
    throw new Error(`${path} must be a boolean or object`);
  }
  const rerunCheckIdsRaw = raw.rerunCheckIds ?? raw.rerun_check_ids;
  const rerunOnStatesRaw = raw.rerunOnStates ?? raw.rerun_on_states;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    titleTemplate: typeof raw.titleTemplate === "string"
      ? raw.titleTemplate
      : typeof raw.title_template === "string"
        ? raw.title_template
        : undefined,
    descriptionTemplate: typeof raw.descriptionTemplate === "string"
      ? raw.descriptionTemplate
      : typeof raw.description_template === "string"
        ? raw.description_template
        : undefined,
    priority: typeof raw.priority === "string" ? raw.priority as import("../types.js").TaskPriority : undefined,
    kind: typeof raw.kind === "string" ? raw.kind as import("../types.js").TaskKind : undefined,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : undefined,
    rerunCheckIds: Array.isArray(rerunCheckIdsRaw)
      ? rerunCheckIdsRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : undefined,
    rerunOnStates: Array.isArray(rerunOnStatesRaw)
      ? rerunOnStatesRaw.filter((value): value is import("../types.js").TaskState => typeof value === "string" && value.trim().length > 0)
      : undefined,
    closeTaskOnResolved: typeof raw.closeTaskOnResolved === "boolean"
      ? raw.closeTaskOnResolved
      : typeof raw.close_task_on_resolved === "boolean"
        ? raw.close_task_on_resolved
        : undefined,
  };
}

function normalizeEntityStateSignal(
  kind: string,
  raw: unknown,
  index: number,
): EntityIssueStateSignalConfig {
  const path = `entities.${kind}.issues.stateSignals[${index}]`;
  const issueType = isRecord(raw)
    ? typeof raw.issueType === "string"
      ? raw.issueType
      : typeof raw.issue_type === "string"
        ? raw.issue_type
        : undefined
    : undefined;
  if (!isRecord(raw) || !issueType?.trim()) {
    throw new Error(`${path} must define a non-empty issueType`);
  }

  const whenStatesRaw = raw.whenStates ?? raw.when_states;
  const ownerPresenceRaw = raw.ownerPresence ?? raw.owner_presence;
  const ownerPresence = typeof ownerPresenceRaw === "string"
    ? ownerPresenceRaw as EntityIssueStateSignalOwnerPresence
    : undefined;
  if (ownerPresence && !ENTITY_ISSUE_SIGNAL_OWNER_PRESENCE.includes(ownerPresence)) {
    throw new Error(`${path}.ownerPresence must be one of: ${ENTITY_ISSUE_SIGNAL_OWNER_PRESENCE.join(", ")}`);
  }

  return {
    id: typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : undefined,
    whenStates: Array.isArray(whenStatesRaw)
      ? whenStatesRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : undefined,
    ownerPresence: ownerPresence ?? "any",
    issueType: issueType.trim(),
    issueKey: typeof raw.issueKey === "string"
      ? raw.issueKey
      : typeof raw.issue_key === "string"
        ? raw.issue_key
        : undefined,
    issueKeyTemplate: typeof raw.issueKeyTemplate === "string"
      ? raw.issueKeyTemplate
      : typeof raw.issue_key_template === "string"
        ? raw.issue_key_template
        : undefined,
    titleTemplate: typeof raw.titleTemplate === "string"
      ? raw.titleTemplate
      : typeof raw.title_template === "string"
        ? raw.title_template
        : undefined,
    descriptionTemplate: typeof raw.descriptionTemplate === "string"
      ? raw.descriptionTemplate
      : typeof raw.description_template === "string"
        ? raw.description_template
        : undefined,
    recommendedAction: typeof raw.recommendedAction === "string"
      ? raw.recommendedAction
      : typeof raw.recommended_action === "string"
        ? raw.recommended_action
        : undefined,
    playbook: typeof raw.playbook === "string" ? raw.playbook : undefined,
    ownerAgentId: typeof raw.ownerAgentId === "string"
      ? raw.ownerAgentId
      : typeof raw.owner_agent_id === "string"
        ? raw.owner_agent_id
        : undefined,
    severity: normalizeIssueSeverity(raw.severity, `${path}.severity`),
    blocking: typeof raw.blocking === "boolean" ? raw.blocking : undefined,
    approvalRequired: typeof raw.approvalRequired === "boolean"
      ? raw.approvalRequired
      : typeof raw.approval_required === "boolean"
        ? raw.approval_required
        : undefined,
  };
}

function normalizeEntityIssues(kind: string, raw: unknown): EntityIssuesConfig | undefined {
  if (raw == null) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`entities.${kind}.issues must be an object`);
  }

  const defaultBlockingSeveritiesRaw = raw.defaultBlockingSeverities ?? raw.default_blocking_severities;
  const defaultBlockingSeverities = Array.isArray(defaultBlockingSeveritiesRaw)
    ? defaultBlockingSeveritiesRaw
      .map((value, index) => normalizeIssueSeverity(value, `entities.${kind}.issues.defaultBlockingSeverities[${index}]`))
      .filter((value): value is EntityIssueSeverity => Boolean(value))
    : undefined;

  const defaultHealthBySeverityRaw = raw.defaultHealthBySeverity ?? raw.default_health_by_severity;
  let defaultHealthBySeverity: Partial<Record<EntityIssueSeverity, string>> | undefined;
  if (defaultHealthBySeverityRaw != null) {
    if (!isRecord(defaultHealthBySeverityRaw)) {
      throw new Error(`entities.${kind}.issues.defaultHealthBySeverity must be an object`);
    }
    defaultHealthBySeverity = {};
    for (const [severity, health] of Object.entries(defaultHealthBySeverityRaw)) {
      const normalizedSeverity = normalizeIssueSeverity(
        severity,
        `entities.${kind}.issues.defaultHealthBySeverity.${severity}`,
      );
      if (typeof health !== "string" || !health.trim()) {
        throw new Error(`entities.${kind}.issues.defaultHealthBySeverity.${severity} must be a non-empty string`);
      }
      if (normalizedSeverity) {
        defaultHealthBySeverity[normalizedSeverity] = health;
      }
    }
  }

  const checksRaw = raw.checks;
  let checks: EntityIssuesConfig["checks"];
  if (checksRaw != null) {
    if (!isRecord(checksRaw)) {
      throw new Error(`entities.${kind}.issues.checks must be an object`);
    }
    checks = {};
    for (const [checkId, checkDef] of Object.entries(checksRaw)) {
      if (!isRecord(checkDef) || typeof checkDef.command !== "string" || !checkDef.command.trim()) {
        throw new Error(`entities.${kind}.issues.checks.${checkId} must define a non-empty command`);
      }
      const issueTypesRaw = checkDef.issueTypes ?? checkDef.issue_types;
      checks[checkId] = {
        title: typeof checkDef.title === "string" ? checkDef.title : undefined,
        description: typeof checkDef.description === "string" ? checkDef.description : undefined,
        command: checkDef.command,
        parser: normalizeEntityCheckParser(kind, checkId, checkDef.parser),
        timeoutSeconds: typeof checkDef.timeoutSeconds === "number"
          ? checkDef.timeoutSeconds
          : typeof checkDef.timeout_seconds === "number"
            ? checkDef.timeout_seconds
            : undefined,
        required: typeof checkDef.required === "boolean" ? checkDef.required : undefined,
        issueTypes: Array.isArray(issueTypesRaw)
          ? issueTypesRaw
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : undefined,
        playbook: typeof checkDef.playbook === "string" ? checkDef.playbook : undefined,
      };
    }
  }

  const typesRaw = raw.types;
  let types: EntityIssuesConfig["types"];
  if (typesRaw != null) {
    if (!isRecord(typesRaw)) {
      throw new Error(`entities.${kind}.issues.types must be an object`);
    }
    types = {};
    for (const [issueType, issueDef] of Object.entries(typesRaw)) {
      if (!isRecord(issueDef)) {
        throw new Error(`entities.${kind}.issues.types.${issueType} must be an object`);
      }
      types[issueType] = {
        title: typeof issueDef.title === "string" ? issueDef.title : undefined,
        description: typeof issueDef.description === "string" ? issueDef.description : undefined,
        defaultSeverity: normalizeIssueSeverity(
          issueDef.defaultSeverity ?? issueDef.default_severity,
          `entities.${kind}.issues.types.${issueType}.defaultSeverity`,
        ),
        blocking: typeof issueDef.blocking === "boolean" ? issueDef.blocking : undefined,
        approvalRequired: typeof issueDef.approvalRequired === "boolean"
          ? issueDef.approvalRequired
          : typeof issueDef.approval_required === "boolean"
            ? issueDef.approval_required
            : undefined,
        health: typeof issueDef.health === "string" ? issueDef.health : undefined,
        playbook: typeof issueDef.playbook === "string" ? issueDef.playbook : undefined,
        task: normalizeIssueTaskConfig(`entities.${kind}.issues.types.${issueType}.task`, issueDef.task),
      };
    }
  }

  const stateSignalsRaw = raw.stateSignals ?? raw.state_signals;
  const stateSignals = Array.isArray(stateSignalsRaw)
    ? stateSignalsRaw.map((entry, index) => normalizeEntityStateSignal(kind, entry, index))
    : undefined;

  return {
    autoSyncHealth: typeof raw.autoSyncHealth === "boolean"
      ? raw.autoSyncHealth
      : typeof raw.auto_sync_health === "boolean"
        ? raw.auto_sync_health
        : undefined,
    defaultBlockingSeverities,
    defaultHealthBySeverity,
    checks,
    types,
    stateSignals,
  };
}

function normalizeStatusIssueRule(
  kind: string,
  checkId: string,
  statusName: string,
  raw: unknown,
): EntityCheckStatusIssueRule {
  if (!isRecord(raw) || typeof raw.issueType !== "string" || !raw.issueType.trim()) {
    throw new Error(`entities.${kind}.issues.checks.${checkId}.parser.issueStates.${statusName} must define a non-empty issueType`);
  }
  return {
    issueType: raw.issueType,
    severity: normalizeIssueSeverity(
      raw.severity,
      `entities.${kind}.issues.checks.${checkId}.parser.issueStates.${statusName}.severity`,
    ),
    blocking: typeof raw.blocking === "boolean" ? raw.blocking : undefined,
    approvalRequired: typeof raw.approvalRequired === "boolean"
      ? raw.approvalRequired
      : typeof raw.approval_required === "boolean"
        ? raw.approval_required
        : undefined,
    titleTemplate: typeof raw.titleTemplate === "string"
      ? raw.titleTemplate
      : typeof raw.title_template === "string"
        ? raw.title_template
        : undefined,
    descriptionTemplate: typeof raw.descriptionTemplate === "string"
      ? raw.descriptionTemplate
      : typeof raw.description_template === "string"
        ? raw.description_template
        : undefined,
  };
}

function normalizeEntityCheckParser(
  kind: string,
  checkId: string,
  raw: unknown,
): EntityCheckParserConfig | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw;
  if (!isRecord(raw) || typeof raw.type !== "string") {
    throw new Error(`entities.${kind}.issues.checks.${checkId}.parser must be a string or object with type`);
  }

  if (raw.type === "json_record_issues") {
    const recordsPath = typeof raw.recordsPath === "string"
      ? raw.recordsPath
      : typeof raw.records_path === "string"
        ? raw.records_path
        : undefined;
    const matchField = typeof raw.matchField === "string"
      ? raw.matchField
      : typeof raw.match_field === "string"
        ? raw.match_field
        : undefined;
    const issueArrayPath = typeof raw.issueArrayPath === "string"
      ? raw.issueArrayPath
      : typeof raw.issue_array_path === "string"
        ? raw.issue_array_path
        : undefined;
    if (!recordsPath?.trim()) {
      throw new Error(`entities.${kind}.issues.checks.${checkId}.parser.recordsPath is required`);
    }
    if (!matchField?.trim()) {
      throw new Error(`entities.${kind}.issues.checks.${checkId}.parser.matchField is required`);
    }
    if (!issueArrayPath?.trim()) {
      throw new Error(`entities.${kind}.issues.checks.${checkId}.parser.issueArrayPath is required`);
    }
    const issueTypeMapRaw = raw.issueTypeMap ?? raw.issue_type_map;
    const metadataUpdatesRaw = raw.metadataUpdates ?? raw.metadata_updates;
    return {
      type: "json_record_issues",
      recordsPath,
      matchField,
      matchValueTemplate: typeof raw.matchValueTemplate === "string"
        ? raw.matchValueTemplate
        : typeof raw.match_value_template === "string"
          ? raw.match_value_template
          : undefined,
      issueArrayPath,
      issueTypeField: typeof raw.issueTypeField === "string"
        ? raw.issueTypeField
        : typeof raw.issue_type_field === "string"
          ? raw.issue_type_field
          : undefined,
      issueTypeMap: isRecord(issueTypeMapRaw)
        ? Object.fromEntries(Object.entries(issueTypeMapRaw).filter(([, value]) => typeof value === "string")) as Record<string, string>
        : undefined,
      defaultIssueType: typeof raw.defaultIssueType === "string"
        ? raw.defaultIssueType
        : typeof raw.default_issue_type === "string"
          ? raw.default_issue_type
          : undefined,
      severityField: typeof raw.severityField === "string"
        ? raw.severityField
        : typeof raw.severity_field === "string"
          ? raw.severity_field
          : undefined,
      titleField: typeof raw.titleField === "string"
        ? raw.titleField
        : typeof raw.title_field === "string"
          ? raw.title_field
          : undefined,
      descriptionField: typeof raw.descriptionField === "string"
        ? raw.descriptionField
        : typeof raw.description_field === "string"
          ? raw.description_field
          : undefined,
      descriptionTemplate: typeof raw.descriptionTemplate === "string"
        ? raw.descriptionTemplate
        : typeof raw.description_template === "string"
          ? raw.description_template
          : undefined,
      fieldNameField: typeof raw.fieldNameField === "string"
        ? raw.fieldNameField
        : typeof raw.field_name_field === "string"
          ? raw.field_name_field
          : undefined,
      keyTemplate: typeof raw.keyTemplate === "string"
        ? raw.keyTemplate
        : typeof raw.key_template === "string"
          ? raw.key_template
          : undefined,
      metadataUpdates: isRecord(metadataUpdatesRaw)
        ? Object.fromEntries(Object.entries(metadataUpdatesRaw).filter(([, value]) => typeof value === "string")) as Record<string, string>
        : undefined,
    };
  }

  if (raw.type === "json_record_status") {
    const recordsPath = typeof raw.recordsPath === "string"
      ? raw.recordsPath
      : typeof raw.records_path === "string"
        ? raw.records_path
        : undefined;
    const matchField = typeof raw.matchField === "string"
      ? raw.matchField
      : typeof raw.match_field === "string"
        ? raw.match_field
        : undefined;
    const statusField = typeof raw.statusField === "string"
      ? raw.statusField
      : typeof raw.status_field === "string"
        ? raw.status_field
        : undefined;
    if (!recordsPath?.trim()) {
      throw new Error(`entities.${kind}.issues.checks.${checkId}.parser.recordsPath is required`);
    }
    if (!matchField?.trim()) {
      throw new Error(`entities.${kind}.issues.checks.${checkId}.parser.matchField is required`);
    }
    if (!statusField?.trim()) {
      throw new Error(`entities.${kind}.issues.checks.${checkId}.parser.statusField is required`);
    }
    const issueStatesRaw = raw.issueStates ?? raw.issue_states;
    if (!isRecord(issueStatesRaw)) {
      throw new Error(`entities.${kind}.issues.checks.${checkId}.parser.issueStates must be an object`);
    }
    const issueStates = Object.fromEntries(
      Object.entries(issueStatesRaw).map(([statusName, issueRule]) => [
        statusName,
        normalizeStatusIssueRule(kind, checkId, statusName, issueRule),
      ]),
    );
    const ignoreStatusesRaw = raw.ignoreStatuses ?? raw.ignore_statuses;
    const metadataUpdatesRaw = raw.metadataUpdates ?? raw.metadata_updates;
    return {
      type: "json_record_status",
      recordsPath,
      matchField,
      matchValueTemplate: typeof raw.matchValueTemplate === "string"
        ? raw.matchValueTemplate
        : typeof raw.match_value_template === "string"
          ? raw.match_value_template
          : undefined,
      statusField,
      ignoreStatuses: Array.isArray(ignoreStatusesRaw)
        ? ignoreStatusesRaw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : undefined,
      keyTemplate: typeof raw.keyTemplate === "string"
        ? raw.keyTemplate
        : typeof raw.key_template === "string"
          ? raw.key_template
          : undefined,
      metadataUpdates: isRecord(metadataUpdatesRaw)
        ? Object.fromEntries(Object.entries(metadataUpdatesRaw).filter(([, value]) => typeof value === "string")) as Record<string, string>
        : undefined,
      issueStates,
    };
  }

  throw new Error(`entities.${kind}.issues.checks.${checkId}.parser has unsupported type "${raw.type}"`);
}

export function normalizeEntityKindsConfig(raw: unknown): Record<string, EntityKindConfig> {
  if (!isRecord(raw)) {
    throw new Error("entities must be an object");
  }
  const kinds: Record<string, EntityKindConfig> = {};

  for (const [kind, def] of Object.entries(raw)) {
    if (!isRecord(def)) {
      throw new Error(`entities.${kind} must be an object`);
    }
    const states = normalizeEntityStates(kind, def.states);
    const transitions = normalizeEntityTransitions(kind, states, def.transitions);
    kinds[kind] = {
      title: typeof def.title === "string" ? def.title : undefined,
      description: typeof def.description === "string" ? def.description : undefined,
      runtimeCreate: typeof def.runtimeCreate === "boolean"
        ? def.runtimeCreate
        : typeof def.runtime_create === "boolean"
          ? def.runtime_create
          : undefined,
      states,
      transitions,
      health: normalizeEntityHealth(kind, def.health),
      relationships: normalizeEntityRelationships(kind, def.relationships),
      metadataSchema: normalizeEntityMetadataSchema(kind, def.metadataSchema ?? def.metadata_schema),
      issues: normalizeEntityIssues(kind, def.issues),
      readiness: normalizeEntityReadiness(kind, states, def.readiness),
    };
  }

  return kinds;
}

export function resolveInitialEntityState(kind: EntityKindConfig): string {
  const explicit = Object.entries(kind.states).find(([, config]) => config.initial);
  if (explicit) return explicit[0];
  const first = Object.keys(kind.states)[0];
  if (!first) throw new Error("Entity kind must define at least one state");
  return first;
}

export function allowsEntityTransition(kind: EntityKindConfig, fromState: string, toState: string): boolean {
  if (fromState === toState) return true;
  return kind.transitions.some((transition) => transition.from === fromState && transition.to === toState);
}

export function getEntityTransitionRule(
  kind: EntityKindConfig,
  fromState: string,
  toState: string,
): EntityTransitionConfig | undefined {
  if (fromState === toState) return undefined;
  return kind.transitions.find((transition) => transition.from === fromState && transition.to === toState);
}

export function validateEntityHealth(kind: EntityKindConfig, health: string | undefined): string | null {
  if (health == null) return null;
  if (!kind.health) {
    return "Entity kind does not define health values";
  }
  return kind.health.values.includes(health) ? null : `Invalid health "${health}"`;
}

export function validateEntityMetadata(
  kind: EntityKindConfig,
  metadata: Record<string, unknown> | undefined,
): string[] {
  const errors: string[] = [];
  if (!kind.metadataSchema) return errors;

  const value = metadata ?? {};
  for (const [fieldName, fieldConfig] of Object.entries(kind.metadataSchema)) {
    const fieldValue = value[fieldName];
    if (fieldConfig.required && fieldValue === undefined) {
      errors.push(`metadata.${fieldName} is required`);
      continue;
    }
    if (fieldValue === undefined) continue;

    const actualType = Array.isArray(fieldValue) ? "array" : typeof fieldValue;
    if (actualType !== fieldConfig.type) {
      errors.push(`metadata.${fieldName} must be of type ${fieldConfig.type}`);
      continue;
    }
    if (fieldConfig.enum && typeof fieldValue === "string" && !fieldConfig.enum.includes(fieldValue)) {
      errors.push(`metadata.${fieldName} must be one of: ${fieldConfig.enum.join(", ")}`);
    }
  }

  return errors;
}

export function validateEntityParentKind(kind: EntityKindConfig, parentKind: string | undefined): string | null {
  if (!parentKind) return null;
  const parentRules = kind.relationships?.parent;
  if (parentRules?.enabled === false) {
    return "Entity kind does not allow parent relationships";
  }
  if (parentRules?.allowedKinds && parentRules.allowedKinds.length > 0 && !parentRules.allowedKinds.includes(parentKind)) {
    return `Parent kind "${parentKind}" is not allowed`;
  }
  return null;
}

export function validateEntityKindsInConfig(
  config: Pick<WorkforceConfig, "entities"> & { agents?: Record<string, unknown> },
): string[] {
  const errors: string[] = [];
  if (!config.entities) return errors;

  for (const [kindName, kind] of Object.entries(config.entities)) {
    const stateNames = Object.keys(kind.states ?? {});
    if (stateNames.length === 0) {
      errors.push(`entities.${kindName} must define at least one state`);
    }
    const initialCount = Object.values(kind.states ?? {}).filter((state) => state.initial).length;
    if (initialCount > 1) {
      errors.push(`entities.${kindName} may define at most one initial state`);
    }
    if (stateNames.length > 1 && (!kind.transitions || kind.transitions.length === 0)) {
      errors.push(`entities.${kindName} must define explicit transitions when more than one state exists`);
    }
    for (const [index, transition] of (kind.transitions ?? []).entries()) {
      if (!kind.states[transition.from]) {
        errors.push(`entities.${kindName}.transitions[${index}] references unknown from state "${transition.from}"`);
      }
      if (!kind.states[transition.to]) {
        errors.push(`entities.${kindName}.transitions[${index}] references unknown to state "${transition.to}"`);
      }
      for (const severity of transition.blockedBySeverities ?? []) {
        if (!ENTITY_ISSUE_SEVERITIES.includes(severity)) {
          errors.push(`entities.${kindName}.transitions[${index}].blockedBySeverities includes invalid severity "${severity}"`);
        }
      }
    }
    if (kind.health?.default && !kind.health.values.includes(kind.health.default)) {
      errors.push(`entities.${kindName}.health.default must be one of the declared health values`);
    }
    if (kind.health?.clear && !kind.health.values.includes(kind.health.clear)) {
      errors.push(`entities.${kindName}.health.clear must be one of the declared health values`);
    }
    for (const [fieldName, field] of Object.entries(kind.metadataSchema ?? {})) {
      if (field.enum && field.type !== "string") {
        errors.push(`entities.${kindName}.metadataSchema.${fieldName}.enum is only valid for string fields`);
      }
    }
    if (kind.readiness?.blockersField) {
      const blockersField = kind.metadataSchema?.[kind.readiness.blockersField];
      if (!blockersField) {
        errors.push(`entities.${kindName}.readiness.blockersField references unknown metadata field "${kind.readiness.blockersField}"`);
      } else if (blockersField.type !== "array") {
        errors.push(`entities.${kindName}.readiness.blockersField must reference an array metadata field`);
      }
    }
    for (const fieldName of kind.readiness?.requirements?.metadataTrue ?? []) {
      if (kind.metadataSchema && !kind.metadataSchema[fieldName]) {
        errors.push(`entities.${kindName}.readiness.requirements.metadataTrue references unknown metadata field "${fieldName}"`);
      }
    }
    for (const fieldName of Object.keys(kind.readiness?.requirements?.metadataEquals ?? {})) {
      if (kind.metadataSchema && !kind.metadataSchema[fieldName]) {
        errors.push(`entities.${kindName}.readiness.requirements.metadataEquals references unknown metadata field "${fieldName}"`);
      }
    }
    for (const fieldName of Object.keys(kind.readiness?.requirements?.metadataMin ?? {})) {
      const field = kind.metadataSchema?.[fieldName];
      if (kind.metadataSchema && !field) {
        errors.push(`entities.${kindName}.readiness.requirements.metadataMin references unknown metadata field "${fieldName}"`);
      } else if (field && field.type !== "number") {
        errors.push(`entities.${kindName}.readiness.requirements.metadataMin.${fieldName} must reference a number metadata field`);
      }
    }
    for (const state of kind.readiness?.whenStates ?? []) {
      if (!kind.states[state]) {
        errors.push(`entities.${kindName}.readiness.whenStates references unknown state "${state}"`);
      }
    }
    if (kind.readiness?.requestTransitionWhenReady) {
      const toState = kind.readiness.requestTransitionWhenReady.toState;
      if (!toState) {
        errors.push(`entities.${kindName}.readiness.requestTransitionWhenReady.toState is required`);
      } else if (!kind.states[toState]) {
        errors.push(`entities.${kindName}.readiness.requestTransitionWhenReady.toState references unknown state "${toState}"`);
      } else {
        for (const fromState of kind.readiness.whenStates ?? []) {
          if (!allowsEntityTransition(kind, fromState, toState)) {
            errors.push(`entities.${kindName}.readiness.requestTransitionWhenReady requires a valid transition ${fromState} -> ${toState}`);
          }
        }
      }
    }
    for (const [severity, health] of Object.entries(kind.issues?.defaultHealthBySeverity ?? {})) {
      if (kind.health && !kind.health.values.includes(health)) {
        errors.push(`entities.${kindName}.issues.defaultHealthBySeverity.${severity} references unknown health "${health}"`);
      }
    }
    for (const [issueType, issue] of Object.entries(kind.issues?.types ?? {})) {
      if (issue.defaultSeverity && !ENTITY_ISSUE_SEVERITIES.includes(issue.defaultSeverity)) {
        errors.push(`entities.${kindName}.issues.types.${issueType}.defaultSeverity must be one of: ${ENTITY_ISSUE_SEVERITIES.join(", ")}`);
      }
      if (issue.health && kind.health && !kind.health.values.includes(issue.health)) {
        errors.push(`entities.${kindName}.issues.types.${issueType}.health references unknown health "${issue.health}"`);
      }
      if (typeof issue.task === "object" && issue.task !== null) {
        if (issue.task.priority && !TASK_PRIORITIES.includes(issue.task.priority)) {
          errors.push(`entities.${kindName}.issues.types.${issueType}.task.priority must be one of: ${TASK_PRIORITIES.join(", ")}`);
        }
        if (issue.task.kind && !TASK_KINDS.includes(issue.task.kind)) {
          errors.push(`entities.${kindName}.issues.types.${issueType}.task.kind must be one of: ${TASK_KINDS.join(", ")}`);
        }
        for (const state of issue.task.rerunOnStates ?? []) {
          if (!TASK_STATES.includes(state)) {
            errors.push(`entities.${kindName}.issues.types.${issueType}.task.rerunOnStates includes invalid task state "${state}"`);
          }
        }
        for (const checkId of issue.task.rerunCheckIds ?? []) {
          if (!kind.issues?.checks?.[checkId]) {
            errors.push(`entities.${kindName}.issues.types.${issueType}.task.rerunCheckIds references unknown check "${checkId}"`);
          }
        }
      }
    }
    for (const [index, signal] of (kind.issues?.stateSignals ?? []).entries()) {
      if (!signal.issueType.startsWith("system:") && !kind.issues?.types?.[signal.issueType]) {
        errors.push(`entities.${kindName}.issues.stateSignals[${index}].issueType references unknown issue type "${signal.issueType}"`);
      }
      for (const state of signal.whenStates ?? []) {
        if (!kind.states[state]) {
          errors.push(`entities.${kindName}.issues.stateSignals[${index}].whenStates references unknown state "${state}"`);
        }
      }
      if (signal.ownerAgentId && !config.agents?.[signal.ownerAgentId]) {
        errors.push(`entities.${kindName}.issues.stateSignals[${index}].ownerAgentId references unknown agent "${signal.ownerAgentId}"`);
      }
    }
    for (const [checkId, check] of Object.entries(kind.issues?.checks ?? {})) {
      for (const issueType of check.issueTypes ?? []) {
        if (!kind.issues?.types?.[issueType]) {
          errors.push(`entities.${kindName}.issues.checks.${checkId}.issueTypes references unknown issue type "${issueType}"`);
        }
      }
      if (typeof check.parser === "object" && check.parser !== null) {
        if (check.parser.type === "json_record_issues") {
          const mappedIssueTypes = Object.values(check.parser.issueTypeMap ?? {});
          for (const issueType of mappedIssueTypes) {
            if (!issueType.startsWith("system:") && !kind.issues?.types?.[issueType]) {
              errors.push(`entities.${kindName}.issues.checks.${checkId}.parser.issueTypeMap references unknown issue type "${issueType}"`);
            }
          }
          if (check.parser.defaultIssueType && !check.parser.defaultIssueType.startsWith("system:") && !kind.issues?.types?.[check.parser.defaultIssueType]) {
            errors.push(`entities.${kindName}.issues.checks.${checkId}.parser.defaultIssueType references unknown issue type "${check.parser.defaultIssueType}"`);
          }
        }
        if (check.parser.type === "json_record_status") {
          for (const [statusName, rule] of Object.entries(check.parser.issueStates)) {
            if (!rule.issueType.startsWith("system:") && !kind.issues?.types?.[rule.issueType]) {
              errors.push(`entities.${kindName}.issues.checks.${checkId}.parser.issueStates.${statusName} references unknown issue type "${rule.issueType}"`);
            }
          }
        }
      }
    }
  }

  return errors;
}
