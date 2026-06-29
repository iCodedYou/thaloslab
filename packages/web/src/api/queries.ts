import { useQuery } from '@tanstack/react-query';
import type { DetectedProvider, Project } from '@thaloslab/shared';
import { apiGet } from './client';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => apiGet<Project[]>('/api/projects'),
  });
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => apiGet<DetectedProvider[]>('/api/providers'),
  });
}
