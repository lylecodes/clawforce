import { useAppStore } from "../store";

/**
 * Hook to read and set the active domain.
 */
export function useDomain() {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const setActiveDomain = useAppStore((s) => s.setActiveDomain);
  const domains = useAppStore((s) => s.domains);

  return { activeDomain, setActiveDomain, domains };
}
