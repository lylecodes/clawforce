export type DashboardExtensionSurface =
  | "nav"
  | "monitor"
  | "workspace"
  | "overview"
  | "org"
  | "tasks"
  | "approvals"
  | "comms"
  | "config"
  | "experiments";

export type DashboardExtensionSource = {
  kind: "openclaw-plugin" | "standalone" | "unknown";
  pluginId?: string;
};

export type DashboardExtensionPage = {
  id: string;
  title: string;
  route: string;
  navLabel?: string;
  description?: string;
  surface?: DashboardExtensionSurface;
  order?: number;
  domainScoped?: boolean;
  hidden?: boolean;
};

export type DashboardExtensionPanel = {
  id: string;
  title: string;
  surface: Exclude<DashboardExtensionSurface, "nav">;
  description?: string;
  slot?: "main" | "sidebar" | "drawer";
  order?: number;
  route?: string;
  domainScoped?: boolean;
};

export type DashboardExtensionAction = {
  id: string;
  label: string;
  surface: DashboardExtensionSurface | "agent-detail" | "task-detail";
  description?: string;
  route?: string;
  actionId?: string;
  order?: number;
  domainScoped?: boolean;
};

export type DashboardExtensionConfigSection = {
  id: string;
  title: string;
  editor: "raw" | "structured" | "dual";
  description?: string;
  order?: number;
};

export type DashboardExtensionContribution = {
  id: string;
  title: string;
  version?: string;
  description?: string;
  source?: DashboardExtensionSource;
  requiredFeatures?: string[];
  requiredEndpoints?: string[];
  pages?: DashboardExtensionPage[];
  panels?: DashboardExtensionPanel[];
  actions?: DashboardExtensionAction[];
  configSections?: DashboardExtensionConfigSection[];
};

const extensionRegistry = new Map<string, DashboardExtensionContribution>();

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function validateRoute(route: string, field: string): void {
  if (!route.startsWith("/")) {
    throw new Error(`${field} must start with "/"`);
  }
}

function validateUniqueIds<T extends { id: string }>(
  items: T[] | undefined,
  field: string,
): void {
  if (!items) return;
  const ids = new Set<string>();
  for (const item of items) {
    assertNonEmptyString(item.id, `${field}.id`);
    if (ids.has(item.id)) {
      throw new Error(`${field} contains duplicate id "${item.id}"`);
    }
    ids.add(item.id);
  }
}

function validateContribution(extension: DashboardExtensionContribution): DashboardExtensionContribution {
  assertNonEmptyString(extension.id, "extension.id");
  assertNonEmptyString(extension.title, "extension.title");

  validateUniqueIds(extension.pages, "pages");
  validateUniqueIds(extension.panels, "panels");
  validateUniqueIds(extension.actions, "actions");
  validateUniqueIds(extension.configSections, "configSections");

  for (const page of extension.pages ?? []) {
    assertNonEmptyString(page.title, `pages.${page.id}.title`);
    assertNonEmptyString(page.route, `pages.${page.id}.route`);
    validateRoute(page.route, `pages.${page.id}.route`);
  }

  for (const panel of extension.panels ?? []) {
    assertNonEmptyString(panel.title, `panels.${panel.id}.title`);
    if (panel.route) validateRoute(panel.route, `panels.${panel.id}.route`);
  }

  for (const action of extension.actions ?? []) {
    assertNonEmptyString(action.label, `actions.${action.id}.label`);
    if (!action.route && !action.actionId) {
      throw new Error(`actions.${action.id} must define either route or actionId`);
    }
    if (action.route) validateRoute(action.route, `actions.${action.id}.route`);
  }

  for (const section of extension.configSections ?? []) {
    assertNonEmptyString(section.title, `configSections.${section.id}.title`);
  }

  return {
    ...extension,
    id: extension.id.trim(),
    title: extension.title.trim(),
    description: extension.description?.trim(),
    version: extension.version?.trim(),
    source: extension.source ?? { kind: "unknown" },
    requiredFeatures: extension.requiredFeatures ? [...extension.requiredFeatures] : [],
    requiredEndpoints: extension.requiredEndpoints ? [...extension.requiredEndpoints] : [],
    pages: extension.pages ? [...extension.pages] : [],
    panels: extension.panels ? [...extension.panels] : [],
    actions: extension.actions ? [...extension.actions] : [],
    configSections: extension.configSections ? [...extension.configSections] : [],
  };
}

export function registerDashboardExtension(
  extension: DashboardExtensionContribution,
): () => boolean {
  const normalized = validateContribution(extension);
  extensionRegistry.set(normalized.id, normalized);
  return () => extensionRegistry.delete(normalized.id);
}

export function unregisterDashboardExtension(id: string): boolean {
  return extensionRegistry.delete(id);
}

export function listDashboardExtensions(): DashboardExtensionContribution[] {
  return [...extensionRegistry.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export function getDashboardExtension(id: string): DashboardExtensionContribution | null {
  return extensionRegistry.get(id) ?? null;
}

export function clearDashboardExtensions(): void {
  extensionRegistry.clear();
}
