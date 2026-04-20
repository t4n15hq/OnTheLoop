// CTA Train Tracker API Response Types
export interface CTATrainArrival {
  staId: string;
  stpId: string;
  staNm: string;
  stpDe: string;
  rn: string;
  rt: string;
  destSt: string;
  destNm: string;
  trDr: string;
  prdt: string;
  arrT: string;
  isApp: string;
  isSch: string;
  isDly: string;
  isFlt: string;
  flags: string | null;
  lat: string;
  lon: string;
  heading: string;
}

export interface CTATrainResponse {
  ctatt: {
    tmst: string;
    errCd: string;
    errNm: string | null;
    eta?: CTATrainArrival[];
  };
}

// CTA Bus Tracker API Response Types
export interface CTABusPrediction {
  tmstmp: string;       // "YYYYMMDD HH:MM"
  typ: string;
  stpnm: string;
  stpid: string;
  vid: string;
  dstp: number;
  rt: string;
  rtdd: string;
  rtdir: string;        // e.g. "Eastbound"
  des: string;
  prdtm: string;        // "YYYYMMDD HH:MM"
  tablockid: string;
  tatripid: string;
  dly: boolean;
  prdctdn: string;      // integer minutes OR "DUE"
  zone: string;
}

export interface CTABusResponse {
  'bustime-response': {
    prd?: CTABusPrediction[];
    error?: Array<{ msg: string; stpid?: string; rt?: string }>;
  };
}

/**
 * Normalized arrival used across the app.
 *
 * - `minutesAway`: integer ≥ 0. "DUE" / approaching both map to 0.
 * - `confidence: 'live'` — real-time GPS tracking. `'scheduled'` — gap-filling
 *   from the timetable ("ghost train" risk).
 * - `isStale` — served from cache after an upstream failure. UI should tell users.
 */
export interface FormattedArrival {
  routeName: string;
  destination: string;
  arrivalTime: Date;
  minutesAway: number;
  isApproaching: boolean;
  isDelayed: boolean;
  isScheduled?: boolean;
  isDue?: boolean;
  isStale?: boolean;
  confidence?: 'live' | 'scheduled';
}
