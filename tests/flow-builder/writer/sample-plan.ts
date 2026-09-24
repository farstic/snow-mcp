/**
 * A hand-built RecordPlan in the shape the GENERATOR will produce (rows, deterministic ids,
 * gzip+base64 blobs, label_cache JSON) — enough structure to exercise the writer, the verifier
 * and the unload emitter without depending on generatePlan().
 */
import { encodeValues } from '../../../src/flow-builder/encode.js';
import { sysIdFor, sysIdToUuid, ELEMENT_KEYS } from '../../../src/flow-builder/ids.js';
import type { RecordPlan } from '../../../src/flow-builder/spec/types.js';

export const EMPTY_LOGIC_VALUES = { outputsToAssign: [], inputs: [], variables: [], decisionTableInputs: [], dynamicInputs: [], workflowInputs: [] };

export function samplePlan(overrides: { flowKey?: string; scope?: string; name?: string } = {}): RecordPlan {
  const flowKey = overrides.flowKey ?? 'p1_log';
  const scope = overrides.scope ?? 'global';
  const name = overrides.name ?? 'P1 Log';
  const flowId = sysIdFor(flowKey, ELEMENT_KEYS.flow);
  const trigId = sysIdFor(flowKey, ELEMENT_KEYS.trigger);
  const varId = sysIdFor(flowKey, ELEMENT_KEYS.variable('note'));
  const docId = sysIdFor(flowKey, ELEMENT_KEYS.variableDoc('note'));
  const stageId = sysIdFor(flowKey, ELEMENT_KEYS.stage('triage'));
  const ifId = sysIdFor(flowKey, ELEMENT_KEYS.step('is_p1'));
  const logId = sysIdFor(flowKey, ELEMENT_KEYS.step('log'));
  const ifUuid = sysIdToUuid(ifId);
  const logUuid = sysIdToUuid(logId);

  const labelCache = [
    { name: 'Created_1.current.priority', label: 'Trigger - Record Created➛Incident Record➛Priority', type: 'integer', base_type: 'integer', usedInstances: { [ifUuid]: ['condition'] }, attributes: {} },
    { name: 'Created_1.current.number', label: 'Trigger - Record Created➛Incident Record➛Number', type: 'string', base_type: 'string', usedInstances: { [logUuid]: ['log_message'] }, attributes: {} },
    { name: 'flow_variable.note', label: 'Flow Variables➛Note', type: 'string', base_type: 'string', reference_table: null, reference_display: null, usedInstances: {}, attributes: {} },
  ];

  const triggerInputs = [
    { label: 'Table', internalType: 'table_name', mandatory: true, fromTemplate: false, order: 100, valueSysId: '', name: 'table', value: 'incident', displayValue: 'Incident', children: [], parameter: { id: 'cfca92e0c31322002841b63b12d3ae00', name: 'table', type: 'table_name' }, scriptActive: false },
    { label: 'Condition', internalType: 'conditions', mandatory: false, fromTemplate: false, order: 200, valueSysId: '', name: 'condition', value: 'priority=1', displayValue: '', children: [], parameter: { id: '66aadea0c31322002841b63b12d3aebf', name: 'condition', type: 'conditions' }, scriptActive: false },
  ];

  return {
    flowKey,
    flow: {
      table: 'sys_hub_flow', sys_id: flowId,
      fields: {
        name, internal_name: 'p1_log', description: 'P1 incidents are logged', type: 'flow', status: 'draft', active: false, access: 'public',
        run_as: 'user', run_with_roles: '', allow_high_security_roles: false, show_draft_actions: false, sys_scope: scope, version: '2',
        generation_source: 'snow_mcp_flow_builder', label_cache: JSON.stringify(labelCache), annotation: '', category: '', flow_priority: '', sys_policy: '',
      },
    },
    trigger: {
      table: 'sys_hub_trigger_instance_v2', sys_id: trigId,
      fields: { flow: flowId, name: 'Created', trigger_type: 'record_create', trigger_definition: '798916a0c31322002841b63b12d3ae7c', trigger_inputs: encodeValues(triggerInputs), trigger_outputs: '', sys_scope: '' },
    },
    variables: [{
      table: 'sys_hub_flow_variable', sys_id: varId,
      fields: { model: flowId, model_id: flowId, model_table: 'sys_hub_flow', name: `var__m_sys_hub_flow_variable_${flowId}`, element: 'note', label: 'Note', internal_type: 'string', max_length: 8000, order: 100, mandatory: false, default_value: '', virtual_type: 'script', sys_scope: scope },
    }],
    documentation: [{
      table: 'sys_documentation', sys_id: docId,
      fields: { name: `var__m_sys_hub_flow_variable_${flowId}`, element: 'note', label: 'Note', language: 'en', sys_scope: scope },
    }],
    stages: [{
      table: 'sys_hub_flow_stage', sys_id: stageId,
      fields: { flow: flowId, order: 1, value: 'triage', label: 'Triage', type: 'standard', component_indexes: '0', stage_id: sysIdToUuid(stageId), always_show: true, duration: '1970-01-01 00:00:00', states: '{"pending":"Pending - has not started","inprogress":"In progress","skipped":"Skipped","complete":"Completed","error":"Error"}', ancestor_array_position: -1, sys_scope: '' },
    }],
    instances: [
      {
        table: 'sys_hub_flow_logic_instance_v2', sys_id: ifId,
        fields: { flow: flowId, order: 1, ui_id: ifUuid, logic_definition: 'af4e1945c3e232002841b63b12d3ae3e', sys_class_name: 'sys_hub_flow_logic_instance_v2', sys_scope: scope,
          values: encodeValues({ ...EMPTY_LOGIC_VALUES, inputs: [{ id: '', name: 'condition_name', value: 'Is P1', displayValue: 'Is P1', children: [], parameter: {}, scriptActive: false }, { id: '', name: 'condition', value: '{{Created_1.current.priority}}=1', displayValue: '', children: [], parameter: {}, scriptActive: false }] }) },
      },
      {
        table: 'sys_hub_action_instance_v2', sys_id: logId,
        fields: { flow: flowId, order: 2, parent_ui_id: ifUuid, ui_id: logUuid, action_type: '5bc1bcc6531003003bf1d9109ec587d4', action_type_parent: 'dbc1bcc6531003003bf1d9109ec587d2', compiled_snapshot: '', sys_class_name: 'sys_hub_action_instance_v2', sys_scope: scope,
          values: encodeValues([
            { id: '5bc1bcc6531003003bf1d9109ec587d7', name: 'log_level', value: 'info', displayValue: 'Info', children: [], parameter: { type: 'choice' }, scriptActive: false },
            { id: '23c1bcc6531003003bf1d9109ec587e5', name: 'log_message', value: 'P1 {{Created_1.current.number}}', displayValue: 'P1 {{Created_1.current.number}}', children: [], parameter: { type: 'string' }, scriptActive: false },
          ]) },
      },
    ],
    labelCache,
    pills: [
      { symbolic: 'trigger.current.priority', platform: '{{Created_1.current.priority}}', type: 'integer' },
      { symbolic: 'trigger.current.number', platform: '{{Created_1.current.number}}', type: 'string' },
    ],
    warnings: [],
  };
}

export const SAMPLE_IDS = (flowKey = 'p1_log') => ({
  flow: sysIdFor(flowKey, ELEMENT_KEYS.flow),
  trigger: sysIdFor(flowKey, ELEMENT_KEYS.trigger),
  variable: sysIdFor(flowKey, ELEMENT_KEYS.variable('note')),
  doc: sysIdFor(flowKey, ELEMENT_KEYS.variableDoc('note')),
  stage: sysIdFor(flowKey, ELEMENT_KEYS.stage('triage')),
  ifStep: sysIdFor(flowKey, ELEMENT_KEYS.step('is_p1')),
  logStep: sysIdFor(flowKey, ELEMENT_KEYS.step('log')),
});
