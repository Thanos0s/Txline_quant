import { apiClient } from '../api-client';

export type ScoreUpdate = {
  FixtureId: number;
  Ts: number;
  Seq: number;
  [key: string]: unknown;
};

export async function fetchScoresSnapshot(fixtureId: number, asOf?: number): Promise<ScoreUpdate[]> {
  const url = asOf
    ? `/scores/snapshot/${fixtureId}?asOf=${asOf}`
    : `/scores/snapshot/${fixtureId}`;
  const res = await apiClient.get<ScoreUpdate[]>(url);
  return res.data;
}

export async function fetchScoresLive(fixtureId: number): Promise<ScoreUpdate[]> {
  const res = await apiClient.get<ScoreUpdate[]>(`/scores/updates/${fixtureId}`);
  return res.data;
}

export async function fetchScoresHistorical(fixtureId: number): Promise<ScoreUpdate[]> {
  const res = await apiClient.get<ScoreUpdate[]>(`/scores/historical/${fixtureId}`);
  return res.data;
}

export async function fetchScoresInterval(epochDay: number, hourOfDay: number, interval: number, fixtureId?: number): Promise<ScoreUpdate[]> {
  let url = `/scores/updates/${epochDay}/${hourOfDay}/${interval}`;
  if (fixtureId != null) url += `?fixtureId=${fixtureId}`;
  const res = await apiClient.get<ScoreUpdate[]>(url);
  return res.data;
}
