import { apiClient } from '../api-client';

export type OddsUpdate = {
  MessageId: string;
  FixtureId: number;
  Ts: number;
  MarketId: number;
  [key: string]: unknown;
};

export async function fetchOddsSnapshot(fixtureId: number, asOf?: number): Promise<OddsUpdate[]> {
  const url = asOf
    ? `/odds/snapshot/${fixtureId}?asOf=${asOf}`
    : `/odds/snapshot/${fixtureId}`;
  const res = await apiClient.get<OddsUpdate[]>(url);
  return res.data;
}

export async function fetchOddsLive(fixtureId: number): Promise<OddsUpdate[]> {
  const res = await apiClient.get<OddsUpdate[]>(`/odds/updates/${fixtureId}`);
  return res.data;
}

export async function fetchOddsInterval(epochDay: number, hourOfDay: number, interval: number): Promise<OddsUpdate[]> {
  const res = await apiClient.get<OddsUpdate[]>(`/odds/updates/${epochDay}/${hourOfDay}/${interval}`);
  return res.data;
}
