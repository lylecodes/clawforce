export type DispatchCronJobRef = {
  projectId: string | null;
  queueItemId: string;
  legacy: boolean;
};

const PREFIX = "dispatch:";

export function formatDispatchCronJobName(projectId: string, queueItemId: string): string {
  return `${PREFIX}${encodeURIComponent(projectId)}:${queueItemId}`;
}

export function parseDispatchCronJobName(name: string): DispatchCronJobRef | null {
  if (!name.startsWith(PREFIX)) return null;
  const raw = name.slice(PREFIX.length);
  if (!raw) return null;

  const separator = raw.indexOf(":");
  if (separator === -1) {
    return { projectId: null, queueItemId: raw, legacy: true };
  }

  const encodedProjectId = raw.slice(0, separator);
  const queueItemId = raw.slice(separator + 1);
  if (!encodedProjectId || !queueItemId) return null;

  return {
    projectId: decodeURIComponent(encodedProjectId),
    queueItemId,
    legacy: false,
  };
}
