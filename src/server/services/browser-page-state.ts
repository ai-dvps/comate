import type { ElementProvenance, InteractionClass, PageModel, RefKind, SemanticRelationship } from './browser-page-model.js';

export interface PageStateElement {
  ref: string;
  kind: RefKind;
  role: string;
  name: string;
  parentRef?: string;
  context?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  visible?: boolean;
  inViewport?: boolean;
  occluded?: boolean;
  sensitive?: boolean;
  submitSemantics?: boolean;
  value?: string;
  states?: Record<string, boolean | string>;
  provenance?: ElementProvenance;
  interactionClass?: InteractionClass;
  multiple?: boolean;
  accept?: string;
  filled?: boolean;
  contentLength?: number;
  relationships?: SemanticRelationship[];
}

export interface PageState {
  url: string;
  title: string;
  pageType: PageModel['pageType'];
  pageRevision: string;
  outline: PageModel['outline'];
  elements: PageStateElement[];
  totalElements: number;
  offset: number;
  truncated: boolean;
  nextOffset?: number;
  actionInventory: PageModel['actionInventory'];
  outlineInventory: PageModel['outlineInventory'];
  sourceInventory: PageModel['sourceInventory'];
  content?: PageModel['content'];
  alerts: string[];
}

/** Build the text-only, token-bounded page observation exposed by getPageState. */
export function buildPageState(
  model: PageModel,
  options: { offset?: number; limit?: number; includeContent?: boolean } = {},
): PageState {
  const totalElements = model.forms.reduce((total, form) => total + 1 + form.fields.length, 0) + model.actions.length;
  const offset = Math.min(Math.max(Math.floor(options.offset ?? 0), 0), totalElements);
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 60), 1), 100);
  const end = Math.min(offset + limit, totalElements);
  const elements: PageStateElement[] = [];
  let elementIndex = 0;
  const addElement = (element: PageStateElement): void => {
    if (elementIndex >= offset && elementIndex < end) elements.push(element);
    elementIndex += 1;
  };
  for (const form of model.forms) {
    const formName = form.name ?? (form.formIndex === -1 ? 'page controls' : `form ${form.formIndex}`);
    addElement({ ref: form.ref, kind: 'form', role: 'form', name: formName, interactionClass: form.interactionClass });
    for (const field of form.fields) {
      addElement({
        ref: field.ref,
        kind: 'field',
        role: field.role,
        name: field.label || field.name || field.type,
        parentRef: form.ref,
        context: formName,
        required: field.required,
        disabled: field.disabled,
        readOnly: field.readOnly,
        ...(field.visible !== undefined ? { visible: field.visible } : {}),
        ...(field.inViewport !== undefined ? { inViewport: field.inViewport } : {}),
        sensitive: field.sensitive,
        submitSemantics: field.submitSemantics,
        interactionClass: field.interactionClass,
        ...(field.multiple !== undefined ? { multiple: field.multiple } : {}),
        ...(field.accept !== undefined ? { accept: field.accept } : {}),
        ...(field.filled !== undefined ? { filled: field.filled } : {}),
        ...(field.contentLength !== undefined ? { contentLength: field.contentLength } : {}),
        ...(field.value !== undefined ? { value: field.value } : {}),
        ...(field.relationships ? { relationships: field.relationships } : {}),
      });
    }
  }
  for (const action of model.actions) {
    addElement({
      ref: action.ref,
      kind: 'action',
      role: action.role,
      name: action.name,
      provenance: action.provenance,
      interactionClass: action.interactionClass,
      ...(action.context ? { context: action.context } : {}),
      ...(action.states ? { states: action.states } : {}),
      ...(action.relationships ? { relationships: action.relationships } : {}),
    });
  }

  return {
    url: model.url,
    title: model.title,
    pageType: model.pageType,
    pageRevision: model.pageRevision,
    outline: model.outline,
    elements,
    totalElements,
    offset,
    truncated:
      end < totalElements ||
      model.actionInventory.truncated ||
      model.outlineInventory.truncated ||
      model.sourceInventory.forms.truncated ||
      model.sourceInventory.fields.truncated,
    ...(end < totalElements ? { nextOffset: end } : {}),
    actionInventory: model.actionInventory,
    outlineInventory: model.outlineInventory,
    sourceInventory: model.sourceInventory,
    ...(options.includeContent === false ? {} : { content: model.content }),
    alerts: model.alerts,
  };
}
