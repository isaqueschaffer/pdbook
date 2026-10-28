import { useQuery } from "@tanstack/react-query";

import { api } from "./api";

export function usePublicConfig() {
  return useQuery({ queryKey: ["config"], queryFn: api.config, staleTime: Infinity });
}
