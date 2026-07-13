import { apiClient } from '../api-client';

export type Fixture = {
  FixtureId: number;
  FixtureGroupId: number;
  CompetitionId: number;
  Competition: string;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  Participant1IsHome: boolean;
  StartTime: number;   // ms epoch
  Ts: number;          // last updated ms epoch
  [key: string]: unknown;
};

export async function fetchFixturesSnapshot(params?: {
  competitionId?: number;
  startEpochDay?: number;
}): Promise<Fixture[]> {
  const query = new URLSearchParams();
  if (params?.competitionId != null) query.set('competitionId', String(params.competitionId));
  if (params?.startEpochDay != null) query.set('startEpochDay', String(params.startEpochDay));
  const url = `/fixtures/snapshot${query.toString() ? '?' + query : ''}`;
  const res = await apiClient.get<Fixture[]>(url);
  return res.data;
}

export async function fetchFixtureUpdates(epochDay: number, hourOfDay: number): Promise<unknown[]> {
  const res = await apiClient.get<unknown[]>(`/fixtures/updates/${epochDay}/${hourOfDay}`);
  return res.data;
}
