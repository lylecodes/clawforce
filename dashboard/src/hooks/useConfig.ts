import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../store";
import { api } from "../api/client";
import type {
  DomainConfig,
  ConfigSection,
  ConfigChangePreview,
  ConfigValidationResult,
} from "../api/types";

const EMPTY_CONFIG: DomainConfig = {
  agents: [],
  budget: {},
  tool_gates: [],
  initiatives: {},
  jobs: [],
  safety: {},
  profile: {},
  rules: [],
  event_handlers: [],
  memory: {},
};

export function useConfig() {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const queryClient = useQueryClient();
  const [dirtyKeys, setDirtyKeys] = useState<Set<ConfigSection>>(new Set());
  const [preview, setPreview] = useState<ConfigChangePreview | null>(null);
  const [validation, setValidation] = useState<ConfigValidationResult | null>(null);
  const [saveResult, setSaveResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const { data: config, isLoading } = useQuery({
    queryKey: ["config", activeDomain],
    queryFn: () => api.getConfig(activeDomain!),
    enabled: !!activeDomain,
    staleTime: 30_000,
  });

  const saveMutation = useMutation({
    mutationFn: ({ section, data }: { section: ConfigSection; data: unknown }) =>
      api.saveConfig(activeDomain!, section, data),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["config", activeDomain] });
      setDirtyKeys((prev) => {
        const next = new Set(prev);
        next.delete(vars.section);
        return next;
      });
      setPreview(null);
      setValidation(null);
      setSaveResult({ type: "success", message: `${vars.section} configuration saved successfully.` });
      setTimeout(() => setSaveResult(null), 4000);
    },
    onError: (err, vars) => {
      const message = err instanceof Error ? err.message : String(err);
      setSaveResult({ type: "error", message: `Failed to save ${vars.section}: ${message}` });
      setTimeout(() => setSaveResult(null), 6000);
    },
  });

  const validateMutation = useMutation({
    mutationFn: ({ section, data }: { section: ConfigSection; data: unknown }) =>
      api.validateConfig(activeDomain!, section, data),
    onSuccess: (result) => {
      setValidation(result);
    },
  });

  const previewMutation = useMutation({
    mutationFn: ({ current, proposed }: { current: unknown; proposed: unknown }) =>
      api.previewConfig(activeDomain!, current, proposed),
    onSuccess: (result) => {
      setPreview(result);
    },
  });

  const markDirty = useCallback((section: ConfigSection) => {
    setDirtyKeys((prev) => new Set([...prev, section]));
  }, []);

  const save = useCallback(
    (section: ConfigSection, data: unknown) => {
      saveMutation.mutate({ section, data });
    },
    [saveMutation],
  );

  const validate = useCallback(
    (section: ConfigSection, data: unknown) => {
      validateMutation.mutate({ section, data });
    },
    [validateMutation],
  );

  const requestPreview = useCallback(
    (current: unknown, proposed: unknown) => {
      previewMutation.mutate({ current, proposed });
    },
    [previewMutation],
  );

  return {
    config: config ?? EMPTY_CONFIG,
    isLoading,
    dirtyKeys,
    markDirty,
    save,
    isSaving: saveMutation.isPending,
    saveResult,
    clearSaveResult: () => setSaveResult(null),
    validate,
    isValidating: validateMutation.isPending,
    validation,
    requestPreview,
    isPreviewLoading: previewMutation.isPending,
    preview,
  };
}
