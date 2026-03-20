export interface EnsembleForecast {
  date: string;
  members: number[];
  modelTimestamp: Date;
  models: string[];
  memberCount: number;
}

export interface EnsembleApiResponse {
  daily: {
    time: string[];
    [key: string]: number[] | string[];
  };
}
